"""Reference pharmacology (BUILD.md §7.4). Ground truth for the golden file and the TypeScript port.

Concentrations are dimensionless, in units of the half-effect concentration at sensitivity 1.
Intensities are 0–10. All rate constants are per minute. Never real units.
"""
from __future__ import annotations

import numpy as np

P = dict(ka=4.0, k10=0.12, k12=0.20, k21=0.03, ke0=(2.5, 1.2, 0.6), h=2.0)
DOSES = dict(threshold=0.4, light=1.0, strong=2.0, breakthrough=4.0)
CHANNELS = ("body", "visual", "auditory")
HIT_BLOCK_VISUAL = 3.0  # repeat hits are blocked while visual intensity >= 3 (§7.5)


def simulate(dose, sensitivity=1.0, clearance=1.0, T=25.0, dt=1 / 600, hits=()):
    """Return times (min), plasma C, and intensities I[3] (body, visual, auditory).
    hits: sequence of (requested_time_min, dose); a hit is applied at the first
    moment at or after its requested time when visual intensity is below 3."""
    ka, k12, k21, h = P["ka"], P["k12"], P["k21"], P["h"]
    k10 = P["k10"] * clearance
    ec50 = 1.0 / sensitivity
    y = np.array([dose, 0, 0, 0, 0, 0], float)  # A, C, P, Ce_body, Ce_visual, Ce_auditory
    ke = np.array(P["ke0"])

    def f(y):
        A, C, Pp = y[:3]
        Ce = y[3:]
        return np.concatenate([[-ka * A, ka * A - (k10 + k12) * C + k21 * Pp, k12 * C - k21 * Pp],
                               ke * (C - Ce)])

    n = int(round(T / dt))
    ts = np.arange(n + 1) * dt
    Cs = np.zeros(n + 1)
    I = np.zeros((3, n + 1))
    pending = sorted(hits)
    for i, t in enumerate(ts):
        Ce = np.clip(y[3:], 0, None)
        I[:, i] = 10 * Ce**h / (Ce**h + ec50**h)
        Cs[i] = y[1]
        if pending and t >= pending[0][0] and I[1, i] < HIT_BLOCK_VISUAL:
            y[0] += pending.pop(0)[1]
        k1 = f(y); k2 = f(y + dt / 2 * k1); k3 = f(y + dt / 2 * k2); k4 = f(y + dt * k3)
        y = y + dt / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return ts, Cs, I


def summarise(ts, I):
    """Peak visual, peak time (min) and minutes with visual intensity > 1."""
    v = I[1]
    i = int(np.argmax(v))
    dt = float(ts[1] - ts[0]) if len(ts) > 1 else 0.0
    return dict(peak_visual=float(v[i]), peak_time_min=float(ts[i]),
                minutes_above_1=float(np.count_nonzero(v > 1.0) * dt),
                minutes_above_8=float(np.count_nonzero(v > 8.0) * dt))


LAYER_ORDER = ["none", "onset", "form_constants", "chrysanthemum", "waiting_room", "breakthrough"]


def deepest_layer(peak_visual: float) -> str:
    """Deepest layer reached for a peak visual intensity, using the §11.2 entry thresholds
    (a layer counts as entered once its entry window is fully crossed)."""
    if peak_visual >= 8.0:
        return "breakthrough"
    if peak_visual >= 7.6:
        return "waiting_room"
    if peak_visual >= 5.2:
        return "chrysanthemum"
    if peak_visual >= 3.0:
        return "form_constants"
    if peak_visual >= 0.5:
        return "onset"
    return "none"
