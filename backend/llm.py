"""Minimal Ollama client (BUILD.md §9.2, §13.4): structured JSON output, keep_alive 0, verified unload.

The model is registered in the resident-model registry (backend.runtime) for as long as a generation is in
flight and until GET /api/ps confirms it has left graphics memory.
"""
from __future__ import annotations

import json
import threading
import time

import httpx

from backend import runtime

_call_lock = threading.Lock()  # one model on the card at a time


class LLMError(RuntimeError):
    pass


def available(timeout: float = 2.0) -> bool:
    """True if the Ollama server answers and has the configured model."""
    if runtime.force_templates():
        return False
    try:
        r = httpx.get(runtime.ollama_host() + "/api/tags", timeout=timeout)
        r.raise_for_status()
        names = {m.get("name") for m in r.json().get("models", [])} | {m.get("model") for m in r.json().get("models", [])}
        model = runtime.llm_model()
        return model in names or (model + ":latest") in names
    except Exception:
        return False


def _loaded_models(timeout: float = 3.0) -> list[str]:
    r = httpx.get(runtime.ollama_host() + "/api/ps", timeout=timeout)
    r.raise_for_status()
    return [m.get("name") or m.get("model") for m in r.json().get("models", [])]


def unload(model: str | None = None, wait_s: float = 30.0) -> bool:
    """Ask Ollama to unload (keep_alive 0) and poll /api/ps until the model is gone."""
    model = model or runtime.llm_model()
    host = runtime.ollama_host()
    try:
        httpx.post(host + "/api/generate", json={"model": model, "keep_alive": 0}, timeout=30)
    except Exception:
        pass
    deadline = time.time() + wait_s
    while time.time() < deadline:
        try:
            if not [m for m in _loaded_models() if m and m.split(":")[0] == model.split(":")[0]]:
                return True
        except Exception:
            return False
        time.sleep(0.5)
    return False


def chat_json(system: str, user: str, schema: dict, *, seed: int = 0, temperature: float = 0.8,
              purpose: str = "llm", timeout: float = 240.0, num_predict: int | None = None) -> dict:
    """One structured chat call. Returns the parsed JSON object (not yet validated)."""
    if runtime.force_templates():
        raise LLMError("HYPERSPACE_FORCE_TEMPLATES=1")
    model = runtime.llm_model()
    reg_name = f"ollama:{model}"
    options = {"temperature": temperature, "seed": int(seed) % (2**31)}
    if num_predict:
        options["num_predict"] = num_predict
    body = {"model": model, "stream": False, "think": False, "keep_alive": 0, "format": schema,
            "options": options,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    with _call_lock:
        runtime.register(reg_name, "llm", purpose=purpose, host=runtime.ollama_host())
        try:
            r = httpx.post(runtime.ollama_host() + "/api/chat", json=body, timeout=timeout)
            r.raise_for_status()
            content = r.json().get("message", {}).get("content", "")
        except httpx.HTTPError as e:
            raise LLMError(f"ollama request failed: {e}") from e
        finally:
            ok = unload(model)
            if ok:
                runtime.unregister(reg_name)
            else:
                # could not confirm; one more try before giving up (keeps /status honest)
                if unload(model, wait_s=15.0):
                    runtime.unregister(reg_name)
                else:
                    try:
                        _loaded_models()
                    except Exception:  # server gone: nothing can be resident
                        runtime.unregister(reg_name)
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`")
        content = content[content.find("{"):]
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise LLMError(f"model returned invalid JSON: {e}") from e
