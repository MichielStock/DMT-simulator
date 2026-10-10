"""Helpers shared by the report tests: a full synthetic session from a seed (no rendering)."""
from backend.batch.synth import synthesise_drawn_curve, synthesise_events
from backend.planner.expand import assemble_trip_script, expand_with_provenance
from backend.planner.sampler import sample_skeleton
from backend.report.memory_model import remember
from backend.report.stats import compute_stats

DOSES = ["threshold", "light", "strong", "breakthrough"]


def intake_for(seed, dose):
    return {"room": {"source": "default"},
            "answers": {"clarity": 5, "set": 0, "absorption": [5, 5, 5], "surrender": 5, "intention": "curiosity",
                        "expectations": []},
            "dose_step": dose, "hold_fraction": 1.0,
            "options": {"difficult_passages": True, "eyes": "auto", "audio": True, "microphone": False,
                        "live_diffusion": False}, "seed": seed}


def synthetic_session(seed, dose):
    intake = intake_for(seed, dose)
    sk = sample_skeleton(intake, seed)
    exp, prov = expand_with_provenance(sk, intake, seed)
    ts = assemble_trip_script(sk, exp, intake, None, planner=prov)
    events = synthesise_events(ts)
    curve = synthesise_drawn_curve(events, seed)
    rem = remember(events, seed)
    stats = compute_stats(ts, events, curve, intake, date="2026-10-10")
    return ts, intake, events, curve, rem, stats
