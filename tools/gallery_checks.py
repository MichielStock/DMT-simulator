#!/usr/bin/env python3
"""Automated checks for the render galleries (BUILD.md 16.2 "Render galleries", 16.4).

    uv run python tools/gallery_checks.py [verification/gallery] [--layers room,form_constants] [--json out.json]

Reads verification/gallery/<layer>/<layer>_v<v>_s<seed>[_eyes|_challenge].png and the <frame>.json
sidecar written by tests/e2e/gallery.spec.ts (session id, palette, v, seed). Per frame:

* blank:     perceptual luma (sRGB-encoded Rec. 709 Y') standard deviation >= 0.03 (or, for
             iso-luminant colour structure, CIELAB a*b* standard deviation >= 5) AND not uniform (fewer
             than 90% of pixels within 0.02 luma and dE 3 of the median colour).
* pattern:   form_constants (v >= 3, where its entry window is fully crossed; below the bifurcation the
             field is uniform by design) and chrysanthemum (every v): not pure noise. The power spectrum of the luma
             (Hann-windowed, 3x3-smoothed) must have a dominant peak outside DC whose power is >= 8x the
             MEDIAN power of the same spatial-frequency annulus. Computed on the Cartesian image AND on
             the log-polar (retino-cortical) resampling around the view centre, where rings/tunnels,
             funnels, spirals and n-fold radial symmetry all become plane waves; either passes.
             Normalising per annulus (instead of by the global median) is what makes the check reject
             noise: white noise has max/median ~16 globally, and any 1/f texture or smooth blob has a
             huge global ratio, but neither has an anisotropic peak within its annulus.
             Chrysanthemum alternatively passes on strong radial structure: the angular power spectrum,
             averaged over a band of radii, has a harmonic m in 3..96 >= 8x the median of [m/2, 2m]
             (3-bin sums, so an off-centre peak that leaks into m +- 1 counts; noise <= 4.7 incl. the centre search),
             about the view centre or a centre up to 15% away (the Moebius animation moves the disk).
* palette:   at least one trip-script palette colour (from the sidecar, else the session's
             trip_script.json) covers >= 1% of pixels: CIE76 dE <= 20, or same hue (<= 15 deg) with both
             chromas >= 15 and |dL*| <= 35 (the limiter and the layers dim colours). Palette colours with
             L* < 20 are ignored: they would match any dark background. Not applied to the room below
             v = 3 (at v = 1 the room is the user's own photo; BUILD.md 11.3 colour rises with v) nor to
             difficult-passage frames (the palette turns harsh by design, BUILD.md 11.7).
* white:     mean LINEAR relative luminance <= 0.8 (same luminance as flashcheck and the SafetyLimiter).
* stuck:     base frames at v >= 3 differ from the v = 1 frame of the same layer and seed (mean absolute
             RGB difference >= 0.02); eyes-closed and challenge frames differ from their base frame.
* complete:  every expected frame of each checked layer exists.

Prints a table, writes <gallery>/checks.json, exits 1 on any failure (2 on usage errors).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

LAYERS = ["room", "form_constants", "chrysanthemum", "waiting_room", "breakthrough"]
INTENSITIES = [1, 3, 5, 7.5, 9]
SEEDS = [11, 23]
PATTERN_LAYERS = {"form_constants", "chrysanthemum"}

STD_MIN = 0.03
CHROMA_STD_MIN = 5.0       # CIELAB a*b* standard deviation: iso-luminant colour structure is not blank
UNIFORM_FRAC = 0.90
UNIFORM_TOL = 0.02
PEAK_RATIO_MIN = 8.0
RADIAL_MIN = 8.0           # chrysanthemum: alternatively, n-fold radial structure score >= 8
PEAK_SHARE_MIN = 0.005     # the peak neighbourhood must hold >= 0.5% of the AC power
RAY_PROMINENCE = 2.0       # peak power >= 2x the power at half its frequency (same direction)
SMOOTH = 5                 # power-spectrum box smoothing (bins)
PALETTE_COVER_MIN = 0.01
DE_MAX = 20.0
HUE_MAX_DEG = 15.0
CHROMA_MIN = 15.0
DL_MAX = 35.0
PALETTE_L_MIN = 20.0
WHITE_MEAN_MAX = 0.8
STUCK_DIFF_MIN = 0.02

NAME_RE = re.compile(r"^(?P<layer>[a-z_]+?)_v(?P<v>\d+(?:\.\d+)?)_s(?P<seed>\d+)(?:_(?P<kind>eyes|challenge))?\.png$")


# ------------------------------------------------------------------------------------------------
# colour


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load(path: Path) -> np.ndarray:
    """RGB float32 in 0..1 (sRGB-encoded)."""
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    lin = srgb_to_linear(rgb)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]], dtype=np.float64)
    xyz = lin.reshape(-1, 3).astype(np.float64) @ m.T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    d = 6 / 29
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4 / 29)
    lab = np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)
    return lab.reshape(rgb.shape)


def hex_to_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)


def downsample(img: np.ndarray, f: int) -> np.ndarray:
    h, w = img.shape[:2]
    h2, w2 = h // f, w // f
    x = img[:h2 * f, :w2 * f]
    return x.reshape(h2, f, w2, f, *img.shape[2:]).mean(axis=(1, 3))


# ------------------------------------------------------------------------------------------------
# checks


def check_blank(y: np.ndarray, rgb: np.ndarray | None = None) -> dict:
    """Luma std >= STD_MIN, or (iso-luminant colour structure) chroma std >= CHROMA_STD_MIN; and not
    uniform (< 90% of pixels within 0.02 luma AND dE 3 of the median)."""
    std = float(y.std())
    med = float(np.median(y))
    near = np.abs(y - med) <= UNIFORM_TOL
    cstd = 0.0
    if rgb is not None:
        lab = rgb_to_lab(downsample(rgb, 4))
        ab = lab[..., 1:].reshape(-1, 2)
        cstd = float(np.sqrt(ab.var(axis=0).sum()))
        medc = np.median(lab.reshape(-1, 3), axis=0)
        nearc = np.sqrt(((lab - medc) ** 2).sum(axis=-1)) <= 3.0
        near = downsample(near.astype(np.float32), 4)[: nearc.shape[0], : nearc.shape[1]] > 0.5
        near = near & nearc
    frac = float(np.mean(near))
    ok = (std >= STD_MIN or cstd >= CHROMA_STD_MIN) and frac < UNIFORM_FRAC
    return {"ok": ok, "std": round(std, 4), "chroma_std": round(cstd, 2), "uniform_frac": round(frac, 3)}


def _box(p: np.ndarray, n: int = 5) -> np.ndarray:
    out = np.zeros_like(p)
    k = n // 2
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            out += np.roll(np.roll(p, dy, 0), dx, 1)
    return out / (n * n)


def annulus_peak_ratio(img: np.ndarray, window_rows: bool = True, window_cols: bool = True,
                       r_min: float = 3.0) -> tuple[float, tuple[int, int], float, float]:
    """Max over frequency bins (|k| >= r_min) of smoothed power / median smoothed power of the same
    integer |k| annulus, among bins whose smoothed neighbourhood holds >= PEAK_SHARE_MIN of the AC
    power (a real pattern, not a numerical/quantisation floor). Returns (ratio, (ky, kx), share,
    global peak/median for information)."""
    a = img.astype(np.float64) - float(img.mean())
    h, w = a.shape
    if window_rows:
        a = a * np.hanning(h)[:, None]
    if window_cols:
        a = a * np.hanning(w)[None, :]
    p = np.abs(np.fft.fftshift(np.fft.fft2(a))) ** 2
    ky = (np.arange(h) - h // 2)[:, None] * (256.0 / h)
    kx = (np.arange(w) - w // 2)[None, :] * (256.0 / w)
    r = np.sqrt(ky ** 2 + kx ** 2)
    p[r < 1.5] = 0  # DC and the window's leakage around it
    ps = _box(p, SMOOTH)
    ri = np.rint(r).astype(int)
    valid = r >= r_min
    total = float(p[valid].sum())
    if not valid.any() or total <= 0:
        return 0.0, (0, 0), 0.0, 0.0
    share = ps * (SMOOTH * SMOOTH) / total
    ratio = np.zeros_like(ps)
    for k in np.unique(ri[valid]):
        m = (ri == k) & valid
        if m.sum() < 16:
            continue
        med = float(np.median(ps[m]))
        if med > 0:
            ratio[m] = ps[m] / med
    ratio[share < PEAK_SHARE_MIN] = 0
    # a peak must stand above the spectrum half-way towards DC along its own direction, so smooth
    # edges, blobs and 1/f trends (monotonic towards DC) do not count as periodic structure
    iy = np.arange(h)[:, None] - h // 2
    ix = np.arange(w)[None, :] - w // 2
    inner = p[(np.rint(iy * 0.5) + h // 2).astype(int) % h, (np.rint(ix * 0.5) + w // 2).astype(int) % w]
    local = _box(p, 3) * 9  # peak neighbourhood (unsmoothed bins, so the comparison stays local)
    ratio[local < RAY_PROMINENCE * 9 * _box(inner, 3)] = 0
    idx = np.unravel_index(int(np.argmax(ratio)), ratio.shape)
    glob = float(ps[valid].max() / max(1e-30, np.median(ps[valid])))
    return float(ratio[idx]), (int(idx[0] - h // 2), int(idx[1] - w // 2)), float(share[idx]), glob


def log_polar(y: np.ndarray, nr: int = 256, nt: int = 256, r0_frac: float = 0.02,
              centre: tuple[float, float] | None = None) -> np.ndarray:
    """Resample around the image centre (or `centre` = (cx, cy) in pixels) to (log r, theta):
    rows = log radius, cols = angle. The outer radius is half the image height (clamped at the edges)."""
    h, w = y.shape
    cy, cx = (h - 1) / 2, (w - 1) / 2
    rmax = min(cx, cy)
    if centre is not None:
        cx, cy = centre
    rmin = rmax * r0_frac
    lr = np.linspace(math.log(rmin), math.log(rmax), nr)
    th = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    rr = np.exp(lr)[:, None]
    xs = cx + rr * np.cos(th)[None, :]
    ys = cy + rr * np.sin(th)[None, :]
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 2)
    fx = np.clip(xs - x0, 0, 1)
    fy = np.clip(ys - y0, 0, 1)
    return ((y[y0, x0] * (1 - fx) + y[y0, x0 + 1] * fx) * (1 - fy)
            + (y[y0 + 1, x0] * (1 - fx) + y[y0 + 1, x0 + 1] * fx) * fy)


def radial_structure(y: np.ndarray) -> tuple[float, int, tuple[int, int]]:
    """radial_score at the view centre and at offsets up to 15% of the frame (the tiling's centre is
    moved by its Moebius animation); returns (best score, harmonic, centre offset in pixels)."""
    h, w = y.shape
    small = downsample(y, 2) if min(h, w) >= 512 else y
    f = y.shape[0] / small.shape[0]
    sh, sw = small.shape
    best = (0.0, 0, (0.0, 0.0))

    def search(fxs, fys):
        nonlocal best
        for fy in fys:
            for fx in fxs:
                sc, m = radial_score(small, ((sw - 1) / 2 + fx * sw, (sh - 1) / 2 + fy * sh))
                if sc > best[0]:
                    best = (sc, m, (fx, fy))

    search(np.linspace(-0.15, 0.15, 7), np.linspace(-0.15, 0.15, 7))      # coarse, step 5%
    bx, by = best[2]
    search(bx + np.linspace(-0.04, 0.04, 9), by + np.linspace(-0.04, 0.04, 9))  # refine, step 1%
    sc, m, (fx, fy) = best
    return sc, m, (int(round(fx * sw * f)), int(round(fy * sh * f)))


def radial_score(y: np.ndarray, centre: tuple[float, float] | None = None) -> tuple[float, int]:
    """n-fold radial structure about `centre`: the angular power spectrum of each log-polar row,
    averaged incoherently over a radial band (robust to petals that curve or twist with radius);
    score = max over harmonics m in 3..96 of P(m) / median P over [m/2, 2m] (a local peak above the
    trend, so 1/f content stays low), best of the three outer quarter-bands of log radius (the inner
    quarter covers only a few pixels and is noise-dominated). Peak bins are 3-bin sums (m-1..m+1)."""
    lp = log_polar(y, nr=128, centre=centre)
    lp = lp - lp.mean(axis=1, keepdims=True)
    if float(np.sqrt(lp.var(axis=1).mean())) < 0.003:  # no angular variation above 8-bit quantisation
        return 0.0, 0
    pall = np.abs(np.fft.rfft(lp, axis=1)) ** 2
    best, bm = 0.0, 0
    for a in (32, 64, 96):
        pw = pall[a:a + 32].mean(axis=0)
        total = float(pw[1:].sum())
        pw = np.convolve(pw, np.ones(3), mode="same")  # m-1..m+1: leakage of an off-centre peak
        for m in range(3, min(97, len(pw))):
            med = float(np.median(pw[max(1, m // 2):min(len(pw), 2 * m + 1)]))
            r = float(pw[m] / med) if med > 0 and pw[m] >= 3 * PEAK_SHARE_MIN * total else 0.0
            if r > best:
                best, bm = r, m
    return best, bm


def check_pattern(y: np.ndarray, radial: bool = False) -> dict:
    h, w = y.shape
    s = min(h, w)
    crop = y[(h - s) // 2:(h - s) // 2 + s, (w - s) // 2:(w - s) // 2 + s]
    f = max(1, s // 256)
    crop = downsample(crop, f)
    rc, kc, sc, gc = annulus_peak_ratio(crop)
    lp = log_polar(y)
    rl, kl, sl, gl = annulus_peak_ratio(lp, window_rows=True, window_cols=False)  # theta is periodic
    best = max(rc, rl)
    out_radial = {}
    if radial:
        rr, rm, off = radial_structure(y)
        out_radial = {"radial": round(min(rr, 1e6), 2), "radial_harmonic": rm, "radial_centre_offset": off}
        best = max(best, rr if rr >= RADIAL_MIN else 0.0)
    return {"ok": best >= PEAK_RATIO_MIN, **out_radial, "ratio_cartesian": round(min(rc, 1e6), 2), "ratio_logpolar": round(min(rl, 1e6), 2),
            "share_cartesian": round(sc, 4), "share_logpolar": round(sl, 4),
            "peak_cartesian": kc, "peak_logpolar": kl, "global_peak_median": round(min(max(gc, gl), 1e9), 1)}


def check_palette(rgb: np.ndarray, colours: list[str]) -> dict:
    small = downsample(rgb, 4)
    lab = rgb_to_lab(small).reshape(-1, 3)
    c_pix = np.hypot(lab[:, 1], lab[:, 2])
    h_pix = np.degrees(np.arctan2(lab[:, 2], lab[:, 1]))
    best = (0.0, None)
    per = {}
    for hx in colours:
        pl = rgb_to_lab(hex_to_rgb(hx)[None, None, :]).reshape(3)
        if pl[0] < PALETTE_L_MIN:
            per[hx] = None
            continue
        de = np.sqrt(((lab - pl) ** 2).sum(axis=1))
        match = de <= DE_MAX
        c_pal = math.hypot(pl[1], pl[2])
        if c_pal >= CHROMA_MIN:
            h_pal = math.degrees(math.atan2(pl[2], pl[1]))
            dh = np.abs((h_pix - h_pal + 180) % 360 - 180)
            match |= (dh <= HUE_MAX_DEG) & (c_pix >= CHROMA_MIN) & (np.abs(lab[:, 0] - pl[0]) <= DL_MAX)
        cov = float(match.mean())
        per[hx] = round(cov, 4)
        if cov > best[0]:
            best = (cov, hx)
    return {"ok": best[0] >= PALETTE_COVER_MIN, "best": best[1], "coverage": round(best[0], 4), "per_colour": per}


def check_white(rgb: np.ndarray) -> dict:
    m = float(luma(srgb_to_linear(rgb)).mean())
    return {"ok": m <= WHITE_MEAN_MAX, "mean_linear_luminance": round(m, 4)}


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(downsample(a, 8) - downsample(b, 8)).mean())


# ------------------------------------------------------------------------------------------------
# palette source


def sessions_dirs(root: Path) -> list[Path]:
    out = []
    env = os.environ.get("HYPERSPACE_SESSIONS_DIR")
    if env:
        out.append((root / env) if not os.path.isabs(env) else Path(env))
    out.append(root / "sessions")
    out.extend(sorted((root / "verification" / "tmp").glob("*/sessions")))
    return out


def palette_for(side: dict, root: Path) -> list[str] | None:
    pal = side.get("palette")
    if isinstance(pal, dict) and pal.get("colours"):
        return list(pal["colours"])
    sid = side.get("session_id")
    if sid:
        for d in sessions_dirs(root):
            ts = d / sid / "trip_script.json"
            if ts.exists():
                return list(json.loads(ts.read_text())["palette"]["colours"])
    return None


# ------------------------------------------------------------------------------------------------


def fmt_v(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def expected_files(layer: str) -> list[str]:
    out = []
    for s in SEEDS:
        out += [f"{layer}_v{fmt_v(v)}_s{s}.png" for v in INTENSITIES]
        if layer == "room":
            out += [f"{layer}_v{v}_s{s}_eyes.png" for v in (3, 5)]
        out.append(f"{layer}_v9_s{s}_challenge.png")
    return out


def run(gallery: Path, layers: list[str], root: Path) -> dict:
    rows = []
    for layer in layers:
        d = gallery / layer
        present = {p.name for p in d.glob("*.png")} if d.is_dir() else set()
        for name in expected_files(layer):
            if name not in present:
                rows.append({"file": f"{layer}/{name}", "layer": layer, "ok": False,
                             "checks": {"complete": {"ok": False, "missing": True}}})
        imgs: dict[tuple, np.ndarray] = {}
        frames = []
        for p in sorted(d.glob("*.png")) if d.is_dir() else []:
            m = NAME_RE.match(p.name)
            if not m or m.group("layer") != layer:
                continue
            v = float(m.group("v"))
            seed = int(m.group("seed"))
            kind = m.group("kind") or "base"
            rgb = load(p)
            imgs[(v, seed, kind)] = rgb
            frames.append((p, v, seed, kind, rgb))
        for p, v, seed, kind, rgb in frames:
            side_p = p.with_suffix(".json")
            side = json.loads(side_p.read_text()) if side_p.exists() else {}
            y = luma(rgb)
            checks: dict[str, dict] = {}
            checks["blank"] = check_blank(y, rgb)
            checks["white"] = check_white(rgb)
            # form constants exist from their entry window (fully entered at v = 3, BUILD.md 11.2/11.4:
            # the field is uniform below the bifurcation near v = 2); the tiling exists whenever forced
            if layer in PATTERN_LAYERS and (layer != "form_constants" or v >= 3):
                checks["pattern"] = check_pattern(y, radial=layer == "chrysanthemum")
            # palette: not for the room below v = 3 (the user's own photo) and not for difficult-passage
            # frames, whose palette turns harsh by design (BUILD.md 11.7); those must differ from base instead
            if not (layer == "room" and v < 3 and kind == "base") and kind != "challenge":
                pal = palette_for(side, root)
                checks["palette"] = check_palette(rgb, pal) if pal else {"ok": False, "error": "no palette (sidecar/trip_script)"}
            ref = None
            if kind == "base" and v >= 3:
                ref = imgs.get((1.0, seed, "base"))
            elif kind in ("eyes", "challenge"):
                ref = imgs.get((v, seed, "base"))
            if ref is not None:
                dd = mean_abs_diff(rgb, ref)
                checks["stuck"] = {"ok": dd >= STUCK_DIFF_MIN, "diff": round(dd, 4),
                                   "vs": "v1" if kind == "base" else f"v{fmt_v(v)} base"}
            elif kind != "base" or v >= 3:
                checks["stuck"] = {"ok": False, "error": "reference frame missing"}
            rows.append({"file": f"{layer}/{p.name}", "layer": layer, "v": v, "seed": seed, "kind": kind,
                         "session_id": side.get("session_id"), "render_scale": (side.get("render_stats") or {}).get("renderScale"),
                         "ok": all(c["ok"] for c in checks.values()), "checks": checks})
    rows.sort(key=lambda r: (LAYERS.index(r["layer"]) if r["layer"] in LAYERS else 99, r.get("seed", 0), r.get("kind", ""), r.get("v", 0)))
    summary: dict[str, dict] = {}
    for r in rows:
        s = summary.setdefault(r["layer"], {"frames": 0, "failed": 0, "failed_checks": {}})
        s["frames"] += 1
        if not r["ok"]:
            s["failed"] += 1
            for k, c in r["checks"].items():
                if not c["ok"]:
                    s["failed_checks"][k] = s["failed_checks"].get(k, 0) + 1
    return {"ok": bool(rows) and all(r["ok"] for r in rows), "layers": layers, "frames": len(rows),
            "failed": sum(1 for r in rows if not r["ok"]), "summary": summary, "rows": rows,
            "thresholds": {"std_min": STD_MIN, "chroma_std_min": CHROMA_STD_MIN, "uniform_frac": UNIFORM_FRAC, "peak_ratio_min": PEAK_RATIO_MIN,
                           "peak_share_min": PEAK_SHARE_MIN, "radial_min": RADIAL_MIN, "spectrum_smooth": SMOOTH,
                           "palette_cover_min": PALETTE_COVER_MIN, "de_max": DE_MAX, "hue_max_deg": HUE_MAX_DEG,
                           "white_mean_max": WHITE_MEAN_MAX, "stuck_diff_min": STUCK_DIFF_MIN}}


def cell(c: dict | None, key: str) -> str:
    if c is None:
        return "-"
    mark = "ok" if c["ok"] else "FAIL"
    if "missing" in c:
        return "MISSING"
    if "error" in c:
        return f"FAIL({c['error'][:18]})"
    val = {"blank": c.get("std"), "white": c.get("mean_linear_luminance"),
           "pattern": max(c.get("ratio_cartesian", 0), c.get("ratio_logpolar", 0), c.get("radial", 0)),
           "palette": c.get("coverage"), "stuck": c.get("diff")}.get(key)
    return f"{mark} {val}"


def print_table(res: dict) -> None:
    cols = ["blank", "white", "pattern", "palette", "stuck"]
    print(f"{'frame':52s} " + " ".join(f"{c:>13s}" for c in cols) + "  result")
    for r in res["rows"]:
        print(f"{r['file']:52s} " + " ".join(f"{cell(r['checks'].get(c), c):>13s}" for c in cols)
              + ("  pass" if r["ok"] else "  FAIL"))
    for layer, s in res["summary"].items():
        fc = ", ".join(f"{k} {n}" for k, n in s["failed_checks"].items()) or "-"
        print(f"{layer}: {s['frames'] - s['failed']}/{s['frames']} frames pass; failed checks: {fc}")
    print(f"gallery checks: {'PASS' if res['ok'] else 'FAIL'} ({res['frames'] - res['failed']}/{res['frames']} frames)")


def synthetic(kind: str, h: int = 720, w: int = 1280, seed: int = 1) -> np.ndarray:
    """Synthetic luma images for --selftest (0..1)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cx, cy = (w - 1) / 2, (h - 1) / 2
    r = np.hypot(xx - cx, yy - cy) + 1e-6
    th = np.arctan2(yy - cy, xx - cx)
    lr = np.log(r / 8.0)
    if kind == "white_noise":
        return rng.random((h, w))
    if kind == "smooth_noise":  # 1/f^2 (Brownian) clouds
        f = np.fft.fft2(rng.standard_normal((h, w)))
        ky = np.fft.fftfreq(h)[:, None]
        kx = np.fft.fftfreq(w)[None, :]
        k = np.hypot(ky, kx)
        k[0, 0] = 1
        img = np.real(np.fft.ifft2(f / k))
        return (img - img.min()) / (img.max() - img.min())
    if kind == "blob":
        return np.exp(-(r / 300.0) ** 2)
    if kind == "stripes":
        return 0.5 + 0.2 * np.sin(2 * np.pi * (xx * 0.8 + yy * 0.3) / 40)
    if kind == "tunnel":
        return 0.5 + 0.2 * np.sin(6 * lr)
    if kind == "funnel":
        return 0.5 + 0.2 * np.sin(12 * th)
    if kind == "spiral":
        return 0.5 + 0.2 * np.sin(5 * lr + 7 * th)
    if kind == "honeycomb":
        a = sum(np.cos(2 * np.pi * (np.cos(t) * xx + np.sin(t) * yy) / 36) for t in (0, 2 * np.pi / 3, 4 * np.pi / 3))
        return 0.5 + 0.1 * a
    if kind == "flower":  # 7-fold petals on a radial falloff (chrysanthemum-like)
        return (0.3 + 0.25 * np.cos(7 * th + 2 * lr) * np.exp(-(r / 500))) * (r < 340) + 0.05
    raise ValueError(kind)


def selftest() -> int:
    expect = {"white_noise": False, "smooth_noise": False, "blob": False, "stripes": True, "tunnel": True,
              "funnel": True, "spiral": True, "honeycomb": True, "flower": True}
    bad = 0
    rng = np.random.default_rng(7)
    cases = [(k, want, synthetic(k)) for k, want in expect.items()]
    # realistic versions: 8-bit quantised, with grain (sigma 0.04), several noise seeds
    for k, want in list(expect.items()):
        img = synthetic(k, seed=3) + rng.normal(0, 0.04, (720, 1280))
        cases.append((k + "+grain", want, np.round(np.clip(img, 0, 1) * 255) / 255))
    for sd in range(2, 6):
        cases.append((f"white_noise{sd}", False, synthetic("white_noise", seed=sd)))
        cases.append((f"smooth_noise{sd}", False, synthetic("smooth_noise", seed=sd)))
    for k, want, img in cases:
        res = check_pattern(img, radial=True)
        got = res["ok"]
        bad += got != want
        print(f"{k:19s} pattern={got!s:5s} (want {want!s:5s}) cart {res['ratio_cartesian']:8.2f} "
              f"logpolar {res['ratio_logpolar']:8.2f} share {res['share_cartesian']:.3f}/{res['share_logpolar']:.3f} global {res['global_peak_median']}")
    flat = np.full((720, 1280), 0.3)
    b = check_blank(flat)
    bad += b["ok"]
    print(f"flat blank ok={b['ok']} (want False)")
    print("selftest:", "PASS" if not bad else f"FAIL ({bad})")
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("gallery", nargs="?", default="verification/gallery")
    ap.add_argument("--layers", default="", help="comma-separated (default: every layer folder present)")
    ap.add_argument("--json", default=None, help="output (default <gallery>/checks.json)")
    ap.add_argument("--selftest", action="store_true", help="check the pattern/blank detectors on synthetic images")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    root = Path(__file__).resolve().parent.parent
    gallery = Path(a.gallery)
    if not gallery.is_absolute():
        gallery = (Path.cwd() / gallery).resolve()
    layers = [x for x in a.layers.split(",") if x] or [l for l in LAYERS if (gallery / l).is_dir()]
    bad = [l for l in layers if l not in LAYERS]
    if bad or not layers:
        print(f"unknown or no layers: {bad or layers}", file=sys.stderr)
        return 2
    res = run(gallery, layers, root)
    out = Path(a.json) if a.json else gallery / "checks.json"
    prev = {}
    if out.exists() and not a.json:
        try:  # keep rows of layers not re-checked (GALLERY_LAYERS runs) so the sheet stays complete
            prev = json.loads(out.read_text())
        except Exception:
            prev = {}
    merged_rows = [r for r in prev.get("rows", []) if r.get("layer") not in layers] + res["rows"]
    merged = dict(res)
    merged["all_rows"] = merged_rows
    merged["all_ok"] = all(r["ok"] for r in merged_rows) if merged_rows else False
    from datetime import datetime, timezone
    merged["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out.write_text(json.dumps(merged, indent=1))
    print_table(res)
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
