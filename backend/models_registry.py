"""Which models were chosen at setup and which fallbacks are active.

Reads verification/env.json (written by scripts/check_env.py --json after
scripts/fetch_models.py). Never raises: missing file -> conservative defaults.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_JSON = ROOT / "verification" / "env.json"
MODELS_JSON = ROOT / "verification" / "models.json"

HF_IDS = {
    "sdxl_base": "stabilityai/stable-diffusion-xl-base-1.0",
    "sdxl_lightning_repo": "ByteDance/SDXL-Lightning",
    "sdxl_lightning_unet": "sdxl_lightning_4step_unet.safetensors",
    "sdxl_vae": "madebyollin/sdxl-vae-fp16-fix",
    "sdxl_turbo": "stabilityai/sdxl-turbo",
    "depth": "depth-anything/Depth-Anything-V2-Small-hf",
    "safety_checker": "CompVis/stable-diffusion-safety-checker",
    "clip": "openai/clip-vit-base-patch32",
}


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


@lru_cache(maxsize=1)
def _cached() -> dict:
    env = _load(ENV_JSON)
    models = _load(MODELS_JSON)
    comps = models.get("components", {})
    llm_id = env.get("llm_model") or comps.get("llm", {}).get("id")
    reg = {
        "llm_runtime": "ollama" if llm_id else "none",
        "llm_model": llm_id,
        "llm_num_ctx": comps.get("llm", {}).get("num_ctx") or 8192,
        "llm_host": os.environ.get("HYPERSPACE_OLLAMA_HOST") or env.get("llm_host") or "http://127.0.0.1:11435",
        "images": env.get("images") or comps.get("sdxl", {}).get("id") or "procedural",
        "depth": env.get("depth") or comps.get("depth", {}).get("id") or "synthetic",
        "rembg": env.get("rembg") or comps.get("rembg", {}).get("id"),
        "safety": env.get("safety") or comps.get("safety", {}).get("id") or "clip_only",
        "clip": env.get("clip") or comps.get("clip", {}).get("id"),
        "fallbacks": list(env.get("fallbacks") or models.get("fallbacks") or []),
        "hf_ids": dict(HF_IDS),
        "configured": bool(env or models),
    }
    return reg


def get_registry(refresh: bool = False) -> dict:
    """Return a copy of the registry dict (keys: llm_model, llm_host, llm_runtime, images, depth,
    rembg, safety, clip, fallbacks, hf_ids, configured). HYPERSPACE_LLM_MODEL overrides llm_model."""
    if refresh:
        _cached.cache_clear()
    reg = dict(_cached())
    override = os.environ.get("HYPERSPACE_LLM_MODEL")
    if override:
        reg["llm_model"] = override
        reg["llm_runtime"] = "ollama"
    if os.environ.get("HYPERSPACE_NO_IMAGES") == "1":
        reg["images"] = "procedural"
    if os.environ.get("HYPERSPACE_FORCE_TEMPLATES") == "1":
        reg["llm_runtime"] = "none"
    return reg
