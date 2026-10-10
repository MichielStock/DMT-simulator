"""Pattern-contrast limiting at the source for world backdrops (BUILD.md §4.1).

A world fills the screen, so any periodic structure in it (tiled floors, arcades, ribbed domes) is a "large
periodic pattern" whose Michelson contrast must stay ≤ 0.5. `limit_pattern_contrast` finds periodic blocks the way
tools/flashcheck.py does (dominant 2-D spectral peak ≥ 3 cycles per block holding ≥ 30% of the AC energy, contrast
from the 2nd/98th percentiles of linear luminance) and compresses only those regions toward their local mean colour
until the contrast is below `target` (0.40, margin under 0.5). Non-periodic detail (stars, figures) is untouched.
Everything is wrap-aware along x, so seamless equirect images stay seamless.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

BLOCK = 64
STEP = 32
TARGET = 0.40


def _to_lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def _to_srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def _block_stats(L: np.ndarray, BLOCK: int = BLOCK, STEP: int = STEP):
    """Per block (BLOCK², stride STEP, wrapping in x): periodic weight (0..1) and Michelson contrast."""
    h, w = L.shape
    ext = np.concatenate([L, L[:, :BLOCK]], axis=1)
    ys = list(range(0, h - BLOCK + 1, STEP))
    xs = list(range(0, w, STEP))
    blocks = np.stack([np.stack([ext[y:y + BLOCK, x:x + BLOCK] for x in xs]) for y in ys])  # (ny, nx, B, B)
    lo = np.percentile(blocks, 2, axis=(2, 3))
    hi = np.percentile(blocks, 98, axis=(2, 3))
    mich = (hi - lo) / np.maximum(hi + lo, 1e-6)
    ac = blocks - blocks.mean(axis=(2, 3), keepdims=True)
    P = np.abs(np.fft.fft2(ac)) ** 2
    fy = np.abs(np.fft.fftfreq(BLOCK) * BLOCK)[:, None]
    fx = np.abs(np.fft.fftfreq(BLOCK) * BLOCK)[None, :]
    low = (np.maximum(fy, fx) < 2)  # below ~3 cycles per block (flashcheck uses >= 3; margin)
    tot = P.sum(axis=(2, 3)) + 1e-9
    Pm = np.where(low[None, None], 0, P)
    # a peak and its conjugate mirror: take twice the max bin as the dominant peak energy
    peak = 2 * Pm.reshape(*Pm.shape[:2], -1).max(-1) / tot
    periodic = np.clip((peak - 0.15) / 0.12, 0, 1)  # ramps in below flashcheck's 30 % so we act with margin
    return periodic, mich, ys, xs


def _field(vals: np.ndarray, ys, xs, h: int, w: int, sigma: float = 10.0, BLOCK: int = BLOCK, STEP: int = STEP) -> np.ndarray:
    """Block-centre values → smooth full-resolution field, wrap-aware in x."""
    import cv2

    ny, nx = vals.shape
    cy = np.array(ys, np.float32) + BLOCK / 2
    cx = np.array(xs, np.float32) + BLOCK / 2
    yy = np.interp(np.arange(h, dtype=np.float32) + 0.5, cy, np.arange(ny, dtype=np.float32))
    ext = np.concatenate([vals[:, -1:], vals, vals[:, :1]], axis=1).astype(np.float32)
    xpos = (np.arange(w, dtype=np.float32) + 0.5 - cx[0]) / STEP + 1  # index into ext
    xpos = np.mod(xpos - 1, nx) + 1
    mx, my = np.meshgrid(xpos, yy)
    f = cv2.remap(ext, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    pad = int(3 * sigma)
    fe = np.concatenate([f[:, -pad:], f, f[:, :pad]], axis=1)
    return cv2.GaussianBlur(fe, (0, 0), sigma)[:, pad:pad + w]


def limit_pattern_contrast(img: Image.Image, target: float = TARGET, passes: int = 4,
                           scales=((128, 64), (64, 32), (32, 16))) -> tuple[Image.Image, dict]:
    """Multi-scale: a pattern seen on screen at a different magnification is caught at one of the block sizes."""
    stats = {}
    for B, S in scales:
        img, st = _limit_one(img, target, passes, B, S)
        stats[f"block{B}"] = st
    return img, stats


def _wrap(a: np.ndarray, pad: int) -> np.ndarray:
    return np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1)


def _limit_one(img: Image.Image, target: float, passes: int, BLOCK: int, STEP: int) -> tuple[Image.Image, dict]:
    """Periodic regions get a luminous floor: dark gaps between bright periodic strokes are filled with the strokes'
    own blurred colour (a bloom) up to hi·(1−t)/(1+t), where hi is the local maximum. Reads as glow, not fog."""
    import cv2

    rgb = _to_lin(np.asarray(img.convert("RGB"), np.float32) / 255.0)
    h, w, _ = rgb.shape
    lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
    stats = {}
    t = target * 0.9
    for it in range(passes + 1):
        L = rgb @ lw
        periodic, mich, ys, xs = _block_stats(L, BLOCK, STEP)
        bad = (periodic > 0.5) & (mich > target)
        stats[f"pass{it}"] = {"periodic_blocks": round(float((periodic > 0.5).mean()), 4),
                              "over_target_blocks": round(float(bad.mean()), 4),
                              "max_periodic_contrast": round(float((mich * (periodic > 0.5)).max()), 3)}
        if it == passes or not bad.any():
            break
        wgt = np.clip(periodic * np.clip((mich - t) / 0.08, 0, 1), 0, 1).astype(np.float32)
        wv = cv2.dilate(_wrap(wgt, 1), np.ones((3, 3), np.uint8))[:, 1:-1]
        wfield = np.clip(_field(wv, ys, xs, h, w, sigma=BLOCK / 3, BLOCK=BLOCK, STEP=STEP), 0, 1)
        pad = 2 * BLOCK
        Le = _wrap(L, pad)
        r = max(3, BLOCK // 4) | 1
        hi = cv2.dilate(Le, np.ones((r, r), np.uint8))
        hi = cv2.GaussianBlur(hi, (0, 0), BLOCK / 6)[:, pad:pad + w]
        floor = hi * (1 - t) / (1 + t) * wfield
        glow = cv2.GaussianBlur(_wrap(rgb, pad), (0, 0), BLOCK / 8)[:, pad:pad + w]
        gL = glow @ lw
        chroma = glow / np.maximum(gL, 1e-4)[..., None]
        cmax = chroma.max(-1, keepdims=True)
        a = np.clip((cmax - 4.0) / np.maximum(cmax - 1.0, 1e-4), 0, 1)
        chroma = chroma * (1 - a) + a
        lift = np.clip(floor - L, 0, None)
        rgb = np.clip(rgb + lift[..., None] * chroma, 0, 1)
    out = Image.fromarray((_to_srgb(rgb) * 255 + 0.5).astype(np.uint8))
    return out, stats


def luminous_floor(img: Image.Image, fraction: float = 0.48, radius: int = 61) -> Image.Image:
    """Design-time contrast floor for procedural worlds built from bright strokes: every pixel is lifted to at least
    `fraction` × the local maximum luminance (radius px, wrap-aware), filled with the strokes' own blurred colour.
    Michelson ≤ (1 − f)/(1 + f) ≈ 0.35 for f = 0.48 in every neighbourhood, so periodic structure stays within §4.1
    (verified with tools/flashcheck.py on 20-s real-time pans, tests/test_assets)."""
    import cv2

    lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
    rgb = _to_lin(np.asarray(img.convert("RGB"), np.float32) / 255.0)
    L = rgb @ lw
    pad = 3 * radius
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius, radius))
    hi = cv2.GaussianBlur(cv2.dilate(_wrap(L, pad), k), (0, 0), radius / 2)
    hi = hi[:, pad:-pad]
    glow = cv2.GaussianBlur(_wrap(rgb, pad), (0, 0), radius / 3)[:, pad:-pad]
    ch = glow / np.maximum(glow @ lw, 1e-4)[..., None]
    cm = ch.max(-1, keepdims=True)
    a = np.clip((cm - 4) / np.maximum(cm - 1, 1e-4), 0, 1)
    ch = ch * (1 - a) + a
    out = np.clip(rgb + np.clip(hi * fraction - L, 0, None)[..., None] * ch, 0, 1)
    return Image.fromarray((_to_srgb(out) * 255 + 0.5).astype(np.uint8))


# ------------------------------------------------------------------------------- view-based verification

def _flashcheck_module():
    import importlib.util

    from backend import runtime

    spec = importlib.util.spec_from_file_location("hs_flashcheck", runtime.ROOT / "tools" / "flashcheck.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def views(img: Image.Image, n: int = 24, size=(640, 360), fov_deg: float = 90.0, pitch_deg: float = 25.0):
    """Perspective views around the sphere band (yaw evenly spaced, pitch alternating ±pitch, 0) as uint8 arrays."""
    import math

    import cv2

    eq = np.asarray(img.convert("RGB"))
    Hh, Ww = eq.shape[:2]
    w, h = size
    f = (w / 2) / math.tan(math.radians(fov_deg) / 2)
    xs, ys = np.meshgrid(np.arange(w) - w / 2 + 0.5, np.arange(h) - h / 2 + 0.5)
    d = np.stack([xs, -ys, np.full_like(xs, f)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    for i in range(n):
        yaw = 2 * math.pi * i / n
        pitch = math.radians(pitch_deg * (0, 1, -1)[i % 3])
        Ry = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
        Rx = np.array([[1, 0, 0], [0, math.cos(pitch), -math.sin(pitch)], [0, math.sin(pitch), math.cos(pitch)]])
        v = d @ (Ry @ Rx).T
        lon = np.arctan2(v[..., 0], v[..., 2])
        lat = np.arcsin(np.clip(v[..., 1], -1, 1))
        yield cv2.remap(eq, (((lon / (2 * np.pi)) % 1.0) * Ww).astype(np.float32),
                        ((0.5 - lat / np.pi) * Hh).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def pattern_views(img: Image.Image, n: int = 24) -> dict:
    """Run flashcheck's own per-frame pattern test (tools/flashcheck.py:pattern_blocks, protected thresholds) on n
    perspective views. → {views, bad_views, max_area, max_contrast}."""
    fc = _flashcheck_module()
    lut = fc.srgb_lut()
    bad, max_area, max_c = 0, 0.0, 0.0
    for v in views(img, n):
        y = lut[v] @ fc.LUMA
        area, _per, c = fc.pattern_blocks(y.astype(np.float32))
        max_area, max_c = max(max_area, area), max(max_c, c)
        bad += area > fc.AREA_FRACTION
    return {"views": n, "bad_views": int(bad), "max_area": round(float(max_area), 3), "max_contrast": round(float(max_c), 3)}


def make_pattern_safe(img: Image.Image, start: float = 0.0, radius: int = 41, finish=None) -> tuple[Image.Image, dict]:
    """Luminous floor at `start`, then `finish` (e.g. pole calming), verified with flashcheck's pattern test on 24
    views; the floor escalates (0.35, 0.45, 0.55, 0.65) until no view violates."""
    info = {"floor": start, "checks": []}
    out = img
    for frac in sorted({start, 0.35, 0.45, 0.55, 0.65}):
        if frac < start:
            continue
        out = luminous_floor(img, frac, radius) if frac > 0 else img
        if finish is not None:
            out = finish(out)
        r = pattern_views(out)
        info["checks"].append({"floor": frac, **r})
        info["floor"] = frac
        if r["bad_views"] == 0:
            info["ok"] = True
            return out, info
    info["ok"] = False
    return out, info
