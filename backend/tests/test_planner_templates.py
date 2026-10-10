"""Template planner path (BUILD.md §9.3): complete, schema-valid, clean, with HYPERSPACE_FORCE_TEMPLATES=1."""
import json
from pathlib import Path

import jsonschema
import pytest
import yaml

from backend.planner import expand as E
from backend.planner.sampler import sample_skeleton
from backend.safety.content import check_obj, check_text

ROOT = Path(__file__).resolve().parents[2]
DOSES = ["threshold", "light", "strong", "breakthrough"]


@pytest.fixture(autouse=True)
def _force(monkeypatch):
    monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")


def _schema(n):
    return json.loads((ROOT / "shared" / "schemas" / f"{n}.schema.json").read_text())


def _intake(seed, dose, exp=()):
    return {"room": {"source": "photo" if seed % 2 else "default"},
            "answers": {"clarity": seed % 11, "set": (seed % 11) - 5, "absorption": [5, 5, 5], "surrender": 5,
                        "intention": "curiosity", "expectations": list(exp)},
            "dose_step": dose, "hold_fraction": 1.0,
            "options": {"difficult_passages": seed % 3 != 0, "eyes": "auto", "audio": True, "microphone": False,
                        "live_diffusion": False}, "seed": seed}


def test_expansion_valid_and_clean_20_seeds():
    schema = _schema("expansion")
    for seed in range(20):
        dose = DOSES[seed % 4] if seed % 2 else "breakthrough"
        intake = _intake(seed, dose, ["jesters"] if seed % 5 == 0 else [])
        sk = sample_skeleton(intake, seed)
        exp, prov = E.expand_with_provenance(sk, intake, seed)
        assert prov == "template"
        jsonschema.validate(exp, schema)
        assert check_obj(exp) == [], check_obj(exp)
        assert len(exp["entities"]) == len(sk["breakthrough"]["entities"])
        for k, (x, ent) in enumerate(zip(exp["entities"], sk["breakthrough"]["entities"])):
            assert x["entity_index"] == k and len(x["prompts"]) == 3
            assert [b["behaviour"] for b in x["beats"]] == ent["behaviours"]
            assert all("dark background" in p and "no text" in p for p in x["prompts"])
        assert bool(exp["sealed_message"]) == sk["breakthrough"]["message"]["present"]
        assert exp == E.expand(sk, intake, seed)  # seeded


def test_assembled_trip_scripts_validate():
    schema = _schema("trip_script")
    for seed in range(40):
        intake = _intake(seed, DOSES[seed % 4])
        sk = sample_skeleton(intake, seed)
        exp = E.expand(sk, intake, seed)
        ts = E.assemble_trip_script(sk, exp, intake, None, planner="template")
        jsonschema.validate(ts, schema)
        assert ts["provenance"] == {"planner": "template", "images": "procedural"}
        assert ts["room"]["source"] == intake["room"]["source"]
        if not intake["options"]["difficult_passages"]:
            assert ts["challenge"]["occurs"] is False
        for ent in ts["breakthrough"]["entities"]:
            assert ent["procedural"] is True and ent["sprites"] == []


def test_phrase_banks_sizes_and_clean():
    tdir = ROOT / "backend" / "planner" / "templates"
    worlds = yaml.safe_load((tdir / "worlds.yaml").read_text())
    ents = yaml.safe_load((tdir / "entities.yaml").read_text())
    msgs = yaml.safe_load((tdir / "messages.yaml").read_text())
    beh = yaml.safe_load((tdir / "behaviours.yaml").read_text())
    for cat in ["geometric_chamber", "dome_temple", "infinite_hall", "workshop", "organic_jungle", "cosmic_space", "carnival"]:
        assert len(worlds["categories"][cat]["prompts"]) >= 6
    for t in ["luminous_feminine", "deity", "alien", "creature_reptilian", "creature_tentacled", "creature_insectoid",
              "creature_feline", "machine_elf", "mythological", "jester", "living_geometry"]:
        assert len(ents["types"][t]["prompts"]) >= 6 and len(ents["types"][t]["variants"]) == 3
    for b in ["approach", "greet", "present_object", "show", "work_on", "transform", "depart"]:
        assert len(beh[b]) >= 3
    assert set(msgs) == {"attention", "play", "care", "curiosity", "wonder"}
    all_msgs = [m for v in msgs.values() for m in v]
    assert len(all_msgs) >= 30
    imperative = ("look", "listen", "remember", "go", "be", "stop", "take", "let", "trust", "try", "find", "keep", "come")
    for m in all_msgs:
        assert check_text(m) == [], m
        assert m.split()[0].lower().strip(",.") not in imperative, m  # never an instruction
        assert " you " not in f" {m.lower()} " and "will" not in m.lower().split(), m  # no address, no prediction
        assert len(m) <= 240
    for f in tdir.glob("*.yaml"):
        assert check_obj(yaml.safe_load(f.read_text())) == [], f


def test_system_prompt_has_content_limits():
    sp = E.system_prompt()
    from backend.safety.content import CONTENT_LIMITS

    assert CONTENT_LIMITS in sp
    for phrase in ("self-luminous", "jewelled", "intricate", "hyper-saturated", "alive",
                   "more dimensions than it should have", "no text", "plain dark background"):
        assert phrase in sp, phrase
