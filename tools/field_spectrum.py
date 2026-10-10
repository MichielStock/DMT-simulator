"""Spatial power spectrum of a neural-field snapshot (BUILD.md §11.4 / M5 spectrum gate).

    uv run python tools/field_spectrum.py <field.f32> [--n 256] [--predict-k K] [--expect pattern|none] [--json out.json]

<field.f32> is raw little-endian float32, n*n values, row-major (y*n + x), as returned by
window.__hyperspace.readField() (the GPU field u). Prints JSON with the radially averaged spectrum's
peak bin, the peak wavenumber (radians/cell, power-weighted within +-1.5 bins), peak/median, and the
dominant directions (mod 180 degrees) on the peak ring. Same estimator as neuralFieldCpu.ts.

--expect none:    exit 1 unless peak/median < 3 (no pattern above noise)
--expect pattern: exit 1 unless peak/median >= 8 and (with --predict-k) |k - K| / K < 0.15
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np


def spectrum(u: np.ndarray) -> dict:
    n = u.shape[0]
    p2 = np.abs(np.fft.fft2(u - u.mean())) ** 2
    m = np.fft.fftfreq(n) * n
    mx, my = np.meshgrid(m, m)  # p2[y, x]
    r = np.hypot(mx, my)
    b = np.rint(r).astype(int)
    nb = n // 2 + 1
    mask = b < nb
    sums = np.bincount(b[mask], weights=p2[mask], minlength=nb)
    cnt = np.bincount(b[mask], minlength=nb)
    power = np.where(cnt > 0, sums / np.maximum(cnt, 1), 0.0)
    peak = int(np.argmax(power[1:]) + 1)
    median = float(np.sort(power[1:])[len(power[1:]) // 2]) or 1e-30
    ring = np.abs(r - peak) <= 1.5
    wsum = p2[ring].sum()
    peak_m = float((p2[ring] * r[ring]).sum() / wsum) if wsum > 0 else float(peak)
    # angular distribution (mod 180) within +-2 bins of the peak ring, 36 bins, 3-bin circular smoothing
    sel = (np.abs(r - peak) <= 2) & (r >= 1)
    ang = np.mod(np.arctan2(my[sel], mx[sel]), np.pi)
    hist = np.bincount(np.minimum(35, (ang / np.pi * 36).astype(int)), weights=p2[sel], minlength=36)
    sm = 0.5 * np.roll(hist, 1) + hist + 0.5 * np.roll(hist, -1)
    peaks = [((i + 0.5) * 5.0, float(sm[i])) for i in range(36) if sm[i] > sm[i - 1] and sm[i] >= sm[(i + 1) % 36]]
    peaks.sort(key=lambda p: -p[1])
    top = peaks[0][1] if peaks else 1.0
    return {
        "n": n,
        "peak_bin": peak,
        "peak_k": 2 * np.pi * peak_m / n,
        "peak_wavelength_cells": n / peak_m if peak_m > 0 else None,
        "peak_to_median": float(power[peak] / median),
        "directions_deg": [{"deg": d, "rel": p / top} for d, p in peaks[:4]],
        "u_min": float(u.min()),
        "u_max": float(u.max()),
        "u_std": float(u.std()),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("field")
    ap.add_argument("--n", type=int, default=256)
    ap.add_argument("--predict-k", type=float, default=None)
    ap.add_argument("--expect", choices=["pattern", "none"], default=None)
    ap.add_argument("--json", default=None)
    a = ap.parse_args(argv)
    u = np.fromfile(a.field, dtype="<f4")
    if u.size != a.n * a.n:
        print(json.dumps({"error": f"expected {a.n * a.n} floats, got {u.size}"}))
        return 2
    if not np.all(np.isfinite(u)):
        print(json.dumps({"error": "non-finite values in field"}))
        return 2
    res = spectrum(u.reshape(a.n, a.n).astype(np.float64))
    ok = True
    if a.predict_k is not None:
        res["predicted_k"] = a.predict_k
        res["k_rel_error"] = abs(res["peak_k"] - a.predict_k) / a.predict_k
    if a.expect == "none":
        ok = res["peak_to_median"] < 3
    elif a.expect == "pattern":
        ok = res["peak_to_median"] >= 8 and (a.predict_k is None or res["k_rel_error"] < 0.15)
    res["expect"] = a.expect
    res["ok"] = ok
    out = json.dumps(res, indent=1)
    print(out)
    if a.json:
        with open(a.json, "w") as f:
            f.write(out)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
