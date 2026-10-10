"""SDXL-Lightning image generation (BUILD.md §10, §0.5).

One lazily loaded pipeline: SDXL base fp16 text encoders + ByteDance SDXL-Lightning 4-step UNet +
madebyollin/sdxl-vae-fp16-fix, Euler with trailing timesteps, 4 steps, guidance 0. Registered in the
resident-model registry (`backend.runtime.register`) while loaded; `unload()` deletes it and empties the cache.

World backdrops: seamless along x. Every Conv2d of the UNet and the VAE decoder is patched to pad circularly
along x (zero along y) for the duration of a world generation, so the 2:1 image wraps around a sphere with
no seam. The poles are then calmed (rows near the top/bottom blend into their own circular row average), so
the sphere mapping shows no pinch. Entities: 1024² on a flat black background, no patch.

Negative prompts: with guidance 0 (SDXL-Lightning's native setting) diffusers ignores the negative prompt,
so the first attempt also carries "no text, no letters" in the positive prompt and records the negative
prompt in the manifest; regeneration attempts (after a safety-filter rejection) use the stronger negative
prompt with guidance 1.5 so it actually acts (NOTES.md, assets decisions).
"""
from __future__ import annotations

import os
import re
import threading
import time
import types

import numpy as np
from PIL import Image

from backend import runtime

REGISTRY_NAME = "sdxl_lightning"
NEGATIVE = "text, letters, words, watermark, signature, logo, gore, blood, injury, wound, nudity, nsfw"
NEGATIVE_STRONG = (NEGATIVE + ", naked, nude, sexual, suggestive, cleavage, corpse, death, violence, horror, "
                   "body horror, scary, red liquid, flesh, real person, photo of a person, religious icon")
POSITIVE_SAFE = "wholesome, abstract, made of light, fully robed, no text, no letters"
ENTITY_SUFFIX = "on a plain flat black background, centered, full figure"
ENTITY_TAIL = "glowing, self-luminous, alone, full body, centered, " + ENTITY_SUFFIX + ", empty black space around it"
TYPE_TAILS = {  # §4.3: feminine figures are robed / made of light; deities abstract
    "luminous_feminine": "loose layered modest robes, body hidden in flowing light",
    "deity": "abstract, no religious iconography",
    "mythological": "gentle, wholesome, fully robed in light",
}
WORLD_SUFFIX = "seamless 360 degree panorama, empty uninhabited dreamlike space, no people"
WORLD_STYLE = "self-luminous, jewelled, intricate, hyper-saturated"
WORLD_GUIDANCE = 1.5  # worlds always use a little CFG so the negative prompt (people, crowds, signs, text) acts
NEGATIVE_WORLD_EXTRA = ", people, person, crowd, human figures, signs, banners with writing"
_BG_STRIP = re.compile(r",?\s*(isolated )?on a plain (flat )?(dark|black) background(, no text, no letters)?", re.I)

BASE_PATTERNS = [  # the fp16 pieces fetched at setup (scripts/fetch_models.py); no base UNet weights
    "model_index.json", "scheduler/*.json", "tokenizer/*", "tokenizer_2/*",
    "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
    "text_encoder_2/config.json", "text_encoder_2/model.fp16.safetensors",
    "unet/config.json", "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors",
]
_lock = threading.RLock()


def _snap(repo: str, **kw) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(repo, local_files_only=True, **kw)


# ------------------------------------------------------------------------------------------ circular padding

def _xcirc_forward(self, x):
    import torch.nn.functional as F

    ph, pw = self._hs_pad
    if pw:
        x = F.pad(x, (pw, pw, 0, 0), mode="circular")
    if ph:
        x = F.pad(x, (0, 0, ph, ph), mode="constant", value=0.0)
    return F.conv2d(x, self.weight, self.bias, self.stride, 0, self.dilation, self.groups)


class circular_x:
    """Context manager: Conv2d layers of the given modules pad circularly along x (width) only."""

    def __init__(self, *modules):
        self.modules = [m for m in modules if m is not None]
        self.patched = []

    def __enter__(self):
        import torch.nn as nn

        for root in self.modules:
            for m in root.modules():
                if isinstance(m, nn.Conv2d) and isinstance(m.padding, tuple) and any(m.padding) \
                        and m.padding_mode == "zeros":
                    m._hs_pad = (int(m.padding[0]), int(m.padding[1]))
                    m.forward = types.MethodType(_xcirc_forward, m)
                    self.patched.append(m)
        return self

    def __exit__(self, *exc):
        for m in self.patched:
            del m.forward  # back to the class method
            del m._hs_pad
        self.patched = []
        return False


def calm_poles(img: Image.Image, band: float = 0.10) -> Image.Image:
    """Blend the top and bottom `band` of an equirect image into its per-row circular mean (smoothstep),
    so the sphere's poles carry no detail to pinch. Seam-neutral (row means are constant along x)."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape
    import cv2

    # circular horizontal blur (wide) then exact row mean at the extreme pole
    pad = w // 8
    ext = np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1)
    blur = cv2.GaussianBlur(ext, (0, 0), sigmaX=w / 24, sigmaY=2)[:, pad:pad + w]
    mean = a.mean(axis=1, keepdims=True).repeat(w, axis=1)
    y = (np.arange(h, dtype=np.float32) + 0.5) / h
    d = np.minimum(y, 1 - y) / band  # 0 at the pole, 1 at the band edge
    t = np.clip(d, 0, 1)
    k_mean = (1 - np.clip(d * 2, 0, 1)) ** 2          # pure mean at the very pole
    k_blur = 1 - t * t * (3 - 2 * t)                 # smoothstep falloff to the original
    k_blur = k_blur[:, None, None]
    k_mean = k_mean[:, None, None]
    out = a * (1 - k_blur) + blur * k_blur
    out = out * (1 - k_mean) + mean * k_mean
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def soft_highlights(img: Image.Image, knee: float = 0.72, ceiling: float = 0.9) -> Image.Image:
    """Compress channel values above `knee` smoothly toward `ceiling` (hue kept): no near-white skies (§4.1)."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    m = a.max(-1, keepdims=True)
    span = ceiling - knee
    k = np.where(m > knee, (knee + span * np.tanh((m - knee) / span)) / np.maximum(m, 1e-6), 1.0)
    return Image.fromarray((np.clip(a * k, 0, 1) * 255 + 0.5).astype(np.uint8))


def wrap_resize(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Lanczos resize that respects horizontal wrap-around (pads with the opposite edge, then crops)."""
    w, h = img.size
    W, H = size
    if (w, h) == (W, H):
        return img
    pad = max(8, w // 32)
    a = np.asarray(img.convert("RGB"))
    ext = Image.fromarray(np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1))
    padW = round(pad * W / w)
    big = ext.resize((W + 2 * padW, H), Image.LANCZOS)
    return big.crop((padW, 0, padW + W, H))


def background_check(img: Image.Image, border: float = 0.04) -> dict:
    """Entities must sit on a flat dark background (for the cut-out). The border ring's median luminance must be
    low and at most 30% of the ring may be foreground by the background key (a full-frame pattern or a scene fails).
    A failing image is regenerated like a filter rejection (reason 'background')."""
    from backend.assets.cutout import key_mask

    a = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
    h, w = a.shape
    b = max(4, int(min(h, w) * border))
    ring = np.concatenate([a[:b].ravel(), a[-b:].ravel(), a[:, :b].ravel(), a[:, -b:].ravel()])
    m = key_mask(img)
    mring = np.concatenate([m[:b].ravel(), m[-b:].ravel(), m[:, :b].ravel(), m[:, -b:].ravel()])
    med, fg = float(np.median(ring)), float((mring > 0.5).mean())
    return {"ok": med < 0.2 and fg <= 0.3, "median": round(med, 3), "border_foreground": round(fg, 3)}


def seam_score(img: Image.Image) -> dict:
    """Mean abs difference across the wrap seam (last col vs first col) relative to the typical neighbouring-
    column difference inside the image. ratio ≈ 1 means the seam is as smooth as any other column boundary."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    seam = float(np.abs(a[:, -1] - a[:, 0]).mean())
    inner = float(np.abs(np.diff(a, axis=1)).mean())
    return {"seam": round(seam, 3), "inner": round(inner, 3), "ratio": round(seam / max(inner, 1e-6), 3)}


# ------------------------------------------------------------------------------------------ the generator

class ImageGenerator:
    """Lazily loaded SDXL-Lightning pipeline. Thread-safe enough for one generation thread."""

    backend = "sdxl_lightning"

    def __init__(self, device: str = "cuda"):
        self.device = device
        self.pipe = None
        self.load_seconds = None

    # -- lifecycle
    def load(self):
        with _lock:
            if self.pipe is not None:
                return self.pipe
            if runtime.no_images():
                raise RuntimeError("HYPERSPACE_NO_IMAGES=1: image model must not load")
            runtime.set_offline_env()
            t0 = time.time()
            import torch
            from diffusers import AutoencoderKL, EulerDiscreteScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
            from safetensors.torch import load_file

            from backend.models_registry import HF_IDS

            base = _snap(HF_IDS["sdxl_base"], allow_patterns=BASE_PATTERNS)
            vae_dir = _snap(HF_IDS["sdxl_vae"], allow_patterns=["config.json", "diffusion_pytorch_model.safetensors"])
            lf = _snap(HF_IDS["sdxl_lightning_repo"], allow_patterns=[HF_IDS["sdxl_lightning_unet"]])
            runtime.register(REGISTRY_NAME, "image", device=self.device)
            try:
                cfg = UNet2DConditionModel.load_config(base, subfolder="unet")
                with torch.device("meta"):
                    unet = UNet2DConditionModel.from_config(cfg)
                unet.load_state_dict(load_file(os.path.join(lf, HF_IDS["sdxl_lightning_unet"]), device="cpu"),
                                     assign=True)
                unet = unet.to(torch.float16)
                vae = AutoencoderKL.from_pretrained(vae_dir, torch_dtype=torch.float16)
                pipe = StableDiffusionXLPipeline.from_pretrained(base, unet=unet, vae=vae, torch_dtype=torch.float16,
                                                                 variant="fp16")
                pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
                pipe.set_progress_bar_config(disable=True)
                self.pipe = pipe.to(self.device)
            except Exception:
                runtime.unregister(REGISTRY_NAME)
                raise
            self.load_seconds = round(time.time() - t0, 1)
            return self.pipe

    def unload(self):
        with _lock:
            if self.pipe is not None:
                self.pipe = None  # drop every reference; free_gpu() collects and empties the cache
            from backend.assets.vram import free_gpu

            free_gpu()
            runtime.unregister(REGISTRY_NAME)

    # -- prompts
    def _fit(self, text: str, limit: int = 75) -> str:
        tok = getattr(self.pipe, "tokenizer", None)
        if tok is None:
            return text
        words = text.split(" ")
        while len(words) > 4 and len(tok(" ".join(words)).input_ids) - 2 > limit:
            words.pop()
        return " ".join(words).rstrip(",")

    def entity_prompt(self, prompt: str, strong: bool = False, etype: str | None = None, colours: str | None = None) -> str:
        """Subject first (truncated to fit CLIP's 77 tokens), then the type tail, the palette words and the fixed
        background tail."""
        subject = _BG_STRIP.sub("", prompt).strip().rstrip(",. ")
        tail = ", ".join(x for x in (TYPE_TAILS.get(etype or ""), POSITIVE_SAFE if strong else None,
                                     f"{colours} colours" if colours else None, ENTITY_TAIL) if x)
        ntail = self._ntok(tail)
        return self._fit(subject, max(12, 75 - ntail - 1)) + ", " + tail

    def _ntok(self, text: str) -> int:
        tok = getattr(self.pipe, "tokenizer", None)
        return len(tok(text).input_ids) - 2 if tok is not None else len(text.split())

    def world_prompt(self, prompt: str, strong: bool = False, colours: str | None = None) -> str:
        head = WORLD_SUFFIX + ", " + ("wholesome, abstract, " if strong else "")
        tail = ", " + (f"{colours}, " if colours else "") + WORLD_STYLE
        subject = prompt.strip().rstrip(",. ")
        if strong:  # regeneration: keep only the first clause (long sentences invite stalls, crowds and signs)
            m = re.split(r" where | that | with | filled | full of ", subject, maxsplit=1)
            if len(m[0].split()) >= 4:
                subject = m[0]
        return head + self._fit(subject, 75 - self._ntok(head) - self._ntok(tail) - 1) + tail

    # -- generation
    def _run(self, prompt: str, seed: int, width: int, height: int, strong: bool, wrap: bool,
             guidance: float | None = None) -> Image.Image:
        import torch

        pipe = self.load()
        g = torch.Generator(device="cpu").manual_seed(int(seed) & 0x7FFFFFFF)
        kw = dict(prompt=prompt, width=width, height=height, num_inference_steps=4, generator=g,
                  negative_prompt=(NEGATIVE_STRONG if strong else NEGATIVE) + (NEGATIVE_WORLD_EXTRA if wrap else ""),
                  guidance_scale=guidance if guidance is not None else (1.5 if strong else 0.0))
        with _lock, torch.inference_mode():
            if wrap:
                with circular_x(pipe.unet, pipe.vae.decoder, getattr(pipe.vae, "post_quant_conv", None)):
                    return pipe(**kw).images[0]
            return pipe(**kw).images[0]

    def world(self, prompt: str, seed: int, strong: bool = False, size=(2048, 1024), gen_size=(1536, 768),
              colours: str | None = None):
        self.load()
        p = self.world_prompt(prompt, strong, colours)
        img = self._run(p, seed, gen_size[0], gen_size[1], strong, wrap=True, guidance=WORLD_GUIDANCE)
        img = wrap_resize(img, size)
        from backend.assets.contrast import make_pattern_safe

        # §4.1 at the source: a gentle luminous floor (≥ 25% of the local maximum) keeps large periodic structure
        # (arcades, lantern strings) under Michelson 0.5; verified on 24 views with flashcheck's pattern test and
        # escalated if needed. Then calm poles and soft highlights.
        img, pattern = make_pattern_safe(img, start=0.25, radius=41, finish=lambda im: soft_highlights(calm_poles(im)))
        return img, {"pattern": pattern, "prompt": p, "negative_prompt": (NEGATIVE_STRONG if strong else NEGATIVE) + NEGATIVE_WORLD_EXTRA,
                     "guidance": WORLD_GUIDANCE, "gen_size": list(gen_size), "size": list(size)}

    def entity(self, prompt: str, seed: int, strong: bool = False, size=(1024, 1024), etype: str | None = None,
               colours: str | None = None):
        self.load()
        p = self.entity_prompt(prompt, strong, etype, colours)
        img = self._run(p, seed, size[0], size[1], strong, wrap=False)
        return img, {"prompt": p, "negative_prompt": NEGATIVE_STRONG if strong else NEGATIVE,
                     "guidance": 1.5 if strong else 0.0, "size": list(size)}
