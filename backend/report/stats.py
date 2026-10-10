"""Session stats (BUILD.md §15.3, CONTRACTS.md "Stats object"). The ONLY implementation:
the end screen, the report and the tests all use `compute_stats`.
"""
from __future__ import annotations

import datetime as _dt
import math

import numpy as np

LAYER_ORDER = ["none", "onset", "form_constants", "chrysanthemum", "waiting_room", "breakthrough"]
SPARK = "▁▂▃▄▅▆▇█"
SPARK_COLS = 36
BOX_WIDTH = 46
INNER = BOX_WIDTH - 4  # "║ " + content + " ║"
MATCH_TOLERANCE = 1.5

TYPE_NAMES = {
    "luminous_feminine": "LUMINOUS FIGURE", "deity": "DEITY", "alien": "ALIEN",
    "creature_reptilian": "SERPENT", "creature_tentacled": "TENTACLED", "creature_insectoid": "INSECTOID",
    "creature_feline": "FELINE", "machine_elf": "MACHINE ELF", "mythological": "SPRITE",
    "jester": "JESTER", "living_geometry": "LIVING GEOMETRY",
}


def mmss(minutes: float | None) -> str:
    if minutes is None or not math.isfinite(minutes):
        return "0:00"
    s = int(round(max(0.0, minutes) * 60))
    return f"{s // 60}:{s % 60:02d}"


def layer_display(layer: str) -> str:
    return layer.replace("_", " ").upper()


def type_display(t: str | None) -> str:
    if not t:
        return "UNKNOWN"
    return TYPE_NAMES.get(t, t.replace("_", " ").upper())


def _line(label: str, value: str) -> str:
    dots = INNER - len(label) - len(value) - 2
    if dots < 3:  # never wrap: shorten the value
        value = value[: max(1, INNER - len(label) - 5)]
        dots = INNER - len(label) - len(value) - 2
    return "║ " + label + " " + "." * dots + " " + value + " ║"


def make_box(s: dict) -> list[str]:
    head_l, head_r = "SESSION COMPLETE · SIMULATED", s["date"]
    head = head_l + " " * (INNER - len(head_l) - len(head_r)) + head_r
    rows = [
        ("DOSE STEP", s["dose_step"]),
        ("INHALED", f"{s['inhaled_pct']}%"),
        ("REPEAT HITS", str(s["repeat_hits"])),
        ("PEAK INTENSITY", f"{s['peak_visual']:.1f} / 10"),
        ("TIME TO PEAK", s["time_to_peak"]),
        ("DURATION", s["duration"]),
        ("DEEPEST LAYER", s["deepest_layer"]),
        ("BEINGS MET", s["beings_met"]),
        ("MESSAGE", s["message"]),
        ("DIFFICULT PASSAGE", s["difficult_passage"]),
        ("MEMORY MATCH", "N/A" if s["memory_match_pct"] is None else f"{s['memory_match_pct']}%"),
    ]
    return (["╔" + "═" * (BOX_WIDTH - 2) + "╗", "║ " + head + " ║", "╠" + "═" * (BOX_WIDTH - 2) + "╣"]
            + [_line(a, b) for a, b in rows] + ["╚" + "═" * (BOX_WIDTH - 2) + "╝"])


def sparkline(values) -> str:
    out = []
    for v in values:
        if v is None or not math.isfinite(v):
            v = 0.0
        out.append(SPARK[int(np.clip(round(v / 10.0 * 7), 0, 7))])
    return "".join(out)


def _columns(t_grid: np.ndarray, v_grid: np.ndarray, t0: float, t1: float, n: int = SPARK_COLS) -> list[float]:
    edges = np.linspace(t0, t1, n + 1)
    cols = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (t_grid >= a) & (t_grid < b if b < t1 else t_grid <= b)
        if m.any():
            cols.append(float(v_grid[m].mean()))
        else:
            cols.append(float(np.interp((a + b) / 2, t_grid, v_grid)) if len(t_grid) else 0.0)
    return cols


def _curve_points(curve) -> list[tuple[float, float]]:
    if curve is None:
        return []
    pts = curve.get("points") if isinstance(curve, dict) else curve
    out = []
    for p in pts or []:
        if isinstance(p, dict):
            t, v = p.get("t_min"), p.get("intensity", p.get("v"))
        else:
            t, v = p[0], p[1]
        if t is None or v is None:
            continue
        out.append((float(t), float(v)))
    out.sort()
    return out


def compute_stats(trip_script: dict, events: list[dict], curve: dict | list | None, intake: dict | None,
                  *, date: str | None = None) -> dict:
    trip_script = trip_script or {}
    intake = intake or {}
    events = sorted(events or [], key=lambda e: float(e.get("t_min", 0.0)))
    pharm = trip_script.get("pharmacology", {})

    hits = [e for e in events if e.get("type") == "hit"]
    first_hit = hits[0] if hits else None
    t_hit = float(first_hit["t_min"]) if first_hit else 0.0
    hp = (first_hit or {}).get("payload", {}) or {}
    dose_step = str(hp.get("dose_step") or pharm.get("dose_step") or intake.get("dose_step") or "strong")
    hold = hp.get("hold_fraction", pharm.get("hold_fraction", intake.get("hold_fraction", 1.0)))
    inhaled_pct = int(round(float(hold if hold is not None else 1.0) * 100))
    repeat_hits = len([e for e in hits[1:]]) if hits else 0
    if hits:  # prefer explicit n in payloads when present
        ns = [int(e.get("payload", {}).get("n", 0) or 0) for e in hits]
        repeat_hits = len([n for n in ns if n >= 1]) if any(ns) else len(hits) - 1

    samples = [e for e in events if e.get("type") == "intensity_sample"]
    ts = np.array([float(e["t_min"]) for e in samples]) if samples else np.zeros(0)
    vs = np.array([float(e.get("payload", {}).get("visual", 0.0)) for e in samples]) if samples else np.zeros(0)

    if len(vs):
        i = int(np.argmax(vs))
        peak = float(vs[i])
        t_peak = float(ts[i]) - t_hit
        dts = np.diff(ts)
        above = vs[:-1] > 1.0
        duration_min = float(dts[above].sum())
    else:
        peak, t_peak, duration_min = 0.0, 0.0, 0.0

    # deepest layer from layer_enter events (onset = visual ≥ 0.5 without any other layer)
    deepest = "none"
    for e in events:
        if e.get("type") == "layer_enter":
            name = (e.get("payload") or {}).get("layer")
            if name in LAYER_ORDER and LAYER_ORDER.index(name) > LAYER_ORDER.index(deepest):
                deepest = name
    if deepest == "none" and peak >= 0.5:
        deepest = "onset"

    appear = [e for e in events if e.get("type") == "entity_appear"]
    if appear:
        p0 = appear[0].get("payload") or {}
        etype = p0.get("type")
        if not etype:
            ents = (trip_script.get("breakthrough") or {}).get("entities") or []
            idx = p0.get("index", p0.get("entity", 0))
            if isinstance(idx, int) and 0 <= idx < len(ents):
                etype = ents[idx].get("type")
        beings = f"{len(appear)} · {type_display(etype)}"
    else:
        beings = "NONE"

    message = "RECEIVED" if any(e.get("type") == "message_shown" for e in events) else "NONE"

    end_events = [e for e in events if e.get("type") == "session_end"]
    t_end = float(end_events[-1]["t_min"]) if end_events else (float(events[-1]["t_min"]) if events else t_hit)
    exits = [e for e in events if e.get("type") == "exit_pressed"]

    opts = intake.get("options") if isinstance(intake.get("options"), dict) else intake
    gentle = opts.get("difficult_passages") is False or bool((trip_script.get("challenge") or {}).get("gentle"))
    starts = [e for e in events if e.get("type") == "challenge_start"]
    resolves = [e for e in events if e.get("type") == "challenge_resolve"]
    if gentle:
        difficult = "GENTLE MODE"
    elif starts:
        t0 = float(starts[0]["t_min"])
        after = [float(e["t_min"]) for e in resolves if float(e["t_min"]) >= t0]
        t1 = after[0] if after else (float(exits[0]["t_min"]) if exits else t_end)
        difficult = f"RESOLVED IN {mmss(t1 - t0)}"
    else:
        difficult = "NONE"

    # memory match and sparklines: both curves resampled every second from the hit to the session end
    span = max(t_end - t_hit, 0.0)
    grid = t_hit + np.arange(0.0, span * 60.0 + 1e-9, 1.0) / 60.0 if span > 0 else np.array([t_hit])
    real = np.interp(grid, ts, vs) if len(vs) else np.zeros_like(grid)
    pts = _curve_points(curve)
    if pts:
        cts = np.array([p[0] for p in pts])
        cvs = np.array([p[1] for p in pts])
        you = np.interp(grid, cts, cvs)
        match = int(round(100.0 * float(np.mean(np.abs(you - real) <= MATCH_TOLERANCE))))
        spark_you = sparkline(_columns(grid, you, grid[0], grid[-1]))
    else:
        match, spark_you = None, ""
    spark_real = sparkline(_columns(grid, real, grid[0], grid[-1])) if span > 0 else sparkline([peak] * SPARK_COLS)

    if date is None:
        date = trip_script.get("date") or intake.get("date") or _dt.date.today().isoformat()

    stats = {
        "date": str(date)[:10],
        "dose_step": dose_step.upper(),
        "inhaled_pct": inhaled_pct,
        "repeat_hits": repeat_hits,
        "peak_visual": round(peak, 1),
        "time_to_peak": mmss(t_peak),
        "duration": mmss(duration_min),
        "deepest_layer": layer_display(deepest),
        "beings_met": beings,
        "message": message,
        "difficult_passage": difficult,
        "memory_match_pct": match,
        "ended_early_at": mmss(float(exits[0]["t_min"]) - t_hit) if exits else None,
        "session_minutes": round(span, 1),
        "sparkline_real": spark_real,
        "sparkline_you": spark_you,
        "axis_end": mmss(span),
    }
    stats["box"] = make_box(stats)
    return stats


def render_text(stats: dict) -> str:
    """The end-screen block as plain text (box, sparklines, ended-early line) for Markdown/HTML."""
    lines = list(stats["box"])
    if stats.get("ended_early_at"):
        lines.append(f" ENDED EARLY AT {stats['ended_early_at']}")
    lines.append("")
    axis = " INTENSITY  0:00 " + "─" * 22 + " " + stats.get("axis_end", "")
    lines.append(axis)
    lines.append(" REAL  " + stats["sparkline_real"])
    if stats.get("sparkline_you"):
        lines.append(" YOU   " + stats["sparkline_you"])
    return "\n".join(lines)
