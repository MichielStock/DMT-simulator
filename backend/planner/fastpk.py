"""Fast, exact re-statement of the reference RK4 integrator (backend/pharmacology.py) for single hits.

The model is linear, so one RK4 step is the fixed matrix M = I + hA + (hA)²/2 + (hA)³/6 + (hA)⁴/24.
Iterating M by blocks gives the same trajectory as `pharmacology.simulate` (to ~1e-12) about 100× faster,
which the sampler and the batch validator need. Repeat hits still go through the reference code.
"""
from __future__ import annotations

import numpy as np

from backend.pharmacology import P


def _system(clearance: float) -> np.ndarray:
    ka, k12, k21 = P["ka"], P["k12"], P["k21"]
    k10 = P["k10"] * clearance
    ke = P["ke0"]
    A = np.zeros((6, 6))
    A[0, 0] = -ka
    A[1, 0] = ka
    A[1, 1] = -(k10 + k12)
    A[1, 2] = k21
    A[2, 1] = k12
    A[2, 2] = -k21
    for i in range(3):
        A[3 + i, 1] = ke[i]
        A[3 + i, 3 + i] = -ke[i]
    return A


def simulate_fast(dose, sensitivity=1.0, clearance=1.0, T=25.0, dt=1 / 600, block=600):
    h = P["h"]
    ec50 = 1.0 / sensitivity
    hA = dt * _system(clearance)
    I6 = np.eye(6)
    M = I6 + hA + hA @ hA / 2 + hA @ hA @ hA / 6 + hA @ hA @ hA @ hA / 24
    n = int(round(T / dt))
    pows = np.empty((block, 6, 6))
    pows[0] = I6
    for k in range(1, block):
        pows[k] = M @ pows[k - 1]
    Mb = M @ pows[block - 1]
    y = np.array([dose, 0, 0, 0, 0, 0], float)
    Y = np.empty((n + 1, 6))
    i = 0
    while i <= n:
        m = min(block, n + 1 - i)
        Y[i:i + m] = pows[:m] @ y
        y = Mb @ y
        i += m
    ts = np.arange(n + 1) * dt
    Ce = np.clip(Y[:, 3:], 0, None).T
    I = 10 * Ce**h / (Ce**h + ec50**h)
    return ts, Y[:, 1].copy(), I
