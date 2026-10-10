"""Memory model (BUILD.md §13.3)."""
from pathlib import Path

from backend.report.memory_model import A, B, C, recall_probability, remember, score_events
from backend.report.pipeline import load_events

FIX = Path(__file__).resolve().parent / "fixtures" / "example_session"


def test_constants():
    assert (A, B, C) == (1.0, 0.35, 1.2)


def test_recall_decreases_with_intensity():
    for sal in (0.2, 0.8, 1.5, 2.5):
        ps = [recall_probability(v, sal) for v in range(0, 11)]
        assert all(a > b for a, b in zip(ps, ps[1:]))
    assert recall_probability(9, 1.0) < recall_probability(1, 1.0)


def test_top3_always_kept_over_200_seeds():
    events = load_events(FIX)
    cands = score_events(events)
    top = sorted(cands, key=lambda c: (-c["salience"], c["t_min"]))[:3]
    top_ids = {c["id"] for c in top}
    assert len(top_ids) == 3
    shuffled_any = False
    for seed in range(200):
        r = remember(events, seed)
        ids = {x["id"] for x in r["remembered"]}
        assert top_ids <= ids
        assert {x["id"] for x in r["remembered"] if x["vivid"]} == top_ids
        shuffled_any |= r["shuffled"]
    assert shuffled_any  # events above v = 7 come back in shuffled order for some seeds


def test_shuffle_only_above_7_and_gaps():
    events = load_events(FIX)
    r = remember(events, 3)
    low = [x for x in r["remembered"] if x["v"] <= 7]
    # events at or below v = 7 keep chronological order
    assert [x["t_min"] for x in low] == sorted(x["t_min"] for x in low)
    assert all(x["v"] > 7 for x in r["remembered"] if x["shuffled"])
    for g in r["gaps"]:
        assert g["end_min"] - g["start_min"] > 0.75
    assert remember(events, 3) == r  # seeded


def test_salience_components():
    events = load_events(FIX)
    cands = {c["type"]: c for c in score_events(events)}
    assert cands["message_shown"]["salience"] > cands["layer_exit"]["salience"]
    assert "intensity_sample" not in cands and "frame_captured" not in cands
