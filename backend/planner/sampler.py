"""Planner stage one: sampling the trip skeleton from published priors (BUILD.md §9.1).

`sample_skeleton(intake, seed)` is pure and deterministic for a seed. Each section draws from its own
numpy Generator (SeedSequence([seed, section])) so changing one section never shifts another.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import numpy as np
import yaml

from backend.intake_util import expectation_types, gentle, normalise
from backend.pharmacology import LAYER_ORDER, deepest_layer, summarise
from backend.planner.fastpk import simulate_fast

PRIORS_PATH = Path(__file__).with_name("priors.yaml")

SECTIONS = ["pharmacology", "palette", "layers", "encounter", "entities", "message", "world",
            "challenge", "report", "contingency"]


@lru_cache(maxsize=1)
def load_priors() -> dict:
    return yaml.safe_load(PRIORS_PATH.read_text(encoding="utf-8"))


def _rng(seed: int, section: str) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFFFFFF, SECTIONS.index(section)]))


def _choice(rng: np.random.Generator, weights: dict):
    keys = list(weights)
    w = np.array([float(weights[k]) for k in keys])
    return keys[int(rng.choice(len(keys), p=w / w.sum()))]


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


# --------------------------------------------------------------------------- formulas exported for tests

def difficult_probability(peak: float, set_: float = 0.0, surrender: float = 5.0,
                          intention: str = "curiosity", gentle: bool = False) -> float:
    """BUILD.md §9.1 item 12, exactly:
    p = σ(−2.2 + 0.35·(peak − 5) − 0.25·set − 0.15·(surrender − 5) − 0.5·[intention = recreation]); 0 in gentle mode."""
    if gentle:
        return 0.0
    c = load_priors()["challenge"]
    x = (c["intercept"] + c["peak_coef"] * (peak - 5.0) + c["set_coef"] * set_
         + c["surrender_coef"] * (surrender - 5.0) + c["recreation_coef"] * (1.0 if intention == "recreation" else 0.0))
    return sigmoid(x)


def entity_type_table(expectations: list[str] | None = None) -> dict[str, float]:
    """Entity-type probabilities (Lawrence et al. 2022 shares) × 1.5 per matching expectation, renormalised."""
    pr = load_priors()
    w = {k: float(v) for k, v in pr["entity_types"].items()}
    for t in expectations or []:
        if t in w:
            w[t] *= pr["expectation_multiplier"]
    s = sum(w.values())
    return {k: v / s for k, v in w.items()}


def message_probability(clarity: float) -> float:
    m = load_priors()["message"]
    return float(np.clip(m["p"] + m["clarity_slope"] * (clarity - 5.0) / 5.0, m["p_min"], m["p_max"]))


def profundity_probability(breakthrough: bool) -> float:
    """Base rate chosen so that the overall rate under the §14 dose mix equals 6.1%."""
    r = load_priors()["report"]
    share = sum(r["dose_mix"][k] * r["breakthrough_share_by_dose"][k] for k in r["dose_mix"])
    base = r["profundity_overall"] / (r["profundity_weight_breakthrough"] * share + r["profundity_weight_other"] * (1 - share))
    return base * (r["profundity_weight_breakthrough"] if breakthrough else r["profundity_weight_other"])


def encounter_probability(layer: str) -> float:
    return float(load_priors()["encounter"]["by_deepest_layer"].get(layer, 0.0))


# --------------------------------------------------------------------------- section samplers

def sample_pharmacology(norm: dict, seed: int) -> tuple[dict, dict]:
    pr = load_priors()["pharmacology"]
    rng = _rng(seed, "pharmacology")
    step = norm["dose_step"] if norm["dose_step"] in pr["dose_steps"] else "strong"
    sens = float(rng.lognormal(0.0, pr["sensitivity_sigma"]))
    clear = float(rng.lognormal(0.0, pr["clearance_sigma"]))
    hold = float(norm["hold_fraction"])
    dose_rel = pr["dose_steps"][step] * hold
    ts, _, I = simulate_fast(dose_rel, sens, clear)
    s = summarise(ts, I)
    pharm = {"dose_step": step, "dose_rel": round(dose_rel, 6), "hold_fraction": round(hold, 6),
             "sensitivity": round(sens, 6), "clearance": round(clear, 6),
             "params": {k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in pr["params"].items()}}
    predicted = {"peak_visual": round(s["peak_visual"], 3), "deepest_layer": deepest_layer(s["peak_visual"]),
                 "minutes_above_8": round(s["minutes_above_8"], 3), "peak_time_min": round(s["peak_time_min"], 4),
                 "minutes_above_1": round(s["minutes_above_1"], 3)}
    return pharm, predicted


def sample_palette(seed: int) -> dict:
    pr = load_priors()
    name = _choice(_rng(seed, "palette"), pr["palette_weights"])
    return {"name": name, "colours": list(pr["palettes"][name])}


def sample_layers(seed: int) -> dict:
    pr = load_priors()
    rng = _rng(seed, "layers")
    fc = pr["form_constants"]
    ch = pr["chrysanthemum"]
    idx = rng.choice(len(ch["groups"]), size=ch["n_groups"], replace=False)
    lo, hi = ch["kleinian_trace_real"]
    ilo, ihi = ch["kleinian_trace_imag"]
    return {
        "form_constants": {"mode": _choice(rng, fc["modes"]),
                           "wavelength": round(float(rng.uniform(*fc["wavelength"])), 4),
                           "spiral_bias": round(float(rng.uniform(*fc["spiral_bias"])), 4)},
        "chrysanthemum": {"groups": [list(ch["groups"][int(i)]) for i in idx],
                          "kleinian": {"trace_a": [round(float(rng.uniform(lo, hi)), 4), round(float(rng.uniform(ilo, ihi)), 4)],
                                       "trace_b": [round(float(rng.uniform(lo, hi)), 4), round(float(rng.uniform(ilo, ihi)), 4)]}},
        "waiting_room": {"kind": _choice(rng, pr["waiting_room"]["kinds"])},
    }


def sample_entity_count(rng: np.random.Generator) -> int:
    ec = load_priors()["entity_count"]
    kind = _choice(rng, {"one": ec["one"], "few": ec["few"], "many": ec["many"]})
    if kind == "one":
        return 1
    if kind == "few":
        return int(rng.integers(2, 4))
    return int(ec["many_count"])


def sample_behaviours(rng: np.random.Generator, disposition: str) -> tuple[list[str], list[dict]]:
    b = load_priors()["behaviours"]
    seq = ["approach"]
    for name in ("greet", "present_object", "show", "work_on", "transform"):
        p = b["optional_p"][name]
        if name == "work_on" and disposition == "indifferent":
            p = b["work_on_if_indifferent"]
        if rng.random() < p:
            seq.append(name)
    seq.append("depart")
    arrival = float(rng.uniform(*b["arrival_delay_s"]))
    t = 0.0
    beats = []
    for name in seq:
        d = float(rng.uniform(*b["beat_duration_s"][name]))
        beats.append({"behaviour": name, "at_s": round(t, 2), "duration_s": round(d, 2)})
        t += d
    beats[0]["arrival_s"] = round(arrival, 2)
    return seq, beats


def sample_entity(rng: np.random.Generator, type_table: dict) -> dict:
    pr = load_priors()
    etype = _choice(rng, type_table)
    labels = [k for k, p in pr["labels"].items() if rng.random() < p]
    if not labels:
        labels = ["being"]
    label = labels[int(rng.integers(len(labels)))]
    attributes = {k: bool(rng.random() < p) for k, p in pr["attributes"].items()}
    d = pr["disposition"]
    if attributes["benevolent"]:
        disposition = _choice(rng, d["if_benevolent"])
        if disposition == "benevolent" and etype in d["playful_types"] and rng.random() < d["playful_swap_p"]:
            disposition = "playful"
    else:
        disposition = _choice(rng, d["if_not_benevolent"])
    communication = _choice(rng, pr["communication"])
    behaviours, beats = sample_behaviours(rng, disposition)
    arrival = beats[0].pop("arrival_s")
    return {"type": etype, "label": label, "labels": labels, "attributes": attributes,
            "disposition": disposition, "communication": communication,
            "behaviours": behaviours, "beats": beats, "arrival_s": arrival}


def sample_entities(rng: np.random.Generator, norm: dict) -> list[dict]:
    table = entity_type_table(expectation_types(norm))
    return [sample_entity(rng, table) for _ in range(sample_entity_count(rng))]


def sample_world(seed: int, first_type: str | None) -> dict:
    pr = load_priors()
    w = dict(pr["world_categories"])
    for cat, mult in (pr["world_affinity"].get(first_type) or {}).items():
        w[cat] = w[cat] * mult
    return {"category": _choice(_rng(seed, "world"), w)}


MESSAGE_THEMES = ["attention", "play", "care", "curiosity", "wonder"]


def sample_message(rng: np.random.Generator, clarity: float, has_entities: bool) -> dict:
    """Message present with p = 0.69 scaled by clarity (Davis et al. 2020), only when beings are planned."""
    present = bool(rng.random() < message_probability(clarity)) and has_entities
    return {"present": present, "glyph_seed": int(rng.integers(1, 2**31 - 1)),
            "theme": MESSAGE_THEMES[int(rng.integers(len(MESSAGE_THEMES)))]}


def sample_skeleton(intake: dict | None, seed: int) -> dict:
    """Stage one (BUILD.md §9.1). Returns a plain dict; `expand.assemble_trip_script` turns it into trip_script.json."""
    seed = int(seed)
    pr = load_priors()
    norm = normalise(intake)
    pharm, predicted = sample_pharmacology(norm, seed)
    layer = predicted["deepest_layer"]
    step = pharm["dose_step"]
    contingency = step in pr["contingency"]["breakthrough_asset_steps"]

    # encounter, conditional on the predicted deepest layer (Michael et al. 2021)
    rng_e = _rng(seed, "encounter")
    p_enc = encounter_probability(layer)
    occurs = bool(rng_e.random() < p_enc)
    # contingency: a repeat hit can still reach breakthrough; plan beings for that case (BUILD.md §7.5)
    contingent = False
    if not occurs and contingency and layer != "breakthrough":
        contingent = bool(rng_e.random() < pr["encounter"]["contingency_p"])
    entities = sample_entities(_rng(seed, "entities"), norm) if (occurs or contingent) else []

    message = sample_message(_rng(seed, "message"), norm["clarity"], bool(entities))

    world = sample_world(seed, entities[0]["type"] if entities else None)

    rng_c = _rng(seed, "challenge")
    is_gentle = gentle(norm)
    p_ch = difficult_probability(predicted["peak_visual"], norm["set"], norm["surrender"], norm["intention"], is_gentle)
    ch_occurs = bool(rng_c.random() < p_ch)
    lo, hi = pr["challenge"]["onset_after_peak_s"]
    onset = round(float(rng_c.uniform(lo, hi)), 1)  # seconds after the predicted peak (trip_script schema)
    flavour = _choice(rng_c, pr["challenge"]["flavours"])
    challenge = {"occurs": ch_occurs, "onset_offset_s": onset if ch_occurs else None,
                 "flavour": flavour if ch_occurs else None, "p": round(p_ch, 6), "gentle": is_gentle}

    r = pr["report"]
    rng_r = _rng(seed, "report")
    length = float(rng_r.lognormal(math.log(r["length_median_words"]), r["length_sigma"]))
    length = int(round(min(max(length, r["length_min"]), r["length_max"])))
    profundity = bool(rng_r.random() < profundity_probability(layer == "breakthrough"))

    return {
        "version": 1,
        "seed": seed,
        "intake": norm,
        "pharmacology": pharm,
        "predicted": predicted,
        "palette": sample_palette(seed),
        "layers": sample_layers(seed),
        "encounter": {"occurs": occurs, "contingent": contingent, "p": p_enc, "layer": layer},
        "breakthrough": {"reached": layer == "breakthrough", "world": world, "entities": entities, "message": message},
        "challenge": challenge,
        "report": {"length_words": length, "profundity": profundity},
        "contingency": {"breakthrough_assets": contingency},
    }


__all__ = ["sample_skeleton", "difficult_probability", "entity_type_table", "message_probability",
           "profundity_probability", "encounter_probability", "load_priors", "sample_entities",
           "sample_entity", "sample_entity_count", "sample_message", "LAYER_ORDER", "MESSAGE_THEMES"]
