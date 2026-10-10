"""Regenerate backend/tests/fixtures/example_session/ (fixed example session used by the stats tests on both
sides). Breakthrough step, sensitivity and clearance 1, one jester with a message, no difficult passage.
Run: uv run python -m backend.tests.fixtures.make_example_session
"""
import json
from pathlib import Path

from backend.batch.synth import synthesise_events
from backend.pharmacology import deepest_layer, simulate, summarise
from backend.planner.expand import assemble_trip_script, template_expansion, validate_trip_script
from backend.planner.sampler import sample_skeleton

OUT = Path(__file__).resolve().parent / "example_session"
SEED = 20261010

INTAKE = {"version": 1, "room": {"source": "photo", "image": "assets/room.jpg", "depth": "assets/room_depth.png"},
          "answers": {"clarity": 5, "set": 0, "absorption": [5, 5, 5], "surrender": 5, "intention": "curiosity",
                      "expectations": []},
          "dose_step": "breakthrough", "hold_fraction": 1.0,
          "options": {"difficult_passages": True, "eyes": "auto", "audio": True, "microphone": False, "live_diffusion": False},
          "seed": SEED}


def build():
    sk = sample_skeleton(INTAKE, SEED)
    sk["pharmacology"].update(sensitivity=1.0, clearance=1.0)
    ts, _, I = simulate(4.0)
    s = summarise(ts, I)
    sk["predicted"] = {"peak_visual": round(s["peak_visual"], 3), "deepest_layer": deepest_layer(s["peak_visual"]),
                       "minutes_above_8": round(s["minutes_above_8"], 3), "peak_time_min": round(s["peak_time_min"], 4),
                       "minutes_above_1": round(s["minutes_above_1"], 3)}
    sk["encounter"].update(occurs=True, contingent=False, layer="breakthrough")
    sk["breakthrough"]["reached"] = True
    ent = {"type": "jester", "label": "guide", "labels": ["being", "guide"],
           "attributes": {"conscious": True, "intelligent": True, "benevolent": True, "sacred": False, "agency": True},
           "disposition": "playful", "communication": "two_way",
           "behaviours": ["approach", "greet", "present_object", "transform", "depart"], "arrival_s": 12.0,
           "beats": [{"behaviour": "approach", "at_s": 0.0, "duration_s": 6.0}, {"behaviour": "greet", "at_s": 6.0, "duration_s": 5.0},
                     {"behaviour": "present_object", "at_s": 11.0, "duration_s": 9.0},
                     {"behaviour": "transform", "at_s": 20.0, "duration_s": 8.0}, {"behaviour": "depart", "at_s": 28.0, "duration_s": 7.0}]}
    sk["breakthrough"]["entities"] = [ent]
    sk["breakthrough"]["world"] = {"category": "carnival"}
    sk["breakthrough"]["message"].update(present=True, theme="play", glyph_seed=42)
    sk["challenge"] = {"occurs": False, "onset_offset_s": None, "flavour": None, "p": 0.27, "gentle": False}
    sk["report"] = {"length_words": 311, "profundity": False}
    exp = template_expansion(sk, INTAKE, SEED)
    script = assemble_trip_script(sk, exp, INTAKE, None, planner="template")
    assert not validate_trip_script(script), validate_trip_script(script)
    events = synthesise_events(script)
    # the remembered curve: identical to the real one for the first half, then 2 points lower
    real = [[e["t_min"], e["payload"]["visual"]] for e in events if e["type"] == "intensity_sample"]
    t_mid = real[-1][0] / 2
    curve = {"points": [[t, round(v if t <= t_mid else max(0.0, v - 2.0), 4)] for t, v in real[::12]]}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "trip_script.json").write_text(json.dumps(script, indent=1))
    (OUT / "intake.json").write_text(json.dumps(INTAKE, indent=1))
    (OUT / "curve.json").write_text(json.dumps(curve))
    with open(OUT / "event_log.jsonl", "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    return script, events, curve


if __name__ == "__main__":
    build()
    print("written", OUT)
