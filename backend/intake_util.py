"""Tolerant accessor for intake.json (shared/schemas/intake.schema.json).

`normalise(intake)` returns a flat dict with the hidden variables of BUILD.md §8.2 and the options of §8.3,
filling neutral defaults for anything missing so the planner never fails on a partial intake.
"""
from __future__ import annotations

from typing import Any

NEUTRAL = dict(clarity=5.0, set=0.0, absorption=5.0, surrender=5.0, intention="curiosity",
               expectations=[], dose_step="strong", hold_fraction=1.0, difficult_passages=True,
               eyes="auto", audio=True, microphone=False, live_diffusion=False, room_source="default")

# expectation option → entity type it boosts (§8.2: ×1.5 each)
EXPECTATION_TO_TYPE = {
    "jesters": "jester", "jester": "jester",
    "machine_elves": "machine_elf", "machine_elf": "machine_elf", "machine elves": "machine_elf",
    "aliens": "alien", "alien": "alien",
    "luminous_feminine": "luminous_feminine", "luminous_feminine_figures": "luminous_feminine",
    "luminous feminine figures": "luminous_feminine",
    "insectoid": "creature_insectoid", "insectoid_beings": "creature_insectoid",
    "insectoids": "creature_insectoid", "insectoid beings": "creature_insectoid",
}


def _find(d: Any, *keys, default=None):
    """Look up the first key found at the top level or inside common sub-objects."""
    if not isinstance(d, dict):
        return default
    scopes = [d] + [d[k] for k in ("answers", "options", "room", "dose") if isinstance(d.get(k), dict)]
    for key in keys:
        for s in scopes:
            if key in s and s[key] is not None:
                return s[key]
    return default


def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def normalise(intake: dict | None) -> dict:
    intake = intake or {}
    out = dict(NEUTRAL)
    out["clarity"] = _num(_find(intake, "clarity", "intention_clarity"), 5.0)
    out["set"] = _num(_find(intake, "set", "mood"), 0.0)
    ab = _find(intake, "absorption", "absorption_items")
    if isinstance(ab, (list, tuple)) and ab:
        out["absorption"] = sum(_num(x, 5.0) for x in ab) / len(ab)
    elif isinstance(ab, dict) and ab:
        vals = [_num(x, 5.0) for x in ab.values()]
        out["absorption"] = sum(vals) / len(vals)
    elif ab is not None:
        out["absorption"] = _num(ab, 5.0)
    else:
        items = [_find(intake, f"absorption_{i}") for i in (1, 2, 3)]
        items = [_num(x, 5.0) for x in items if x is not None]
        if items:
            out["absorption"] = sum(items) / len(items)
    out["surrender"] = _num(_find(intake, "surrender", "readiness"), 5.0)
    out["intention"] = str(_find(intake, "intention", "reason", default="curiosity")).lower()
    exp = _find(intake, "expectations", "motifs", default=[]) or []
    if isinstance(exp, str):
        exp = [exp]
    out["expectations"] = [str(e).lower() for e in exp if str(e).lower() not in ("none", "none_of_these")]
    out["dose_step"] = str(_find(intake, "dose_step", "step", default="strong")).lower()
    out["hold_fraction"] = max(0.0, min(1.0, _num(_find(intake, "hold_fraction"), 1.0)))
    diff = _find(intake, "difficult_passages", "difficult")
    gentle = _find(intake, "gentle_mode", "gentle")
    if gentle is not None:
        out["difficult_passages"] = not bool(gentle)
    if diff is not None:
        out["difficult_passages"] = bool(diff)
    out["eyes"] = str(_find(intake, "eyes", "eyes_mode", default="auto"))
    out["audio"] = bool(_find(intake, "audio", "sound", default=True))
    out["microphone"] = bool(_find(intake, "microphone", default=False))
    out["live_diffusion"] = bool(_find(intake, "live_diffusion", default=False))
    rs = intake.get("room_source")
    if rs is None and isinstance(intake.get("room"), dict):
        rs = intake["room"].get("source")
    if rs is None and isinstance(intake.get("room"), str):
        rs = intake["room"]
    out["room_source"] = str(rs or "default")
    return out


def expectation_types(norm: dict) -> list[str]:
    return [EXPECTATION_TO_TYPE[e] for e in norm.get("expectations", []) if e in EXPECTATION_TO_TYPE]


def gentle(norm: dict) -> bool:
    return not norm.get("difficult_passages", True)
