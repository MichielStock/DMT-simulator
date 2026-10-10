"""Planner stage two (BUILD.md §9.2, §9.3): texture for the skeleton, by language model or phrase banks.

`expand(skeleton, intake, seed)` → expansion dict valid against shared/schemas/expansion.schema.json.
`assemble_trip_script(skeleton, expansion, intake, session_dir)` → trip_script.json (§6.2).
"""
from __future__ import annotations

import copy
import json
import logging
from functools import lru_cache
from pathlib import Path

import jsonschema
import numpy as np
import yaml

from backend import llm, runtime
from backend.safety.content import CONTENT_LIMITS, check_obj

log = logging.getLogger("hyperspace.planner")

HERE = Path(__file__).resolve().parent
SCHEMAS = runtime.ROOT / "shared" / "schemas"
TEMPLATES = HERE / "templates"
MAX_TRIES = 3


@lru_cache(maxsize=8)
def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=8)
def bank(name: str) -> dict:
    return yaml.safe_load((TEMPLATES / f"{name}.yaml").read_text(encoding="utf-8"))


def system_prompt() -> str:
    return (HERE / "prompts" / "expand_system.txt").read_text(encoding="utf-8").replace("{CONTENT_LIMITS}", CONTENT_LIMITS)


def _rng(seed: int, k: int) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFFFFFF, 7700 + k]))


def _pick(rng: np.random.Generator, items: list):
    return items[int(rng.integers(len(items)))]


def _entities(skeleton: dict) -> list[dict]:
    return (skeleton.get("breakthrough") or {}).get("entities") or []


def _message(skeleton: dict) -> dict:
    return (skeleton.get("breakthrough") or {}).get("message") or {"present": False, "theme": "wonder"}


# --------------------------------------------------------------------------- template path

def template_expansion(skeleton: dict, intake: dict | None, seed: int) -> dict:
    rng = _rng(seed, 1)
    wb, eb, bb, mb, sb = bank("worlds"), bank("entities"), bank("behaviours"), bank("messages"), bank("summaries")
    category = skeleton["breakthrough"]["world"]["category"]
    colours = wb["palette_words"].get(skeleton["palette"]["name"], "jewel tones")
    cat = wb["categories"][category]
    idx = rng.permutation(len(cat["prompts"]))[: int(rng.integers(2, 4))]
    world_prompts = [cat["prompts"][int(i)].format(colours=colours, style=wb["style"]) for i in idx]
    world_description = _pick(rng, cat["descriptions"])

    ents = []
    for k, ent in enumerate(_entities(skeleton)):
        tb = eb["types"][ent["type"]]
        base = _pick(rng, tb["prompts"]).format(colours=colours)
        prompts = [f"{base}, {v}, {eb['background']}" for v in tb["variants"]]
        beats = []
        for b in ent.get("beats") or [{"behaviour": x, "at_s": 8.0 * j} for j, x in enumerate(ent["behaviours"])]:
            beats.append({"behaviour": b["behaviour"], "at_s": round(min(120.0, float(b["at_s"])), 2),
                          "note": _pick(rng, bb[b["behaviour"]])})
        ents.append({"entity_index": k, "appearance": _pick(rng, tb["appearance"]), "prompts": prompts, "beats": beats[:8]})

    msg = _message(skeleton)
    theme = msg.get("theme") or "wonder"
    sealed = _pick(rng, mb[theme]) if msg.get("present") else ""

    exp = {"world_prompts": world_prompts, "world_description": world_description, "entities": ents,
           "sealed_message": sealed, "message_theme": theme}
    exp["private_summary"] = summary_text(skeleton, exp, rng)
    return exp


def summary_text(skeleton: dict, exp: dict, rng: np.random.Generator) -> str:
    sb = bank("summaries")
    ents = _entities(skeleton)
    comm = {"entity_to_user": "towards the viewer", "two_way": "both ways", "user_to_entity": "only by listening",
            "none": "without clear signals"}
    if not ents:
        beings = sb["beings_none"]
    elif len(ents) == 1:
        e = ents[0]
        beings = sb["beings_one"].format(type=e["type"].replace("_", " "), disposition=e["disposition"],
                                         communication=comm.get(e["communication"], "in glyphs"))
    else:
        e = ents[0]
        beings = sb["beings_many"].format(n=len(ents), type=e["type"].replace("_", " "), disposition=e["disposition"],
                                          communication=comm.get(e["communication"], "in glyphs"))
    msg = _message(skeleton)
    message = sb["message_yes"].format(theme=exp.get("message_theme", "wonder")) if msg.get("present") else sb["message_no"]
    ch = skeleton.get("challenge") or {}
    challenge = sb["challenge_yes"].format(flavour=ch.get("flavour")) if ch.get("occurs") else sb["challenge_no"]
    t = _pick(rng, sb["templates"])
    return t.format(step=skeleton["pharmacology"]["dose_step"], world=exp["world_description"], beings=beings,
                    message=message, challenge=challenge)[:800]


# --------------------------------------------------------------------------- language-model path

def _skeleton_for_prompt(skeleton: dict, simple: bool = False) -> dict:
    ents = _entities(skeleton)
    msg = _message(skeleton)
    d = {
        "world_category": skeleton["breakthrough"]["world"]["category"],
        "palette": skeleton["palette"]["name"],
        "beings": [{"entity_index": k, "type": e["type"], "label": e["label"], "disposition": e["disposition"],
                    "communication": e["communication"],
                    "beats": [{"behaviour": b["behaviour"], "at_s": b["at_s"]} for b in e.get("beats", [])]}
                   for k, e in enumerate(ents)],
        "message": {"present": bool(msg.get("present")), "theme": msg.get("theme")},
    }
    if not simple:
        d["dose_step"] = skeleton["pharmacology"]["dose_step"]
        ch = skeleton.get("challenge") or {}
        d["difficult_passage"] = ch.get("flavour") if ch.get("occurs") else None
    return d


def user_prompt(skeleton: dict, simple: bool = False) -> str:
    sk = json.dumps(_skeleton_for_prompt(skeleton, simple), indent=1)
    n = len(_entities(skeleton))
    if simple:
        return (f"Skeleton:\n{sk}\n\nWrite the JSON. One entities item per being ({n} items, same order, same beats). "
                "Three short prompts per being on a plain dark background. sealed_message is an empty string if message.present is false.")
    return (
        f"Session skeleton (fixed; do not change it):\n{sk}\n\n"
        f"Write: 2 or 3 world_prompts for the world category; a one-sentence world_description in plain words; "
        f"exactly {n} entities items (entity_index 0..{max(n - 1, 0)}, same order as the beings), each with a one-sentence "
        f"appearance, exactly three image prompt variants on a plain dark background, and one beat per skeleton beat "
        f"(same behaviour and at_s, plus a short note); sealed_message: one or two short abstract sentences on the theme "
        f"'{_message(skeleton).get('theme')}' if message.present is true, otherwise an empty string; message_theme: the skeleton's theme; "
        f"private_summary: two to four sentences for the report writer."
    )


def _repair(skeleton: dict, exp: dict, seed: int) -> dict:
    """Make an LLM expansion consistent with the skeleton (entity count, beat behaviours, theme)."""
    exp = copy.deepcopy(exp)
    tmpl = template_expansion(skeleton, None, seed)
    ents = _entities(skeleton)
    got = {e.get("entity_index"): e for e in exp.get("entities", []) if isinstance(e, dict)}
    fixed = []
    for k, ent in enumerate(ents):
        e = got.get(k) or (exp.get("entities", [])[k] if k < len(exp.get("entities", [])) else None) or tmpl["entities"][k]
        e = dict(e)
        e["entity_index"] = k
        notes = {b.get("behaviour"): b.get("note", "") for b in e.get("beats", []) if isinstance(b, dict)}
        e["beats"] = [{"behaviour": tb["behaviour"], "at_s": tb["at_s"],
                       "note": (notes.get(tb["behaviour"]) or tb["note"])[:200]} for tb in tmpl["entities"][k]["beats"]]
        if not isinstance(e.get("prompts"), list) or len(e["prompts"]) != 3:
            e["prompts"] = tmpl["entities"][k]["prompts"]
        fixed.append(e)
    exp["entities"] = fixed
    exp["message_theme"] = _message(skeleton).get("theme") or exp.get("message_theme") or "wonder"
    if not _message(skeleton).get("present"):
        exp["sealed_message"] = ""
    elif not (exp.get("sealed_message") or "").strip():
        exp["sealed_message"] = tmpl["sealed_message"]
    return exp


def validate_expansion(exp: dict) -> list[str]:
    errs = [e.message for e in jsonschema.Draft202012Validator(load_schema("expansion")).iter_errors(exp)]
    hits = check_obj(exp)
    errs += [f"banned term: {h['term']}" for h in hits]
    return errs


def llm_expansion(skeleton: dict, intake: dict | None, seed: int, logger=None) -> dict | None:
    schema = load_schema("expansion")
    for attempt in range(MAX_TRIES):
        simple = attempt >= 1
        try:
            raw = llm.chat_json(system_prompt(), user_prompt(skeleton, simple), schema, seed=seed + attempt,
                                temperature=0.8, purpose="planner")
        except llm.LLMError as e:
            (logger or log.info)(f"expansion attempt {attempt + 1}: {e}")
            if "connect" in str(e).lower():
                return None
            continue
        exp = _repair(skeleton, raw, seed)
        errs = validate_expansion(exp)
        if not errs:
            return exp
        (logger or log.info)(f"expansion attempt {attempt + 1} rejected: {errs[:3]}")
    return None


def expand_with_provenance(skeleton: dict, intake: dict | None, seed: int, logger=None) -> tuple[dict, str]:
    if not runtime.force_templates() and llm.available():
        exp = llm_expansion(skeleton, intake, seed, logger)
        if exp is not None:
            return exp, "llm"
        runtime.note_fallback("planner: template expansion after 3 language-model attempts")
    exp = template_expansion(skeleton, intake, seed)
    errs = validate_expansion(exp)
    if errs:  # should never happen; templates are tested
        raise ValueError(f"template expansion invalid: {errs}")
    return exp, "template"


def expand(skeleton: dict, intake: dict | None, seed: int) -> dict:
    return expand_with_provenance(skeleton, intake, seed)[0]


# --------------------------------------------------------------------------- final trip script

def assemble_trip_script(skeleton: dict, expansion: dict, intake: dict | None, session_dir=None,
                         planner: str = "template") -> dict:
    sk = skeleton
    room_src = (sk.get("intake") or {}).get("room_source", "default")
    if isinstance(intake, dict) and isinstance(intake.get("room"), dict):
        room_src = intake["room"].get("source", room_src)
    if room_src in ("photo", "panorama"):
        room = {"source": room_src, "image": "assets/room.jpg", "depth": "assets/room_depth.png"}
    else:
        room = {"source": "default", "image": None, "depth": None}

    bt = sk["breakthrough"]
    ents_out = []
    exp_ents = {e["entity_index"]: e for e in expansion.get("entities", [])}
    for k, e in enumerate(bt["entities"]):
        x = exp_ents.get(k, {})
        ent = {"type": e["type"], "label": e["label"], "attributes": dict(e["attributes"]),
               "disposition": e["disposition"], "communication": e["communication"],
               "behaviours": list(e["behaviours"]), "sprites": [], "procedural": True,
               "prompts": list(x.get("prompts", []))[:3],
               "beats": [{"behaviour": b["behaviour"], "at_s": b["at_s"], "note": b.get("note", "")} for b in x.get("beats", [])],
               "appearance": x.get("appearance", ""), "labels": list(e.get("labels", [e["label"]])),
               "arrival_s": e.get("arrival_s", 10.0)}
        ents_out.append(ent)
    need_world = bool(sk["contingency"]["breakthrough_assets"] or bt["reached"] or ents_out)
    world = None
    if need_world:
        world = {"category": bt["world"]["category"], "prompt": expansion["world_prompts"][0], "image": None,
                 "images": [], "procedural": True, "prompts": list(expansion["world_prompts"]),
                 "description": expansion["world_description"]}
    msg = bt["message"]
    ch = sk["challenge"]
    pred = sk["predicted"]
    script = {
        "version": 1,
        "seed": int(sk["seed"]),
        "pharmacology": copy.deepcopy(sk["pharmacology"]),
        "predicted": {k: pred[k] for k in ("peak_visual", "deepest_layer", "minutes_above_8", "minutes_above_1", "peak_time_min") if k in pred},
        "palette": copy.deepcopy(sk["palette"]),
        "room": room,
        "layers": copy.deepcopy(sk["layers"]),
        "breakthrough": {
            "reached": bool(bt["reached"]),
            "world": world,
            "entities": ents_out,
            "message": {"present": bool(msg["present"]), "sealed_text": expansion["sealed_message"] if msg["present"] else None,
                        "glyph_seed": int(msg["glyph_seed"]), "theme": expansion.get("message_theme", msg.get("theme"))},
        },
        "challenge": {"occurs": bool(ch["occurs"]), "onset_offset_s": ch["onset_offset_s"], "flavour": ch["flavour"]},
        "report": {"length_words": int(sk["report"]["length_words"]), "profundity": bool(sk["report"]["profundity"]),
                   "private_summary": expansion["private_summary"]},
        "contingency": {"breakthrough_assets": bool(sk["contingency"]["breakthrough_assets"])},
        "provenance": {"planner": planner, "images": "procedural"},
        "encounter": {"occurs": bool(sk["encounter"]["occurs"]), "contingent": bool(sk["encounter"]["contingent"]),
                      "layer": sk["encounter"]["layer"]},
        "gentle": bool((sk.get("challenge") or {}).get("gentle", False)),
    }
    return script


def validate_trip_script(script: dict) -> list[str]:
    return [f"{list(e.path)}: {e.message}" for e in jsonschema.Draft202012Validator(load_schema("trip_script")).iter_errors(script)]
