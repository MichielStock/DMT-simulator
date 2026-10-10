#!/usr/bin/env python3
"""Download and smoke-test every model Hyperspace uses (BUILD.md 3.2).

Resumable (huggingface_hub snapshot_download) and idempotent: components already
verified in verification/models.json are skipped unless --force.
Usage: uv run python scripts/fetch_models.py [--force] [--only NAME[,NAME]] [--room-only] [--skip-room]
Components (in order): llm, sdxl, depth, rembg, safety, clip, room
"""
from __future__ import annotations

import argparse, gc, io, json, os, subprocess, sys, time, traceback, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERIF = ROOT / "verification"
MODELS_JSON = VERIF / "models.json"
ROOM_PATH = ROOT / "assets" / "sample" / "room.jpg"
OLLAMA = os.environ.get("HYPERSPACE_OLLAMA_HOST", "http://127.0.0.1:11435").rstrip("/")
ROOM_PROMPT = ("a cosy living room with a sofa, a plant, bookshelves and a window, "
               "natural light, photograph")

LLM_CANDIDATES = ["qwen3:14b", "qwen3:8b", "llama3.1:8b-instruct-q4_K_M", "gemma3:12b"]
LLM_MAX_VRAM_GIB = 10.0
LLM_NUM_CTX = 8192  # the back end must pass the same num_ctx (default context makes KV cache huge)

SDXL_BASE = "stabilityai/stable-diffusion-xl-base-1.0"
SDXL_LIGHTNING = "ByteDance/SDXL-Lightning"
LIGHTNING_FILE = "sdxl_lightning_4step_unet.safetensors"
SDXL_VAE = "madebyollin/sdxl-vae-fp16-fix"
SDXL_TURBO = "stabilityai/sdxl-turbo"
DEPTH = "depth-anything/Depth-Anything-V2-Small-hf"
SAFETY = "CompVis/stable-diffusion-safety-checker"
CLIP = "openai/clip-vit-base-patch32"

BASE_PATTERNS = [
    "model_index.json", "scheduler/*.json", "tokenizer/*", "tokenizer_2/*",
    "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
    "text_encoder_2/config.json", "text_encoder_2/model.fp16.safetensors",
    "unet/config.json", "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors",
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_db() -> dict:
    if MODELS_JSON.exists():
        try:
            return json.loads(MODELS_JSON.read_text())
        except Exception:
            pass
    return {"components": {}, "fallbacks": []}


def save_db(db: dict):
    VERIF.mkdir(parents=True, exist_ok=True)
    db["updated"] = now()
    fb = []
    for k, c in db["components"].items():
        if c.get("fallback"):
            fb.append(f"{k}: {c['fallback']}")
    db["fallbacks"] = fb
    MODELS_JSON.write_text(json.dumps(db, indent=2))


def cleanup_gpu():
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def vram_reset():
    import torch
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def vram_peak_gib() -> float:
    import torch
    if torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / 2**30, 2)
    return 0.0


def snap(repo, **kw) -> str:
    from huggingface_hub import snapshot_download
    for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        os.environ.pop(k, None)
    last = None
    for attempt in range(4):
        try:
            return snapshot_download(repo, **kw)
        except Exception as e:  # network hiccup: retry (resumable)
            last = e
            log(f"download {repo} failed ({type(e).__name__}); retry {attempt + 1}")
            time.sleep(5 * (attempt + 1))
    raise last


# ---------------------------------------------------------------- LLM

PROBE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "count": {"type": "integer"},
        "mood": {"type": "string", "enum": ["calm", "curious", "tense", "joyful"]},
        "colors": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3},
        "intensity": {"type": "number"},
        "enabled": {"type": "boolean"},
        "summary": {"type": "string"},
        "nested": {"type": "object", "properties": {"label": {"type": "string"}, "level": {"type": "integer"}},
                   "required": ["label", "level"]},
    },
    "required": ["title", "count", "mood", "colors", "intensity", "enabled", "summary", "nested"],
}


def http_json(path, body=None, timeout=60, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(OLLAMA + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ollama_has(tag) -> bool:
    names = [m["name"] for m in http_json("/api/tags").get("models", [])]
    return tag in names or (":" not in tag and tag + ":latest" in names)


def ollama_pull(tag):
    log(f"ollama pull {tag}")
    req = urllib.request.Request(OLLAMA + "/api/pull", data=json.dumps({"name": tag, "stream": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    last = 0
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if "error" in d:
                raise RuntimeError(d["error"])
            if d.get("total") and time.time() - last > 30:
                log(f"  {d.get('status')} {100 * d.get('completed', 0) / d['total']:.0f}%")
                last = time.time()


def probe_llm(tag, seeds=(1, 2, 3)) -> dict:
    import jsonschema
    res = {"tag": tag, "runs": [], "passed": False, "vram_gib": None}
    prompt = ("Invent a small made-up record about a quiet harbour town. Fill every field of the schema. "
              "colors must hold exactly three colour names.")
    for i, seed in enumerate(seeds):
        t0 = time.time()
        body = {"model": tag, "prompt": prompt, "stream": False, "think": False, "format": PROBE_SCHEMA,
                "keep_alive": "60s" if i == 0 else 0, "options": {"seed": seed, "temperature": 0.7, "num_predict": 400, "num_ctx": LLM_NUM_CTX}}
        run = {"seed": seed, "ok": False}
        try:
            r = http_json("/api/generate", body, timeout=30)
            obj = json.loads(r["response"])
            jsonschema.validate(obj, PROBE_SCHEMA)
            run["ok"] = True
            if i == 0:
                try:
                    ps = http_json("/api/ps")
                    for m in ps.get("models", []):
                        if m.get("name") == tag or m.get("model") == tag:
                            res["vram_gib"] = round(m.get("size_vram", 0) / 2**30, 2)
                            res["size_gib"] = round(m.get("size", 0) / 2**30, 2)
                except Exception:
                    pass
        except Exception as e:
            run["error"] = f"{type(e).__name__}: {e}"[:200]
        run["seconds"] = round(time.time() - t0, 1)
        res["runs"].append(run)
        if not run["ok"]:
            break
    res["passed"] = all(r["ok"] for r in res["runs"]) and len(res["runs"]) == len(seeds)
    try:  # unload
        http_json("/api/generate", {"model": tag, "keep_alive": 0, "prompt": ""}, timeout=30)
    except Exception:
        pass
    return res


def do_llm(db, force):
    cur = db["components"].get("llm")
    if cur and cur.get("status") == "verified" and not force:
        log("llm: already verified:", cur["id"])
        return
    try:
        http_json("/api/version", timeout=5)
    except Exception:
        subprocess.run([str(ROOT / "scripts" / "ensure_ollama.sh")], check=False)
    probes = []
    chosen = None
    for tag in LLM_CANDIDATES:
        try:
            if not ollama_has(tag):
                ollama_pull(tag)
            p = probe_llm(tag)
        except Exception as e:
            p = {"tag": tag, "passed": False, "error": f"{type(e).__name__}: {e}"[:200]}
        probes.append(p)
        log(f"llm probe {tag}: passed={p['passed']} vram={p.get('vram_gib')}")
        if p["passed"] and (p.get("vram_gib") is None or p["vram_gib"] <= LLM_MAX_VRAM_GIB):
            chosen = p
            break
        if p["passed"]:
            log(f"  {tag} passes but needs {p.get('vram_gib')} GiB > {LLM_MAX_VRAM_GIB}; trying next")
    comp = {"probes": probes, "checked": now()}
    if chosen:
        comp.update(status="verified", id=chosen["tag"], runtime="ollama", host=OLLAMA, num_ctx=LLM_NUM_CTX,
                    peak_vram_gb=chosen.get("vram_gib"))
        if chosen["tag"] != LLM_CANDIDATES[0]:
            comp["fallback"] = f"language model {chosen['tag']} instead of preferred {LLM_CANDIDATES[0]}"
    else:
        comp.update(status="failed", id=None, runtime="none",
                    fallback="no language model passed the structured-output probe; templated text only")
    db["components"]["llm"] = comp


# ---------------------------------------------------------------- SDXL

def lightning_pipe(device="cuda"):
    import torch
    from diffusers import StableDiffusionXLPipeline, UNet2DConditionModel, EulerDiscreteScheduler, AutoencoderKL
    from safetensors.torch import load_file
    base = snap(SDXL_BASE, allow_patterns=BASE_PATTERNS)
    vae_dir = snap(SDXL_VAE, allow_patterns=["config.json", "diffusion_pytorch_model.safetensors"])
    lf = snap(SDXL_LIGHTNING, allow_patterns=[LIGHTNING_FILE])
    unet = UNet2DConditionModel.from_config(UNet2DConditionModel.load_config(base, subfolder="unet")).to(torch.float16)
    unet.load_state_dict(load_file(os.path.join(lf, LIGHTNING_FILE)))
    vae = AutoencoderKL.from_pretrained(vae_dir, torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(base, unet=unet, vae=vae, torch_dtype=torch.float16,
                                                     variant="fp16")
    pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
    return pipe.to(device), dict(num_inference_steps=4, guidance_scale=0.0)


def turbo_pipe(device="cuda"):
    import torch
    from diffusers import AutoPipelineForText2Image
    path = snap(SDXL_TURBO, allow_patterns=[
        "model_index.json", "scheduler/*.json", "tokenizer/*", "tokenizer_2/*",
        "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
        "text_encoder_2/config.json", "text_encoder_2/model.fp16.safetensors",
        "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors"])
    pipe = AutoPipelineForText2Image.from_pretrained(path, torch_dtype=torch.float16, variant="fp16")
    return pipe.to(device), dict(num_inference_steps=1, guidance_scale=0.0)


def smoke_pipe(builder, name):
    import torch
    vram_reset()
    t0 = time.time()
    pipe, kw = builder()
    img = pipe(ROOM_PROMPT, width=512, height=512, **kw).images[0]
    import numpy as np
    arr = np.asarray(img).astype("float32")
    if not np.isfinite(arr).all() or arr.std() < 3:
        raise RuntimeError(f"{name} produced a blank/invalid image (std={arr.std():.2f})")
    res = {"seconds": round(time.time() - t0, 1), "peak_vram_gb": vram_peak_gib()}
    del pipe
    cleanup_gpu()
    return res


def do_sdxl(db, force):
    cur = db["components"].get("sdxl")
    if cur and cur.get("status") in ("verified", "fallback") and not force:
        log("sdxl: already verified:", cur["id"])
        return
    comp = {"checked": now(), "base": SDXL_BASE, "vae": SDXL_VAE}
    try:
        r = smoke_pipe(lightning_pipe, "sdxl_lightning")
        comp.update(status="verified", id="sdxl_lightning", unet=f"{SDXL_LIGHTNING}/{LIGHTNING_FILE}", **r)
    except Exception as e:
        traceback.print_exc()
        log("SDXL-Lightning failed; trying SDXL-Turbo:", e)
        cleanup_gpu()
        try:
            r = smoke_pipe(turbo_pipe, "sdxl_turbo")
            comp.update(status="fallback", id="sdxl_turbo", model=SDXL_TURBO, **r,
                        fallback=f"SDXL-Turbo instead of SDXL-Lightning ({type(e).__name__}: {str(e)[:120]})")
        except Exception as e2:
            traceback.print_exc()
            comp.update(status="failed", id="procedural",
                        fallback=f"procedural assets (SDXL-Lightning and SDXL-Turbo both failed: {str(e2)[:120]})")
    db["components"]["sdxl"] = comp


# ---------------------------------------------------------------- small models

def do_depth(db, force):
    cur = db["components"].get("depth")
    if cur and cur.get("status") == "verified" and not force:
        log("depth: already verified")
        return
    comp = {"checked": now()}
    try:
        import torch
        from PIL import Image
        import numpy as np
        from transformers import pipeline
        path = snap(DEPTH)
        vram_reset()
        t0 = time.time()
        pipe = pipeline("depth-estimation", model=path, device=0 if torch.cuda.is_available() else -1)
        rng = np.random.default_rng(0)
        base = np.tile(np.linspace(0, 255, 256, dtype="uint8"), (256, 1))
        img = Image.fromarray(np.stack([base, base.T, (rng.random((256, 256)) * 255).astype("uint8")], -1))
        out = pipe(img)["depth"]
        arr = np.asarray(out)
        if arr.shape[0] < 16 or not np.isfinite(arr.astype("float32")).all():
            raise RuntimeError("bad depth output")
        comp.update(status="verified", id=DEPTH, seconds=round(time.time() - t0, 1), peak_vram_gb=vram_peak_gib())
        del pipe
    except Exception as e:
        traceback.print_exc()
        comp.update(status="fallback", id="synthetic",
                    fallback=f"synthetic depth (centre-weighted gradient) because {type(e).__name__}: {str(e)[:100]}")
    cleanup_gpu()
    db["components"]["depth"] = comp


def do_rembg(db, force):
    cur = db["components"].get("rembg")
    if cur and cur.get("status") == "verified" and not force:
        log("rembg: already verified:", cur["id"])
        return
    from PIL import Image
    import numpy as np
    os.environ.pop("HF_HUB_OFFLINE", None)
    comp = {"checked": now(), "attempts": []}
    img = Image.fromarray((np.random.default_rng(1).random((256, 256, 3)) * 255).astype("uint8"))
    for name in ("birefnet-general", "u2net"):
        try:
            from rembg import new_session, remove
            t0 = time.time()
            sess = new_session(name)
            out = remove(img, session=sess)
            if out.mode != "RGBA":
                raise RuntimeError("no alpha output")
            comp.update(status="verified", id=name, seconds=round(time.time() - t0, 1),
                        providers=list(getattr(getattr(sess, "inner_session", None), "get_providers", lambda: [])()))
            if name != "birefnet-general":
                comp["fallback"] = f"rembg model {name} instead of birefnet-general"
            break
        except Exception as e:
            traceback.print_exc()
            comp["attempts"].append(f"{name}: {type(e).__name__}: {str(e)[:120]}")
    else:
        comp.update(status="failed", id=None, fallback="no background-removal model; luminance/edge matte used")
    db["components"]["rembg"] = comp


def do_safety(db, force):
    cur = db["components"].get("safety")
    if cur and cur.get("status") == "verified" and not force:
        log("safety: already verified")
        return
    comp = {"checked": now()}
    try:
        import torch, numpy as np
        from PIL import Image
        from diffusers.pipelines.stable_diffusion.safety_checker import StableDiffusionSafetyChecker
        from transformers import CLIPImageProcessor
        path = snap(SAFETY, ignore_patterns=["*.msgpack", "flax*", "*.h5", "*.onnx", "*.ot"])
        vram_reset()
        t0 = time.time()
        fe = CLIPImageProcessor.from_pretrained(path)
        sc = StableDiffusionSafetyChecker.from_pretrained(path, torch_dtype=torch.float16).to("cuda")
        img = Image.new("RGB", (256, 256), (255, 255, 255))
        px = fe(images=[img], return_tensors="pt").pixel_values.to("cuda", torch.float16)
        _, flags = sc(clip_input=px, images=[np.asarray(img).astype("float32") / 255])
        comp.update(status="verified", id=SAFETY, blank_flagged=bool(flags[0]),
                    seconds=round(time.time() - t0, 1), peak_vram_gb=vram_peak_gib())
        del sc
    except Exception as e:
        traceback.print_exc()
        comp.update(status="fallback", id="clip_only",
                    fallback=f"safety checker unavailable ({type(e).__name__}: {str(e)[:100]}); CLIP zero-shot check only")
    cleanup_gpu()
    db["components"]["safety"] = comp


def do_clip(db, force):
    cur = db["components"].get("clip")
    if cur and cur.get("status") == "verified" and not force:
        log("clip: already verified")
        return
    comp = {"checked": now()}
    try:
        import torch
        from PIL import Image
        from transformers import CLIPModel, CLIPProcessor
        path = snap(CLIP, allow_patterns=["*.json", "*.txt", "pytorch_model.bin"])
        vram_reset()
        t0 = time.time()
        m = CLIPModel.from_pretrained(path, torch_dtype=torch.float16).to("cuda").eval()
        p = CLIPProcessor.from_pretrained(path)
        img = Image.new("RGB", (224, 224), (200, 30, 30))
        texts = ["a plain red square", "a photograph of a forest", "a blue ocean"]
        inp = p(text=texts, images=img, return_tensors="pt", padding=True).to("cuda")
        inp["pixel_values"] = inp["pixel_values"].half()
        with torch.no_grad():
            probs = m(**inp).logits_per_image.softmax(-1)[0].tolist()
        comp.update(status="verified", id=CLIP, probs=[round(x, 3) for x in probs],
                    seconds=round(time.time() - t0, 1), peak_vram_gb=vram_peak_gib())
        del m
    except Exception as e:
        traceback.print_exc()
        comp.update(status="failed", id=None, fallback=f"CLIP check disabled ({type(e).__name__}: {str(e)[:100]})")
    cleanup_gpu()
    db["components"]["clip"] = comp


# ---------------------------------------------------------------- sample room

def procedural_room(path: Path):
    from PIL import Image, ImageDraw, ImageFilter
    W, H = 1024, 768
    im = Image.new("RGB", (W, H), (200, 190, 175))
    d = ImageDraw.Draw(im)
    vx0, vy0, vx1, vy1 = 300, 220, 724, 520  # back wall rectangle
    d.polygon([(0, 0), (W, 0), (vx1, vy0), (vx0, vy0)], fill=(225, 220, 208))        # ceiling
    d.polygon([(0, H), (W, H), (vx1, vy1), (vx0, vy1)], fill=(150, 110, 75))          # floor
    d.polygon([(0, 0), (vx0, vy0), (vx0, vy1), (0, H)], fill=(205, 192, 170))         # left wall
    d.polygon([(W, 0), (vx1, vy0), (vx1, vy1), (W, H)], fill=(190, 178, 158))         # right wall
    d.rectangle([vx0, vy0, vx1, vy1], fill=(214, 202, 182))                           # back wall
    for i in range(1, 9):  # floor boards
        t = i / 9
        d.line([(vx0 + (0 - vx0) * t * 1.0 + (vx1 - vx0) * 0, vy1 + (H - vy1) * t),
                (vx1 + (W - vx1) * t, vy1 + (H - vy1) * t)], fill=(130, 95, 62), width=2)
    d.rectangle([420, 260, 600, 400], fill=(170, 210, 240), outline=(250, 250, 245), width=8)  # window
    d.line([(510, 260), (510, 400)], fill=(250, 250, 245), width=6)
    d.line([(420, 330), (600, 330)], fill=(250, 250, 245), width=6)
    d.rectangle([330, 300, 400, 520], fill=(110, 75, 50))                              # bookshelf
    for y in range(315, 520, 40):
        d.rectangle([336, y, 394, y + 28], fill=(160 + (y % 3) * 25, 90, 70))
    d.rounded_rectangle([420, 440, 760, 600], radius=24, fill=(70, 100, 130))          # sofa
    d.rounded_rectangle([420, 410, 760, 480], radius=24, fill=(85, 118, 152))
    d.ellipse([650, 480, 700, 530], fill=(210, 190, 90))                               # cushion
    d.rectangle([860, 520, 900, 600], fill=(150, 80, 50))                              # pot
    d.ellipse([830, 400, 930, 530], fill=(60, 130, 70))                                # plant
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=90)


def do_room(db, force):
    if ROOM_PATH.exists() and not force and db["components"].get("room", {}).get("status") in ("verified", "fallback"):
        log("room: exists")
        return
    comp = {"checked": now(), "prompt": ROOM_PROMPT}
    sd = db["components"].get("sdxl", {})
    try:
        if sd.get("id") not in ("sdxl_lightning", "sdxl_turbo"):
            raise RuntimeError("no image model available")
        builder = lightning_pipe if sd["id"] == "sdxl_lightning" else turbo_pipe
        pipe, kw = builder()
        import torch
        g = torch.Generator("cuda").manual_seed(7)
        img = pipe(ROOM_PROMPT, width=1024, height=768, generator=g, **kw).images[0].convert("RGB")
        del pipe
        cleanup_gpu()
        ROOM_PATH.parent.mkdir(parents=True, exist_ok=True)
        clean = Image_no_meta(img)
        clean.save(ROOM_PATH, "JPEG", quality=92)  # no exif/pnginfo carried over
        comp.update(status="verified", source=sd["id"])
    except Exception as e:
        traceback.print_exc()
        cleanup_gpu()
        procedural_room(ROOM_PATH)
        comp.update(status="fallback", source="procedural",
                    fallback=f"procedural sample room ({type(e).__name__}: {str(e)[:100]})")
    db["components"]["room"] = comp


def Image_no_meta(img):
    from PIL import Image
    out = Image.new("RGB", img.size)
    out.putdata(list(img.getdata()))
    return out


STEPS = [("llm", do_llm), ("sdxl", do_sdxl), ("depth", do_depth), ("rembg", do_rembg),
         ("safety", do_safety), ("clip", do_clip), ("room", do_room)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--room-only", action="store_true")
    ap.add_argument("--skip-room", action="store_true")
    a = ap.parse_args()
    only = set(filter(None, a.only.split(",")))
    if a.room_only:
        only = {"room"}
    db = load_db()
    for name, fn in STEPS:
        if only and name not in only:
            continue
        if name == "room" and a.skip_room:
            continue
        log(f"=== {name}")
        t0 = time.time()
        try:
            fn(db, a.force)
        except Exception as e:
            traceback.print_exc()
            db["components"].setdefault(name, {}).update(status="failed", error=f"{type(e).__name__}: {e}"[:200])
        save_db(db)
        c = db["components"].get(name, {})
        log(f"{name}: {c.get('status')} id={c.get('id')} vram={c.get('peak_vram_gb')} ({time.time() - t0:.0f}s)")
    # exit non-zero only if a core piece is entirely unusable AND has no fallback (never: all have fallbacks)
    log("done; fallbacks:", db.get("fallbacks"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
