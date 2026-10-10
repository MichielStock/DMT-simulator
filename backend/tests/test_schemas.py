"""Contract tests (BUILD.md §6, CONTRACTS.md): every schema is valid draft 2020-12, every example and
e2e profile validates, and the examples together exercise every enum value of the schemas."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from backend.pharmacology import DOSES, deepest_layer, simulate, summarise

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "shared" / "schemas"
PROFILES = ROOT / "tests" / "e2e" / "profiles"
NAMES = ["intake", "trip_script", "event_log", "expansion"]

# Enum paths deliberately not required to be covered by examples (reason in the comment).
COVERAGE_EXEMPT = {
    ("expansion", "message_theme"),  # five themes would need five full expansion examples
}


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text())


def example_files(name: str) -> list[Path]:
    files = sorted(SCHEMAS.glob(f"{name}.example*.json")) + sorted(SCHEMAS.glob(f"{name}.example*.jsonl"))
    assert files, f"no examples for {name}"
    return files


def load_instances(name: str) -> list[tuple[str, dict]]:
    out = []
    for f in example_files(name):
        if f.suffix == ".jsonl":
            lines = [ln for ln in f.read_text().splitlines() if ln.strip()]
            out += [(f"{f.name}:{i + 1}", json.loads(ln)) for i, ln in enumerate(lines)]
        else:
            out.append((f.name, json.loads(f.read_text())))
    if name == "intake":
        out += [(f"profiles/{p.name}", json.loads(p.read_text())) for p in sorted(PROFILES.glob("*.json"))]
    return out


def validator(name: str) -> Draft202012Validator:
    schema = load_schema(name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@pytest.mark.parametrize("name", NAMES)
def test_schema_is_valid_draft_2020_12(name):
    schema = load_schema(name)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("name", NAMES)
def test_examples_validate(name):
    v = validator(name)
    for label, inst in load_instances(name):
        errors = sorted(v.iter_errors(inst), key=lambda e: list(e.path))
        assert not errors, f"{label}: " + "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:5])


def test_profiles_present_and_valid():
    v = validator("intake")
    neutral = json.loads((PROFILES / "neutral.json").read_text())
    gentle = json.loads((PROFILES / "gentle.json").read_text())
    v.validate(neutral)
    v.validate(gentle)
    a = neutral["answers"]
    assert (a["clarity"], a["set"], a["absorption"], a["surrender"], a["intention"], a["expectations"]) == \
        (5, 0, [5, 5, 5], 5, "curiosity", [])
    assert neutral["room"]["source"] == "default" and neutral["dose_step"] == "strong"
    o = neutral["options"]
    assert o["difficult_passages"] is True and o["eyes"] == "auto" and o["audio"] is True
    assert gentle["options"]["difficult_passages"] is False
    g = json.loads(json.dumps(gentle))
    g["options"]["difficult_passages"] = True
    assert g == neutral, "gentle.json must differ from neutral.json only in difficult_passages"


def test_invalid_instances_rejected():
    iv = validator("intake")
    good = json.loads((PROFILES / "neutral.json").read_text())
    for mutate in (lambda d: d.update(dose_step="5mg"),
                   lambda d: d["answers"].update(set=7),
                   lambda d: d["answers"].update(absorption=[5, 5]),
                   lambda d: d["options"].update(eyes="half"),
                   lambda d: d.update(extra=1)):
        bad = json.loads(json.dumps(good))
        mutate(bad)
        assert not iv.is_valid(bad)
    ev = validator("event_log")
    assert not ev.is_valid({"t_min": 1.0, "type": "teleport", "payload": {}})
    assert not ev.is_valid({"t_min": 1.0, "type": "session_end", "payload": {"reason": "bored"}})
    assert not ev.is_valid({"t_min": 1.0, "type": "layer_enter", "payload": {"layer": "formConstants"}})
    assert not ev.is_valid({"t_min": 1.0, "type": "intensity_sample", "payload": {"plasma": 1, "body": 11, "visual": 1, "auditory": 1}})
    xv = validator("expansion")
    ex = json.loads((SCHEMAS / "expansion.example.json").read_text())
    ex["entities"][0]["prompts"] = ex["entities"][0]["prompts"][:2]
    assert not xv.is_valid(ex)


def test_expansion_schema_is_simple_enough_for_an_8b_model():
    schema = load_schema("expansion")

    def keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                if k not in ("properties",):
                    yield from keys(v)
                else:
                    for sub in v.values():
                        yield from keys(sub)
        elif isinstance(node, list):
            for v in node:
                yield from keys(v)

    used = set(keys(schema))
    for kw in ("oneOf", "anyOf", "allOf", "not", "$ref", "$defs", "if", "patternProperties"):
        assert kw not in used, kw

    def walk(node, depth, path):
        if not isinstance(node, dict):
            return 0
        if path:  # every property carries a description (array item schemas are described by their parent)
            assert "description" in node, f"missing description at {path}"
        d = depth
        for k, sub in node.get("properties", {}).items():
            d = max(d, walk(sub, depth + 1, path + [k]))
        if isinstance(node.get("items"), dict):
            d = max(d, walk_items(node["items"], depth, path + ["*"]))
        return d

    def walk_items(node, depth, path):
        d = depth
        for k, sub in node.get("properties", {}).items():
            d = max(d, walk(sub, depth + 1, path + [k]))
        return d

    assert walk(schema, 0, []) <= 3


# ---------- enum coverage ----------

def _resolve(schema_root, node):
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        assert ref.startswith("#/")
        target = schema_root
        for part in ref[2:].split("/"):
            target = target[part]
        node = target
    return node


def enum_paths(schema_root, node=None, path=()):
    """Yield (path, enum values) for every enum in the schema; path uses '*' for array items."""
    node = _resolve(schema_root, schema_root if node is None else node)
    if not isinstance(node, dict):
        return
    if "enum" in node:
        yield path, node["enum"]
    for k, sub in node.get("properties", {}).items():
        yield from enum_paths(schema_root, sub, path + (k,))
    if isinstance(node.get("items"), dict):
        yield from enum_paths(schema_root, node["items"], path + ("*",))
    for sub in node.get("allOf", []):
        if "then" in sub:
            yield from enum_paths(schema_root, sub["then"], path)


def values_at(inst, path):
    if not path:
        yield inst
        return
    head, rest = path[0], path[1:]
    if head == "*":
        if isinstance(inst, list):
            for x in inst:
                yield from values_at(x, rest)
    elif isinstance(inst, dict) and head in inst:
        yield from values_at(inst[head], rest)


@pytest.mark.parametrize("name", NAMES)
def test_examples_cover_every_enum(name):
    schema = load_schema(name)
    instances = [inst for _, inst in load_instances(name)]
    missing = {}
    for path, values in enum_paths(schema):
        key = ".".join(path)
        if (name, key) in COVERAGE_EXEMPT:
            continue
        seen = set()
        for inst in instances:
            for v in values_at(inst, path):
                seen.add(json.dumps(v))
        lack = [v for v in values if json.dumps(v) not in seen]
        if lack:
            missing[key] = lack
    assert not missing, f"{name}: enum values not covered by any example: {missing}"


# ---------- semantic consistency of the trip-script examples ----------

def test_trip_script_examples_consistent_with_reference_model():
    for label, ts in load_instances("trip_script"):
        ph = ts["pharmacology"]
        assert ph["dose_rel"] == pytest.approx(DOSES[ph["dose_step"]] * ph["hold_fraction"], abs=1e-3), label
        t, _, I = simulate(ph["dose_rel"], ph["sensitivity"], ph["clearance"])
        m = summarise(t, I)
        assert ts["predicted"]["peak_visual"] == pytest.approx(m["peak_visual"], abs=0.01), label
        assert ts["predicted"]["deepest_layer"] == deepest_layer(m["peak_visual"]), label
        assert ts["predicted"]["minutes_above_8"] == pytest.approx(m["minutes_above_8"], abs=0.01), label
        assert ts["breakthrough"]["reached"] == (ts["predicted"]["deepest_layer"] == "breakthrough"), label
        if not ts["challenge"]["occurs"]:
            assert ts["challenge"]["flavour"] is None and ts["challenge"]["onset_offset_s"] is None, label
        for e in ts["breakthrough"]["entities"]:
            assert len(e["sprites"]) == (0 if e["procedural"] else 3), label


def test_no_real_dose_units_in_contract_files():
    pat = re.compile(r"\b(mg|milligram|µg|mcg|ng/ml)\b", re.I)
    for f in list(SCHEMAS.iterdir()) + list(PROFILES.glob("*.json")):
        assert not pat.search(f.read_text()), f.name
