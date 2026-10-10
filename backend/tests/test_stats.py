"""Shared stats function (BUILD.md §15.3) on the fixed example session."""
import json
from pathlib import Path

import jsonschema

from backend.report.pipeline import load_events, load_json
from backend.report.stats import SPARK, compute_stats, make_box, mmss

FIX = Path(__file__).resolve().parent / "fixtures" / "example_session"
ROOT = Path(__file__).resolve().parents[2]


def _load():
    return (load_json(FIX / "trip_script.json"), load_events(FIX), load_json(FIX / "curve.json"),
            load_json(FIX / "intake.json"))


def test_fixture_is_valid():
    ts, events, _, intake = _load()
    schemas = ROOT / "shared" / "schemas"
    jsonschema.validate(ts, json.loads((schemas / "trip_script.schema.json").read_text()))
    jsonschema.validate(intake, json.loads((schemas / "intake.schema.json").read_text()))
    ev_schema = json.loads((schemas / "event_log.schema.json").read_text())
    for e in events[:50] + [e for e in events if e["type"] != "intensity_sample"]:
        jsonschema.validate(e, ev_schema)


def test_example_session_values():
    s = compute_stats(*_load(), date="2026-10-10")
    expected = {
        "date": "2026-10-10", "dose_step": "BREAKTHROUGH", "inhaled_pct": 100, "repeat_hits": 0,
        "peak_visual": 8.6, "time_to_peak": "1:48", "duration": "11:08", "deepest_layer": "BREAKTHROUGH",
        "beings_met": "1 · JESTER", "message": "RECEIVED", "difficult_passage": "NONE", "memory_match_pct": 77,
        "ended_early_at": None, "session_minutes": 13.4,
    }
    for k, v in expected.items():
        assert s[k] == v, (k, s[k], v)
    assert len(s["sparkline_real"]) == 36 and len(s["sparkline_you"]) == 36
    assert set(s["sparkline_real"] + s["sparkline_you"]) <= set(SPARK)
    assert s["box"][1] == "║ SESSION COMPLETE · SIMULATED    2026-10-10 ║"
    assert s["box"][3] == "║ DOSE STEP ................... BREAKTHROUGH ║"
    assert s["box"][6] == "║ PEAK INTENSITY .................. 8.6 / 10 ║"
    assert s["box"][10] == "║ BEINGS MET .................... 1 · JESTER ║"
    assert s["box"][13] == "║ MEMORY MATCH ......................... 77% ║"


def test_box_width_46_every_line():
    s = compute_stats(*_load(), date="2026-10-10")
    assert len(s["box"]) == 15
    for line in s["box"]:
        assert len(line) == 46, line
    # extreme values still fit
    worst = dict(s, dose_step="BREAKTHROUGH", beings_met="12 · LIVING GEOMETRY", difficult_passage="RESOLVED IN 1:30",
                 deepest_layer="FORM CONSTANTS", memory_match_pct=None, peak_visual=10.0)
    for line in make_box(worst):
        assert len(line) == 46, line


def test_memory_match_identical_and_far():
    ts, events, _, intake = _load()
    real = [[e["t_min"], e["payload"]["visual"]] for e in events if e["type"] == "intensity_sample"]
    assert compute_stats(ts, events, {"points": real}, intake)["memory_match_pct"] == 100
    far = [[t, v + 1.6] if v < 8.4 else [t, v - 1.6] for t, v in real]
    assert compute_stats(ts, events, {"points": far}, intake)["memory_match_pct"] == 0
    assert compute_stats(ts, events, None, intake)["memory_match_pct"] is None


def test_variants_escape_challenge_gentle_repeat():
    ts, events, curve, intake = _load()
    ev = [e for e in events if e["type"] != "session_end"]
    ev += [{"t_min": 2.0, "type": "challenge_start", "payload": {"flavour": "pressure"}},
           {"t_min": 2.75, "type": "challenge_resolve", "payload": {"duration_s": 45}},
           {"t_min": 6.0, "type": "hit", "payload": {"dose_step": "breakthrough", "dose_rel": 4.0, "hold_fraction": 1.0, "n": 1}},
           {"t_min": 5.0, "type": "hit_blocked", "payload": {"visual": 5.0}},
           {"t_min": 9.5, "type": "exit_pressed", "payload": {}},
           {"t_min": 9.55, "type": "session_end", "payload": {"reason": "escape"}}]
    s = compute_stats(ts, ev, curve, intake)
    assert s["difficult_passage"] == "RESOLVED IN 0:45"
    assert s["repeat_hits"] == 1
    assert s["ended_early_at"] == "9:30"
    gentle = json.loads(json.dumps(intake))
    gentle["options"]["difficult_passages"] = False
    assert compute_stats(ts, events, curve, gentle)["difficult_passage"] == "GENTLE MODE"
    # partial hold, no beings, no message, shallow session
    ev2 = [e for e in events if e["type"] not in ("entity_appear", "message_shown", "layer_enter")]
    ev2[0] = dict(ev2[0], payload=dict(ev2[0]["payload"], hold_fraction=0.5))
    s2 = compute_stats(ts, ev2, curve, intake)
    assert s2["beings_met"] == "NONE" and s2["message"] == "NONE" and s2["inhaled_pct"] == 50
    assert s2["deepest_layer"] == "ONSET"


def test_mmss():
    assert mmss(1.8) == "1:48" and mmss(11.1) == "11:06" and mmss(0) == "0:00" and mmss(15.0) == "15:00"
