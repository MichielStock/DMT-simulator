"""Synthesise a plausible front-end event log from a trip script (or skeleton) and the reference
pharmacology, for batch validation (BUILD.md §14) and test fixtures. No rendering involved.

Layer entry/exit follows the §11.2 windows (a layer is entered once its entry window is fully crossed,
left 0.5 below the start of its window; breakthrough latches at 8.0 and releases below 6.5).
"""
from __future__ import annotations

import math

import numpy as np

from backend.planner.fastpk import simulate_fast

SAMPLE_DT_MIN = 0.5 / 60.0  # intensity_sample every 0.5 s
LAYERS = [  # name, enter when v >= , leave when v <
    ("form_constants", 3.0, 1.3),
    ("chrysanthemum", 5.2, 3.7),
    ("waiting_room", 7.6, 6.3),
    ("breakthrough", 8.0, 6.5),
]


def _ev(t, typ, payload=None):
    return {"t_min": round(float(t), 4), "type": typ, "payload": payload or {}}


def synthesise_events(script: dict, *, t_hit: float = 0.0, exit_at_min: float | None = None,
                      max_minutes: float = 30.0) -> list[dict]:
    ph = script["pharmacology"]
    seed = int(script.get("seed", 0))
    rng = np.random.default_rng(np.random.SeedSequence([seed & 0xFFFFFFFFFFFF, 99]))
    ts, C, I = simulate_fast(ph["dose_rel"], ph.get("sensitivity", 1.0), ph.get("clearance", 1.0), T=max_minutes)
    v = I[1]
    ipk = int(np.argmax(v))
    # session end: two minutes after visual intensity has fallen below 1 after the peak, or the 30-minute cap
    below = np.nonzero(v[ipk:] < 1.0)[0]
    t_end = min(max_minutes, float(ts[ipk + below[0]]) + 2.0) if len(below) else max_minutes
    t_end = max(t_end, 2.0)
    reason = "faded" if t_end < max_minutes else "cap"
    if exit_at_min is not None and exit_at_min < t_end:
        t_end, reason = exit_at_min, "escape"

    events = [_ev(t_hit, "hit", {"dose_step": ph["dose_step"], "dose_rel": ph["dose_rel"],
                                 "hold_fraction": ph.get("hold_fraction", 1.0), "n": 0})]
    # intensity samples
    step = int(round(SAMPLE_DT_MIN / (ts[1] - ts[0])))
    for i in range(0, len(ts), step):
        if ts[i] > t_end + 1e-9:
            break
        events.append(_ev(t_hit + ts[i], "intensity_sample",
                          {"plasma": round(float(C[i]), 5), "body": round(float(I[0, i]), 4),
                           "visual": round(float(I[1, i]), 4), "auditory": round(float(I[2, i]), 4)}))
    # layers
    entered: dict[str, float] = {}
    active = {name: False for name, _, _ in LAYERS}
    events.append(_ev(t_hit, "layer_enter", {"layer": "room"}))
    for i in range(0, len(ts), step):
        t = ts[i]
        if t > t_end:
            break
        for name, up, down in LAYERS:
            if not active[name] and v[i] >= up:
                active[name] = True
                entered.setdefault(name, t)
                events.append(_ev(t_hit + t, "layer_enter", {"layer": name}))
                events.append(_ev(t_hit + t, "frame_captured", {"name": f"layer_enter_{name}"}))
            elif active[name] and v[i] < down:
                active[name] = False
                events.append(_ev(t_hit + t, "layer_exit", {"layer": name}))
    events.append(_ev(t_hit + ts[ipk], "frame_captured", {"name": "peak"}))

    # beings: at breakthrough (or in the waiting room when the encounter happened there)
    bt = script.get("breakthrough") or {}
    ents = bt.get("entities") or []
    enc = script.get("encounter") or {}
    host = "breakthrough" if "breakthrough" in entered else ("waiting_room" if "waiting_room" in entered and enc.get("occurs", True) else None)
    msg_done = False
    if ents and host:
        t_latch = entered[host]
        layer_end = t_end
        for e in events:
            if e["type"] == "layer_exit" and e["payload"].get("layer") == host and e["t_min"] - t_hit > t_latch:
                layer_end = e["t_min"] - t_hit
                break
        for k, ent in enumerate(ents):
            beats = ent.get("beats") or [{"behaviour": b, "at_s": 8 * j, "duration_s": 7}
                                          for j, b in enumerate(ent.get("behaviours") or ["approach", "depart"])]
            offset = float(ent.get("arrival_s", 10.0)) + 4.0 * k
            t_app = t_latch + offset / 60.0
            if t_app >= layer_end:
                continue
            events.append(_ev(t_hit + t_app, "entity_appear", {"index": k, "type": ent.get("type")}))
            events.append(_ev(t_hit + t_app, "frame_captured", {"name": f"entity_{k}"}))
            best_t, best_v = None, -1.0
            for b in beats:
                tb = t_app + float(b["at_s"]) / 60.0
                if tb >= layer_end:
                    break
                events.append(_ev(t_hit + tb, "entity_behaviour", {"index": k, "behaviour": b["behaviour"]}))
                vb = float(np.interp(tb, ts, v))
                if vb > best_v:
                    best_t, best_v = tb + float(b.get("duration_s", 6.0)) / 120.0, vb
            msg = bt.get("message") or {}
            if k == 0 and msg.get("present") and best_t is not None and best_t < layer_end:
                events.append(_ev(t_hit + best_t, "message_shown", {"index": 0, "glyph_seed": msg.get("glyph_seed", 0)}))
                events.append(_ev(t_hit + best_t, "frame_captured", {"name": "message"}))
                msg_done = True
    _ = msg_done

    ch = script.get("challenge") or {}
    if ch.get("occurs") and ch.get("onset_offset_s") is not None:
        pk = float((script.get("predicted") or {}).get("peak_time_min", ts[ipk]))
        t0 = pk + float(ch["onset_offset_s"]) / 60.0
        if t0 < t_end:
            surrender = float((script.get("intake") or {}).get("surrender", 5.0))
            lam = (1.0 / 60.0) * (1 + 0.1 * surrender)
            dur = min(90.0, float(rng.exponential(1.0 / lam)))
            events.append(_ev(t_hit + t0, "challenge_start", {"flavour": ch.get("flavour")}))
            t1 = t0 + dur / 60.0
            if t1 < t_end:
                events.append(_ev(t_hit + t1, "challenge_resolve", {"duration_s": round(dur, 1)}))

    if reason == "escape":
        events.append(_ev(t_hit + t_end, "exit_pressed", {}))
    for name, _, _ in LAYERS:
        if active[name]:
            events.append(_ev(t_hit + t_end, "layer_exit", {"layer": name}))
    events.append(_ev(t_hit + t_end, "session_end", {"reason": reason}))
    events.sort(key=lambda e: e["t_min"])
    return events


def real_curve(events: list[dict]) -> list[list[float]]:
    return [[e["t_min"], e["payload"]["visual"]] for e in events if e["type"] == "intensity_sample"]


def synthesise_drawn_curve(events: list[dict], seed: int = 0, n_points: int = 40) -> dict:
    """A remembered curve: the real one, compressed in time and distorted, as people draw it."""
    rng = np.random.default_rng(seed)
    pts = real_curve(events)
    if not pts:
        return {"points": []}
    t = np.array([p[0] for p in pts])
    v = np.array([p[1] for p in pts])
    grid = np.linspace(t[0], t[-1], n_points)
    warp = 0.6 + 0.3 * rng.random()
    vv = np.interp(t[0] + (grid - t[0]) / warp, t, v, right=0.0)
    vv = np.clip(vv * (0.9 + 0.3 * rng.random()) + rng.normal(0, 0.4, n_points), 0, 10)
    return {"points": [[round(float(a), 4), round(float(b), 3)] for a, b in zip(grid, vv)]}


__all__ = ["synthesise_events", "synthesise_drawn_curve", "real_curve"]
_ = math
