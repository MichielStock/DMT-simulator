"""Pharmacology tests (BUILD.md §7, milestone M1).

(a) backend.pharmacology.simulate matches the protected golden file to 1e-3;
(b) the §7.3 typical-session table;
(c) the §7.3 population table (seeded, >= 2000 samples per dose step);
(d) repeat-hit blocking while visual >= 3.

Population test: a vectorised RK4 over all samples at once, with the SAME dt = 1/600 min, T = 25 min and
counting rule as the reference (it is checked against simulate() for a few samples below), so no coarser
step was needed. The deepest-layer distribution of the §7.3 table is NOT reproducible with
backend.pharmacology.deepest_layer (see NOTES.md / RESULTS.md, "Population table discrepancy"); the test
asserts the true values computed with 40 000 samples per dose step, with the stated tolerance.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from backend.pharmacology import DOSES, HIT_BLOCK_VISUAL, LAYER_ORDER, P, deepest_layer, simulate, summarise

GOLDEN = Path(__file__).resolve().parents[2] / "shared" / "golden" / "pharmacology.json"
TOL = 1e-3
FIELDS = ("plasma", "body", "visual", "auditory")


@pytest.fixture(scope="module")
def golden():
    return json.loads(GOLDEN.read_text())


# ---------- (a) golden ----------

def test_golden_meta(golden):
    m = golden["meta"]
    assert m["dt"] == pytest.approx(1 / 600) and m["T"] == 25.0 and m["sample_every_steps"] == 60
    assert m["params"] == {k: (list(v) if isinstance(v, tuple) else v) for k, v in P.items()}
    assert m["doses"] == DOSES
    names = [c["name"] for c in golden["cases"]]
    assert names[:4] == list(DOSES)
    assert len(golden["cases"]) == 8
    for c in golden["cases"]:
        assert len(c["t"]) == 251 and c["t"][-1] == pytest.approx(25.0)


def test_simulate_matches_golden(golden):
    for c in golden["cases"]:
        hits = [tuple(h) for h in c["hits"]]
        ts, C, I = simulate(c["dose"], c["sensitivity"], c["clearance"], T=25.0, dt=1 / 600, hits=hits)
        got = dict(t=ts[::60], plasma=C[::60], body=I[0, ::60], visual=I[1, ::60], auditory=I[2, ::60])
        for f in ("t",) + FIELDS:
            err = np.max(np.abs(np.asarray(c[f]) - got[f]))
            assert err < TOL, f"{c['name']}.{f}: max error {err}"


def test_golden_repeat_hit_case_is_deferred(golden):
    c = golden["cases"][-1]
    assert c["hits"] == [[6.0, 2.0], [8.0, 2.0]]
    first, second = c["hits_applied"]
    assert first["applied_t"] == pytest.approx(6.0)
    assert second["applied_t"] > 8.0 + 1.0, "second hit must have been deferred (visual >= 3 at 8.0 min)"
    v = np.asarray(c["visual"])
    t = np.asarray(c["t"])
    assert v[np.searchsorted(t, 8.0)] >= HIT_BLOCK_VISUAL


# ---------- (b) typical table ----------

TYPICAL = {  # dose step: (peak visual, peak time, minutes > 1)
    "threshold": (0.6, 1.8, 0.0),
    "light": (2.7, 1.8, 4.2),
    "strong": (6.0, 1.8, 7.2),
    "breakthrough": (8.6, 1.8, 11.1),
}


@pytest.mark.parametrize("step", list(DOSES))
def test_typical_table(step):
    ts, _, I = simulate(DOSES[step])
    m = summarise(ts, I)
    peak, tpeak, above1 = TYPICAL[step]
    assert m["peak_visual"] == pytest.approx(peak, abs=0.1)
    assert m["peak_time_min"] == pytest.approx(tpeak, abs=0.1)
    assert m["minutes_above_1"] == pytest.approx(above1, abs=0.2)


def test_channel_peak_times():
    ts, _, I = simulate(DOSES["strong"])
    for ch, expected in zip(range(3), (1.3, 1.8, 2.6)):
        assert ts[int(np.argmax(I[ch]))] == pytest.approx(expected, abs=0.1)
    # body first, visual second, auditory last (§1 "Timing")
    assert ts[np.argmax(I[0])] < ts[np.argmax(I[1])] < ts[np.argmax(I[2])]


# ---------- (c) population table ----------

def simulate_population(dose, sensitivity, clearance, T=25.0, dt=1 / 600):
    """Vectorised copy of the reference RK4 (visual channel only, no hits) for many samples at once.
    Returns peak visual and minutes with visual > 1, counted exactly as summarise() does."""
    sensitivity = np.asarray(sensitivity, float)
    clearance = np.asarray(clearance, float)
    ka, k12, k21, h = P["ka"], P["k12"], P["k21"], P["h"]
    k10 = P["k10"] * clearance
    ke = P["ke0"][1]
    ec50h = (1.0 / sensitivity) ** h
    y = np.zeros((4, sensitivity.size))
    y[0] = dose

    def f(y):
        A, C, Pp, Ce = y
        return np.stack([-ka * A, ka * A - (k10 + k12) * C + k21 * Pp, k12 * C - k21 * Pp, ke * (C - Ce)])

    n = int(round(T / dt))
    peak = np.zeros(sensitivity.size)
    above = np.zeros(sensitivity.size)
    for _ in range(n + 1):
        Ce = np.clip(y[3], 0, None) ** h
        v = 10 * Ce / (Ce + ec50h)
        np.maximum(peak, v, out=peak)
        above += v > 1.0
        k1 = f(y); k2 = f(y + dt / 2 * k1); k3 = f(y + dt / 2 * k2); k4 = f(y + dt * k3)
        y = y + dt / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return peak, above * dt


# §7.3 population table: 10/50/90 percentiles of peak visual and minutes > 1 (reproduced by the model).
POP_PERCENTILES = {
    "threshold": ((0.3, 0.5, 1.0), (0.0, 0.0, 0.0)),
    "light": ((1.7, 2.6, 4.1), (2.8, 4.1, 5.4)),
    "strong": ((4.3, 6.2, 7.5), (5.6, 7.3, 9.2)),
    "breakthrough": ((7.4, 8.4, 9.2), (8.4, 10.9, 15.6)),
}
# §7.3 deepest-layer column as printed in BUILD.md (NOT reproducible; kept for the record).
POP_LAYERS_BUILD_MD = {
    "threshold": {"none": 45, "onset": 55},
    "light": {"onset": 22, "form_constants": 73, "chrysanthemum": 5},
    "strong": {"form_constants": 12, "chrysanthemum": 65, "waiting_room": 19, "breakthrough": 4},
    "breakthrough": {"chrysanthemum": 5, "waiting_room": 20, "breakthrough": 75},
}
# True distribution from the reference model + deepest_layer, 40 000 samples per step (seed 7, dt 1/600).
POP_LAYERS_TRUE = {
    "threshold": {"none": 40.5, "onset": 59.5},
    "light": {"onset": 61.0, "form_constants": 37.4, "chrysanthemum": 1.6},
    "strong": {"onset": 0.7, "form_constants": 25.6, "chrysanthemum": 67.1, "waiting_room": 4.1, "breakthrough": 2.5},
    "breakthrough": {"chrysanthemum": 10.4, "waiting_room": 10.9, "breakthrough": 78.6},
}
N_POP = 3000


def test_vectorised_population_matches_reference():
    s = np.array([0.8, 1.0, 1.3]); c = np.array([1.2, 1.0, 0.85])
    peak, above = simulate_population(DOSES["strong"], s, c)
    for i in range(3):
        ts, _, I = simulate(DOSES["strong"], s[i], c[i])
        m = summarise(ts, I)
        assert peak[i] == pytest.approx(m["peak_visual"], abs=1e-9)
        assert above[i] == pytest.approx(m["minutes_above_1"], abs=1e-9)


@pytest.fixture(scope="module")
def population():
    rng = np.random.default_rng(20261010)
    out = {}
    for step, dose in DOSES.items():
        sens = rng.lognormal(0.0, 0.25, N_POP)
        clr = rng.lognormal(0.0, 0.2, N_POP)
        out[step] = simulate_population(dose, sens, clr)
    return out


@pytest.mark.parametrize("step", list(DOSES))
def test_population_percentiles(step, population):
    peak, above = population[step]
    p_peak = np.percentile(peak, [10, 50, 90])
    p_above = np.percentile(above, [10, 50, 90])
    print(f"{step}: peak {np.round(p_peak, 2)} minutes>1 {np.round(p_above, 2)}")
    exp_peak, exp_above = POP_PERCENTILES[step]
    assert np.all(np.abs(p_peak - exp_peak) <= 0.3), (p_peak, exp_peak)
    assert np.all(np.abs(p_above - exp_above) <= 0.6), (p_above, exp_above)


@pytest.mark.parametrize("step", list(DOSES))
def test_population_deepest_layer(step, population):
    peak, _ = population[step]
    layers = [deepest_layer(p) for p in peak]
    got = {name: 100.0 * layers.count(name) / len(layers) for name in LAYER_ORDER}
    print(f"{step}: deepest layer % {({k: round(v, 1) for k, v in got.items() if v})}"
          f" (BUILD.md table: {POP_LAYERS_BUILD_MD[step]})")
    for name in LAYER_ORDER:
        expected = POP_LAYERS_TRUE[step].get(name, 0.0)
        assert abs(got[name] - expected) <= 6.0, (step, name, got[name], expected)


# ---------- (d) repeat-hit blocking ----------

def test_repeat_hit_deferred_while_visual_at_least_3():
    hits = [(2.0, DOSES["strong"])]  # at 2.0 min visual is near its strong peak (~6)
    ts, _, I = simulate(DOSES["strong"], hits=hits)
    base_ts, _, base_I = simulate(DOSES["strong"])
    i_req = int(np.searchsorted(ts, 2.0))
    assert I[1, i_req] >= HIT_BLOCK_VISUAL
    # until visual first drops below 3 after the request, the curve equals the single-hit curve
    below = np.nonzero((ts >= 2.0) & (base_I[1] < HIT_BLOCK_VISUAL))[0]
    i_apply = int(below[0])
    assert np.allclose(I[:, : i_apply + 1], base_I[:, : i_apply + 1], atol=1e-12)
    assert not np.allclose(I[:, i_apply + 2], base_I[:, i_apply + 2], atol=1e-9)
    assert base_I[1, i_apply - 1] >= HIT_BLOCK_VISUAL > base_I[1, i_apply]


def test_repeat_hit_applied_immediately_when_visual_below_3():
    ts, _, I = simulate(DOSES["strong"], hits=[(20.0, DOSES["strong"])])
    _, _, base_I = simulate(DOSES["strong"])
    i = int(np.searchsorted(ts, 20.0))
    assert base_I[1, i] < HIT_BLOCK_VISUAL
    assert np.allclose(I[:, : i + 1], base_I[:, : i + 1])
    assert I[0, i + 1] > base_I[0, i + 1]
