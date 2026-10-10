"""Language-model expansion (BUILD.md §16.2): valid within 3 tries for 5 seeds; model unloaded afterwards.
Skipped unless the Ollama server answers with the configured model."""
import json
from pathlib import Path

import jsonschema
import pytest

from backend import llm, runtime
from backend.planner import expand as E
from backend.planner.sampler import sample_skeleton

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def live(monkeypatch):
    monkeypatch.delenv("HYPERSPACE_FORCE_TEMPLATES", raising=False)
    if not llm.available():
        pytest.skip("Ollama not reachable or model missing")


def test_expansion_valid_within_3_tries(live):
    schema = json.loads((ROOT / "shared" / "schemas" / "expansion.schema.json").read_text())
    for seed in (11, 22, 33, 44, 55):
        dose = "breakthrough" if seed % 2 else "strong"
        sk = sample_skeleton({"dose_step": dose, "answers": {"expectations": ["aliens"]}}, seed)
        exp = E.llm_expansion(sk, None, seed)
        assert exp is not None, f"seed {seed}: no valid expansion in 3 tries"
        jsonschema.validate(exp, schema)
        assert E.validate_expansion(exp) == []
        assert len(exp["entities"]) == len(sk["breakthrough"]["entities"])
        assert runtime.resident_models() == []
    import httpx

    assert httpx.get(runtime.ollama_host() + "/api/ps", timeout=5).json().get("models", []) == []


def test_fallback_when_runtime_stopped(monkeypatch):
    monkeypatch.delenv("HYPERSPACE_FORCE_TEMPLATES", raising=False)
    monkeypatch.setenv("HYPERSPACE_OLLAMA_HOST", "http://127.0.0.1:9")  # nothing listens there
    sk = sample_skeleton({"dose_step": "breakthrough"}, 5)
    exp, prov = E.expand_with_provenance(sk, None, 5)
    assert prov == "template" and E.validate_expansion(exp) == []
    assert runtime.resident_models() == []
