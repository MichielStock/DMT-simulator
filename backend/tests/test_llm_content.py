"""Content of generated text (BUILD.md §16.2): 20 expansions + 20 reports pass the banned-terms check, lengths
within the clamp, files labelled Simulated; with Ollama, 5 language-model reports too."""
import json

import pytest

from backend import llm
from backend.planner import expand as E
from backend.planner.sampler import sample_skeleton
from backend.report.writer import LENGTH_MAX, LENGTH_MIN, MESSAGE_LEAD, write_report
from backend.safety.content import check_obj, check_text
from backend.tests._helpers import DOSES, synthetic_session


def test_20_template_expansions_clean(monkeypatch):
    monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")
    for seed in range(100, 120):
        sk = sample_skeleton({"dose_step": DOSES[seed % 4]}, seed)
        exp = E.expand(sk, None, seed)
        assert check_obj(exp) == []


def _check_report(tmp, rep, ts, events):
    text = " ".join(p["text"] for p in rep["paragraphs"])
    assert check_text(text) == [], check_text(text)
    assert check_text(rep["title"]) == []
    assert rep["title"].startswith("Simulated trip report")
    md = (tmp / "simulated-trip-report.md").read_text()
    assert "simulated: true" in md and "Simulated trip report" in md
    if any(e["type"] == "message_shown" for e in events) and ts["breakthrough"]["message"]["sealed_text"]:
        assert MESSAGE_LEAD in text
    return len(text.split())


def test_20_template_reports_clean_and_sized(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")
    for seed in range(20):
        ts, intake, events, curve, rem, stats = synthetic_session(seed, DOSES[seed % 4])
        d = tmp_path / str(seed)
        d.mkdir()
        rep = write_report(d, ts, intake, events, rem, stats)
        n = _check_report(d, rep, ts, events)
        assert rep["provenance"] == "template"
        assert LENGTH_MIN * 0.8 <= n <= LENGTH_MAX
        target = ts["report"]["length_words"]
        assert n >= 0.75 * target or n >= 100, (n, target)
        assert n <= max(1.3 * target, 200), (n, target)
        assert json.loads((d / "report.json").read_text())["word_count"] == n
        if not ts["report"]["profundity"]:
            from backend.batch.coder import code_text

            assert not code_text(" ".join(p["text"] for p in rep["paragraphs"]))["profundity"]


def test_5_llm_reports(tmp_path, monkeypatch):
    monkeypatch.delenv("HYPERSPACE_FORCE_TEMPLATES", raising=False)
    if not llm.available():
        pytest.skip("Ollama not reachable or model missing")
    from backend import runtime

    used_llm = 0
    for seed in (201, 202, 203, 204, 205):
        monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")  # fast template planning; the writer uses the LLM
        ts, intake, events, curve, rem, stats = synthetic_session(seed, "breakthrough" if seed % 2 else "strong")
        monkeypatch.delenv("HYPERSPACE_FORCE_TEMPLATES")
        d = tmp_path / str(seed)
        d.mkdir()
        rep = write_report(d, ts, intake, events, rem, stats)
        n = _check_report(d, rep, ts, events)
        assert LENGTH_MIN * 0.8 <= n <= LENGTH_MAX * 1.25
        used_llm += rep["provenance"] == "llm"
        assert runtime.resident_models() == []
    assert used_llm >= 3, f"only {used_llm}/5 reports came from the language model"
