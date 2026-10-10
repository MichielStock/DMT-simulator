"""Runtime configuration and the resident-model registry shared by the planner, assets and report.

Everything that loads a model onto the graphics card registers it here (`register(name, kind)`)
and unregisters it after unloading; `/api/status` reports `resident_models()`.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11435"
DEFAULT_LLM_MODEL = "qwen3:8b"


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def force_templates() -> bool:
    return env_flag("HYPERSPACE_FORCE_TEMPLATES")


def no_images() -> bool:
    return env_flag("HYPERSPACE_NO_IMAGES")


def sessions_dir() -> Path:
    p = Path(os.environ.get("HYPERSPACE_SESSIONS_DIR", str(ROOT / "sessions")))
    if not p.is_absolute():
        p = ROOT / p
    p.mkdir(parents=True, exist_ok=True)
    return p


def ollama_host() -> str:
    return os.environ.get("HYPERSPACE_OLLAMA_HOST", DEFAULT_OLLAMA_HOST).rstrip("/")


def llm_model() -> str:
    m = os.environ.get("HYPERSPACE_LLM_MODEL")
    if m:
        return m
    try:  # owned by another track; optional
        from backend.models_registry import get_registry  # type: ignore

        v = get_registry().get("llm_model")
        if isinstance(v, str) and v:
            return v
    except Exception:
        pass
    try:
        env = json.loads((ROOT / "verification" / "env.json").read_text())
        for key in ("llm_model", "language_model"):
            v = env.get(key) or (env.get("models") or {}).get(key) or (env.get("models") or {}).get("llm")
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict) and v.get("tag"):
                return v["tag"]
    except Exception:
        pass
    return DEFAULT_LLM_MODEL


def set_offline_env() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


# ---------------------------------------------------------------- resident models
_res_lock = threading.Lock()
_resident: dict[str, dict] = {}


def register(name: str, kind: str = "model", **info) -> None:
    with _res_lock:
        _resident[name] = {"name": name, "kind": kind, "since": time.time(), **info}


def unregister(name: str) -> None:
    with _res_lock:
        _resident.pop(name, None)


def resident_models() -> list[dict]:
    with _res_lock:
        return [dict(v) for v in _resident.values()]


# ---------------------------------------------------------------- fallbacks seen at runtime
_fallbacks: list[str] = []


def note_fallback(text: str) -> None:
    with _res_lock:
        if text not in _fallbacks:
            _fallbacks.append(text)


def fallbacks() -> list[str]:
    with _res_lock:
        return list(_fallbacks)
