"""Report figures (BUILD.md §13.5 lab view), matplotlib Agg, dark terminal style.

curves.png: plasma (top panel, "relative to half-effect level") and body/visual/auditory intensity (bottom panel,
"intensity (0–10)") on a shared time axis: two panels instead of a dual y-axis. timeline.png: layer bands.
curve_vs_drawn.png: the remembered (drawn) curve against the real visual curve.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

BG, FG, DIM, GRID = "#0a0700", "#ffb000", "#7a5400", "#2a1e00"
SERIES = {"body": "#e07a5f", "visual": "#ffb000", "auditory": "#4fe3ff", "drawn": "#4fe3ff", "plasma": "#c8a2ff"}
LAYERS = [("form_constants", "form constants", "#6b4a00"), ("chrysanthemum", "chrysanthemum", "#8a5a00"),
          ("waiting_room", "waiting room", "#a86c00"), ("breakthrough", "breakthrough", "#d08a00")]


def _style(ax):
    ax.set_facecolor(BG)
    for s in ax.spines.values():
        s.set_color(DIM)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors=DIM, labelcolor=FG, labelsize=9)
    ax.yaxis.label.set_color(FG)
    ax.xaxis.label.set_color(FG)
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _samples(events):
    s = [e for e in events if e.get("type") == "intensity_sample"]
    t = np.array([float(e["t_min"]) for e in s])
    get = lambda k: np.array([float((e.get("payload") or {}).get(k, 0.0)) for e in s])  # noqa: E731
    return t, get("plasma"), get("body"), get("visual"), get("auditory")


def _legend(ax):
    leg = ax.legend(loc="upper right", frameon=False, fontsize=9)
    for txt in leg.get_texts():
        txt.set_color(FG)


def curves(events, path: Path):
    t, pl, b, v, a = _samples(events)
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9, 5.2), sharex=True, gridspec_kw={"height_ratios": [1, 1.6]},
                                   facecolor=BG)
    for ax in (ax1, ax2):
        _style(ax)
    ax1.plot(t, pl, color=SERIES["plasma"], lw=2, label="plasma")
    ax1.set_ylabel("plasma\nrelative to half-effect level", fontsize=9)
    ax1.set_ylim(bottom=0)
    _legend(ax1)
    for name, y in (("body", b), ("visual", v), ("auditory", a)):
        ax2.plot(t, y, color=SERIES[name], lw=2, label=name)
    ax2.set_ylabel("intensity (0–10)")
    ax2.set_ylim(0, 10)
    ax2.set_xlabel("minutes since the hit")
    _legend(ax2)
    fig.suptitle("SIMULATED SESSION · MODEL UNITS", color=FG, fontsize=11, x=0.02, ha="left")
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=BG)
    plt.close(fig)


def timeline(events, path: Path):
    t_end = max([float(e["t_min"]) for e in events] or [1.0])
    spans = {k: [] for k, _, _ in LAYERS}
    open_at = {}
    for e in sorted(events, key=lambda e: float(e["t_min"])):
        layer = (e.get("payload") or {}).get("layer")
        if layer not in spans:
            continue
        if e["type"] == "layer_enter" and layer not in open_at:
            open_at[layer] = float(e["t_min"])
        elif e["type"] == "layer_exit" and layer in open_at:
            spans[layer].append((open_at.pop(layer), float(e["t_min"])))
    for layer, t0 in open_at.items():
        spans[layer].append((t0, t_end))
    fig, ax = plt.subplots(figsize=(9, 2.4), facecolor=BG)
    _style(ax)
    for i, (key, label, col) in enumerate(LAYERS):
        for a, b in spans[key]:
            ax.barh(i, b - a, left=a, height=0.7, color=col, edgecolor=BG, linewidth=2)
    marks = [("entity_appear", "being", SERIES["auditory"]), ("message_shown", "message", "#ffffff"),
             ("challenge_start", "difficult", "#e07a5f")]
    for typ, lab, col in marks:
        ts = [float(e["t_min"]) for e in events if e.get("type") == typ]
        if ts:
            ax.scatter(ts, [len(LAYERS) - 0.2] * len(ts), marker="v", s=40, color=col if col != "#ffffff" else "#ffe08a",
                       label=lab, zorder=3)
    ax.set_yticks(range(len(LAYERS)))
    ax.set_yticklabels([l for _, l, _ in LAYERS])
    ax.set_xlim(0, t_end)
    ax.set_ylim(-0.6, len(LAYERS) + 0.2)
    ax.set_xlabel("minutes since the hit")
    if any(any(e.get("type") == m[0] for e in events) for m in marks):
        _legend(ax)
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=BG)
    plt.close(fig)


def curve_vs_drawn(events, curve, path: Path):
    t, _, _, v, _ = _samples(events)
    fig, ax = plt.subplots(figsize=(9, 3.2), facecolor=BG)
    _style(ax)
    ax.plot(t, v, color=SERIES["visual"], lw=2, label="real (visual)")
    pts = (curve or {}).get("points") if isinstance(curve, dict) else curve
    if pts:
        p = np.array([[float(x[0]), float(x[1])] for x in pts])
        ax.plot(p[:, 0], p[:, 1], color=SERIES["drawn"], lw=2, label="you (drawn)")
        ax.fill_between(t, np.clip(v - 1.5, 0, 10), np.clip(v + 1.5, 0, 10), color=FG, alpha=0.08, linewidth=0,
                        label="±1.5 match band")
    ax.set_ylim(0, 10)
    ax.set_ylabel("intensity (0–10)")
    ax.set_xlabel("minutes since the hit")
    _legend(ax)
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=BG)
    plt.close(fig)


def make_figures(session_dir, events, curve) -> list[str]:
    fdir = Path(session_dir) / "figures"
    fdir.mkdir(parents=True, exist_ok=True)
    curves(events, fdir / "curves.png")
    timeline(events, fdir / "timeline.png")
    curve_vs_drawn(events, curve, fdir / "curve_vs_drawn.png")
    return ["figures/curves.png", "figures/timeline.png", "figures/curve_vs_drawn.png"]
