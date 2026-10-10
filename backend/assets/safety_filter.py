"""Image safety filter (BUILD.md §10, §4.3, §0.6) — non-negotiable.

Every generated image passes:
  (a) CompVis/stable-diffusion-safety-checker (its own CLIP-ViT-L/14 feature extractor) → nsfw flag;
  (b) CLIP (openai/clip-vit-base-patch32) zero-shot: softmax over UNSAFE + NEUTRAL prompts. Flag when the summed
      unsafe probability ≥ UNSAFE_SUM_MAX (0.25, conservative) or the argmax is an unsafe prompt;
  (c) any single unsafe prompt ≥ UNSAFE_ONE_MAX (0.10) also flags (stricter per concept).
Text/letters (§16.4) are NOT gated here: CLIP ViT-B/32 zero-shot cannot tell captions from ornament (measured:
a jester with a visible caption scored below several clean images); text is handled at the source (prompt) and by
the cut-out's connected-component cleanup (detached glyph clusters are dropped), see cutout.py.
`decide(scores)` is the pure threshold logic (unit-tested with injected scores).

Loaded once per batch (`with SafetyFilter() as f: f.check(img)`), registered as resident while loaded.
If it cannot load, `FilterUnavailable` is raised and the caller must use NO generated image.
"""
from __future__ import annotations

import time

import numpy as np
from PIL import Image

from backend import runtime

REGISTRY_NAME = "safety_filter"
UNSAFE = ["gore", "blood", "injury", "corpse", "nudity", "a wound"]
NEUTRAL = ["abstract geometric art", "a luminous being made of light", "an ornate temple",
           "colourful fractal patterns", "a jester made of jewels", "a landscape"]
# Extra neutral prompts for the kinds of beings and worlds the planner asks for (decision A3 in NOTES.md): with only
# the six spec prompts, CLIP pushes any non-matching figure (a jellyfish of light, a robed being) onto "corpse"/"gore".
NEUTRAL_EXTRA = ["a robed figure made of light", "a glowing creature", "a jellyfish of light", "a serpent made of jewels",
                 "a cosmic being", "a figure in flowing robes", "a crystal sculpture", "a colourful costume",
                 "an alien made of glass", "a glowing insect made of crystal", "a fantasy character", "a starry sky"]
NEUTRAL = NEUTRAL + NEUTRAL_EXTRA
# Quality check for world backdrops (not a §4.3 safety gate): SDXL fills fairgrounds and halls with crowds of
# ordinary people, which breaks the "uninhabited other world" (§16.4). Scored on 8 crops of the lower band, where
# figures stand; measured on generated worlds: crowded ≥ 0.47 (after the luminous floor), empty ≤ 0.19.
PEOPLE = ["a crowd of people", "people walking", "a group of tourists"]
NO_PEOPLE = ["an empty place with no people", "an empty fantasy landscape", "an empty ornate interior", "abstract art"]
PEOPLE_MAX = 0.3
UNSAFE_SUM_MAX = 0.25
UNSAFE_ONE_MAX = 0.10


class FilterUnavailable(RuntimeError):
    pass


def decide(scores: dict) -> tuple[bool, list[str]]:
    """Threshold logic. scores: {nsfw: bool, unsafe: {prompt: p}, neutral: {prompt: p}}."""
    reasons = []
    if scores.get("nsfw"):
        reasons.append("safety_checker_nsfw")
    unsafe = scores.get("unsafe") or {}
    neutral = scores.get("neutral") or {}
    s = float(sum(unsafe.values()))
    if s >= UNSAFE_SUM_MAX:
        reasons.append(f"clip_unsafe_sum {s:.3f} >= {UNSAFE_SUM_MAX}")
    allp = {**{("u", k): v for k, v in unsafe.items()}, **{("n", k): v for k, v in neutral.items()}}
    if allp:
        (kind, name), _ = max(allp.items(), key=lambda kv: kv[1])
        if kind == "u":
            reasons.append(f"clip_argmax_unsafe '{name}'")
    for k, v in unsafe.items():
        if float(v) >= UNSAFE_ONE_MAX:
            reasons.append(f"clip_unsafe '{k}' {float(v):.3f} >= {UNSAFE_ONE_MAX}")
    return (not reasons), reasons


def _snap(repo: str, **kw) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(repo, local_files_only=True, **kw)


class SafetyFilter:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.sc = self.sc_fe = self.clip = self.clip_proc = None
        self._text_feats = self._people_feats = None
        self.load_seconds = None

    # -- lifecycle
    def load(self) -> "SafetyFilter":
        if self.sc is not None:
            return self
        runtime.set_offline_env()
        t0 = time.time()
        runtime.register(REGISTRY_NAME, "safety", device=self.device)
        try:
            import torch
            from diffusers.pipelines.stable_diffusion.safety_checker import StableDiffusionSafetyChecker
            from transformers import CLIPImageProcessor, CLIPModel, CLIPProcessor

            from backend.models_registry import HF_IDS

            sp = _snap(HF_IDS["safety_checker"], ignore_patterns=["*.msgpack", "flax*", "*.h5", "*.onnx", "*.ot"])
            self.sc_fe = CLIPImageProcessor.from_pretrained(sp)
            self.sc = StableDiffusionSafetyChecker.from_pretrained(sp, torch_dtype=torch.float16).to(self.device).eval()
            cp = _snap(HF_IDS["clip"], allow_patterns=["*.json", "*.txt", "pytorch_model.bin"])
            self.clip = CLIPModel.from_pretrained(cp, torch_dtype=torch.float16).to(self.device).eval()
            self.clip_proc = CLIPProcessor.from_pretrained(cp)
            with torch.inference_mode():
                tin = self.clip_proc(text=UNSAFE + NEUTRAL, return_tensors="pt", padding=True).to(self.device)
                tf = self.clip.get_text_features(**tin)
                tf = getattr(tf, "pooler_output", tf)
                self._text_feats = tf / tf.norm(dim=-1, keepdim=True)
                pin = self.clip_proc(text=PEOPLE + NO_PEOPLE, return_tensors="pt", padding=True).to(self.device)
                pf = self.clip.get_text_features(**pin)
                pf = getattr(pf, "pooler_output", pf)
                self._people_feats = pf / pf.norm(dim=-1, keepdim=True)
        except Exception as e:
            self.unload()
            raise FilterUnavailable(f"{type(e).__name__}: {str(e)[:200]}") from e
        self.load_seconds = round(time.time() - t0, 2)
        return self

    def unload(self) -> None:
        self.sc = self.sc_fe = self.clip = self.clip_proc = self._text_feats = self._people_feats = None
        from backend.assets.vram import free_gpu

        free_gpu()
        runtime.unregister(REGISTRY_NAME)

    def __enter__(self):
        return self.load()

    def __exit__(self, *exc):
        self.unload()
        return False

    # -- scoring
    def scores(self, image: Image.Image) -> dict:
        import torch

        if self.sc is None:
            raise FilterUnavailable("filter not loaded")
        img = image.convert("RGB")
        with torch.inference_mode():
            px = self.sc_fe(images=[img], return_tensors="pt").pixel_values.to(self.device, torch.float16)
            _, nsfw = self.sc(clip_input=px, images=[np.zeros((1, 1, 3), np.float32)])
            cin = self.clip_proc(images=img, return_tensors="pt").to(self.device)
            f = self.clip.get_image_features(pixel_values=cin["pixel_values"].half())
            f = getattr(f, "pooler_output", f)
            f = f / f.norm(dim=-1, keepdim=True)
            logits = (self.clip.logit_scale.exp() * f @ self._text_feats.T)[0].float()
            nu = len(UNSAFE)
            p_main = logits.softmax(-1).cpu().numpy()
        return {
            "nsfw": bool(nsfw[0]),
            "unsafe": {k: round(float(v), 4) for k, v in zip(UNSAFE, p_main[:nu])},
            "neutral": {k: round(float(v), 4) for k, v in zip(NEUTRAL, p_main[nu:])},
            "unsafe_sum": round(float(p_main[:nu].sum()), 4),
        }

    def people_score(self, image: Image.Image) -> float:
        """Max probability of the PEOPLE prompts over 8 square crops of the lower band of an equirect world."""
        import torch

        im = image.convert("RGB")
        w, h = im.size
        s = h * 45 // 100
        crops = [im.crop((x * w // 8, h - s - h // 20, x * w // 8 + s, h - h // 20)) for x in range(8)]
        with torch.inference_mode():
            px = self.clip_proc(images=crops, return_tensors="pt")["pixel_values"].to(self.device).half()
            f = self.clip.get_image_features(pixel_values=px)
            f = getattr(f, "pooler_output", f)
            f = f / f.norm(dim=-1, keepdim=True)
            p = (self.clip.logit_scale.exp() * f @ self._people_feats.T).float().softmax(-1)[:, :len(PEOPLE)].sum(-1)
        return round(float(p.max()), 4)

    def check(self, image: Image.Image) -> dict:
        s = self.scores(image)
        ok, reasons = decide(s)
        return {"ok": ok, "reasons": reasons, "scores": s}
