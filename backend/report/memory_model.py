"""Memory model (BUILD.md §13.3): which logged events the simulated person remembers.

salience  = novelty × emotional weight × layer weight
p(recall) = σ(a − b·v(t) + c·salience), a = 1.0, b = 0.35, c = 1.2  (falls with intensity)
The top 3 salient events are always kept as vivid fragments; remembered events that happened above
v = 7 come back in shuffled order (seeded). Gaps are time spans with nothing recalled; the writer fills
them and tags those sentences as inferred.
"""
from __future__ import annotations

import math

import numpy as np

A, B, C = 1.0, 0.35, 1.2
TOP_K = 3
SHUFFLE_ABOVE_V = 7.0
GAP_MIN = 0.75  # minutes without a recalled event that count as a gap

# Emotional weight per event type (design; 0 = never a memory candidate)
EMOTIONAL_WEIGHT = {
    "hit": 0.9,
    "layer_enter": 0.8,
    "layer_exit": 0.35,
    "entity_appear": 1.6,
    "entity_behaviour": 1.0,
    "message_shown": 1.8,
    "challenge_start": 1.5,
    "challenge_resolve": 1.2,
    "let_go_held": 0.7,
    "eyes_toggle": 0.3,
    "exit_pressed": 1.0,
    "hit_blocked": 0.3,
    "session_end": 0.5,
}
# Behaviour-specific emotional weights (entity_behaviour)
BEHAVIOUR_WEIGHT = {"approach": 1.0, "greet": 1.1, "present_object": 1.2, "show": 1.2,
                    "work_on": 1.3, "transform": 1.2, "depart": 0.8}
# Layer weight: how strongly the current layer imprints (design)
LAYER_WEIGHT = {"room": 0.8, "onset": 0.9, "form_constants": 1.0, "chrysanthemum": 1.1,
                "waiting_room": 1.2, "breakthrough": 1.4}
LAYER_ORDER = ["room", "form_constants", "chrysanthemum", "waiting_room", "breakthrough"]
IGNORED = {"intensity_sample", "frame_captured", "limiter_engaged"}


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def recall_probability(v: float, salience: float) -> float:
    return sigmoid(A - B * v + C * salience)


def _event_key(e: dict) -> str:
    p = e.get("payload") or {}
    t = e.get("type")
    if t in ("layer_enter", "layer_exit"):
        return f"{t}:{p.get('layer')}"
    if t == "entity_behaviour":
        return f"{t}:{p.get('behaviour')}"
    if t == "entity_appear":
        return f"{t}:{p.get('type')}"
    return str(t)


def score_events(events: list[dict]) -> list[dict]:
    """Annotate candidate events with id, v, current layer, novelty, salience and recall p."""
    evs = sorted(enumerate(events), key=lambda ie: float(ie[1].get("t_min", 0.0)))
    samples = [(float(e["t_min"]), float((e.get("payload") or {}).get("visual", 0.0)))
               for _, e in evs if e.get("type") == "intensity_sample"]
    st = np.array([s[0] for s in samples]) if samples else np.array([0.0])
    sv = np.array([s[1] for s in samples]) if samples else np.array([0.0])
    seen: dict[str, int] = {}
    active: list[str] = ["room"]
    out = []
    for idx, e in evs:
        t = e.get("type")
        p = e.get("payload") or {}
        if t == "layer_enter" and p.get("layer") in LAYER_ORDER and p.get("layer") not in active:
            active.append(p.get("layer"))
        if t in IGNORED or t not in EMOTIONAL_WEIGHT:
            if t == "layer_exit" and p.get("layer") in active:
                active.remove(p.get("layer"))
            continue
        key = _event_key(e)
        n = seen.get(key, 0)
        seen[key] = n + 1
        novelty = 1.0 / (1.0 + n)
        emo = EMOTIONAL_WEIGHT[t]
        if t == "entity_behaviour":
            emo *= BEHAVIOUR_WEIGHT.get(p.get("behaviour"), 1.0)
        cur = max(active, key=LAYER_ORDER.index) if active else "room"
        layer_w = LAYER_WEIGHT.get(cur, 1.0)
        sal = novelty * emo * layer_w
        tm = float(e.get("t_min", 0.0))
        v = float(np.interp(tm, st, sv))
        out.append({"id": f"e{idx}", "index": idx, "t_min": tm, "type": t, "payload": p, "v": round(v, 3),
                    "layer": cur, "novelty": round(novelty, 4), "salience": round(sal, 4),
                    "p_recall": round(recall_probability(v, sal), 4)})
        if t == "layer_exit" and p.get("layer") in active:
            active.remove(p.get("layer"))
    return out


def remember(events: list[dict], seed: int = 0) -> dict:
    """Returns {"remembered": [...in remembered order...], "gaps": [{start_min, end_min}], "candidates": n,
    "shuffled": bool}. Each remembered item carries `vivid` (top-3) and `shuffled` flags."""
    rng = np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFFFFFF, 1313]))
    cands = score_events(events)
    if not cands:
        return {"remembered": [], "gaps": [], "candidates": 0, "shuffled": False}
    order = sorted(range(len(cands)), key=lambda i: (-cands[i]["salience"], cands[i]["t_min"]))
    top = set(order[:TOP_K])
    draws = rng.random(len(cands))
    kept = []
    for i, c in enumerate(cands):
        keep = i in top or draws[i] < c["p_recall"]
        if keep:
            kept.append(dict(c, vivid=i in top, shuffled=False))
    # chronological order, except events above v = 7 shuffle among their own slots
    hi_slots = [k for k, c in enumerate(kept) if c["v"] > SHUFFLE_ABOVE_V]
    shuffled = False
    if len(hi_slots) > 1:
        perm = rng.permutation(len(hi_slots))
        items = [kept[k] for k in hi_slots]
        for slot, j in zip(hi_slots, perm):
            kept[slot] = dict(items[j], shuffled=True)
        shuffled = bool(any(p != q for p, q in enumerate(perm)))
    # gaps: spans between recalled times (chronologically) longer than GAP_MIN
    times = sorted(c["t_min"] for c in kept)
    t_first = min(c["t_min"] for c in cands)
    t_last = max(float(e.get("t_min", 0.0)) for e in events)
    gaps = []
    prev = t_first
    for t in times + [t_last]:
        if t - prev > GAP_MIN:
            gaps.append({"start_min": round(prev, 3), "end_min": round(t, 3)})
        prev = max(prev, t)
    return {"remembered": kept, "gaps": gaps, "candidates": len(cands), "shuffled": shuffled}


__all__ = ["remember", "recall_probability", "score_events", "EMOTIONAL_WEIGHT", "LAYER_WEIGHT"]
