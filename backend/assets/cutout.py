"""Entity cut-outs (BUILD.md §10, §0.6): generated being on flat black → clean RGBA sprite.

Primary: rembg BiRefNet (`birefnet-general`). onnxruntime-gpu here is built for CUDA 13 while torch ships CUDA 12
libraries, so the CUDA provider cannot load and the session runs on the CPU (≈6 s per 1024² image, 24 cores);
the orchestrator runs cut-outs on a worker thread in parallel with GPU generation. Fallback: luminance/chroma key
against the flat background. Last resort: procedural glyph being (procedural.py).

Post-processing (both paths): keep the main connected figure (detached specks and glyph-like clusters such as
stray captions are dropped), slight choke + feather, colour decontamination (un-premultiply against the black
background, so edges carry the figure's colour, not a dark halo), square crop around the figure with margin,
≤ 1024 px. `halo_check` verifies the edge-vs-interior luminance.
"""
from __future__ import annotations

import queue
import threading
import time

import numpy as np
from PIL import Image

from backend import runtime

REGISTRY_NAME = "rembg_birefnet"
MAX_SIDE = 1024
MARGIN = 0.06

N_SESSIONS = 2  # two CPU sessions × half the cores: ≈ 5.3 s/image throughput vs ≈ 9 s with one (measured)

_pool: "queue.Queue | None" = None
_pool_lock = threading.Lock()
_providers: list[str] = ["CPUExecutionProvider"]


def _make_session():
    import os

    import onnxruntime as ort
    from rembg import new_session

    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, (os.cpu_count() or 2) // N_SESSIONS)
    so.inter_op_num_threads = 1
    return new_session("birefnet-general", providers=list(_providers), sess_opts=so)


def _ensure_pool():
    global _pool, _providers
    with _pool_lock:
        if _pool is None:
            try:  # CUDA only if its libraries actually load (they do not with the current wheels)
                import onnxruntime as ort

                if "CUDAExecutionProvider" in ort.get_available_providers() and _cuda_ep_loads():
                    _providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            except Exception:
                pass
            runtime.register(REGISTRY_NAME, "cutout", providers=list(_providers))
            try:
                q = queue.Queue()
                for _ in range(1 if _providers[0] != "CPUExecutionProvider" else N_SESSIONS):
                    q.put(_make_session())
                _pool = q
            except Exception:
                runtime.unregister(REGISTRY_NAME)
                raise
        return _pool


def providers() -> list[str]:
    return list(_providers)


def _cuda_ep_loads() -> bool:
    import ctypes

    for lib in ("libcublasLt.so.13", "libcudart.so.13"):
        try:
            ctypes.CDLL(lib)
        except OSError:
            return False
    return True


def unload() -> None:
    global _pool
    with _pool_lock:
        _pool = None
    import gc

    gc.collect()
    runtime.unregister(REGISTRY_NAME)


# ------------------------------------------------------------------------------------------- masks

def rembg_mask(img: Image.Image) -> np.ndarray:
    from rembg import remove

    pool = _ensure_pool()
    sess = pool.get()
    try:
        m = remove(img.convert("RGB"), session=sess, only_mask=True)
    finally:
        pool.put(sess)
    return np.asarray(m.convert("L"), dtype=np.float32) / 255.0


def key_mask(img: Image.Image) -> np.ndarray:
    """Luminance/chroma key against the flat background colour (estimated from the border)."""
    import cv2

    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    h, w, _ = a.shape
    b = max(4, w // 64)
    border = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((a - bg) ** 2).sum(-1))
    spread = np.percentile(np.sqrt(((border - bg) ** 2).sum(-1)), 95)
    t0 = spread + 0.02
    fg = dist[dist > spread + 0.10]
    ref = float(np.percentile(fg, 60)) if fg.size > 100 else spread + 0.3
    t1 = max(t0 + 0.06, 0.8 * ref)  # glow falls off to black: alpha follows brightness up to the body's level
    m = np.clip((dist - t0) / (t1 - t0), 0, 1).astype(np.float32)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    # fill holes: dark parts of the figure enclosed by it belong to it (flood the background from the border)
    hard = (m > 0.5).astype(np.uint8) * 255
    hard = cv2.morphologyEx(hard, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    flood = hard.copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    for (x, y) in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if flood[y, x] == 0:
            cv2.floodFill(flood, ff, (x, y), 128)
    holes = (flood == 0).astype(np.float32)
    holes = cv2.GaussianBlur(holes, (0, 0), 1.0)
    return np.maximum(m, holes)


# ------------------------------------------------------------------------------------------- post-processing

def keep_main(mask: np.ndarray, min_frac: float = 0.04) -> np.ndarray:
    """Zero every connected component smaller than min_frac of the largest one."""
    import cv2

    hard = (mask > 0.35).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(hard, connectivity=8)
    if n <= 1:
        return mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    big = areas.max()
    keep = np.zeros(n, bool)
    keep[1:] = areas >= min_frac * big
    # soft halo pixels follow their nearest kept core: dilate the kept core a little
    core = keep[lab].astype(np.uint8)
    core = cv2.dilate(core, np.ones((9, 9), np.uint8))
    return mask * core


def refine_edges(img: Image.Image, mask: np.ndarray, band_px: int = 10) -> np.ndarray:
    """On a flat dark background, a figure's glow fades to black: inside a band along the mask boundary, alpha
    follows the pixel's distance from the background colour (so faint glow becomes translucent instead of an
    opaque dark rim). The interior (dark robes included) keeps the segmentation mask."""
    import cv2

    k = key_mask(img)  # brightness-following alpha against the background colour
    hard = (mask > 0.5).astype(np.uint8)
    inner = cv2.erode(hard, np.ones((2 * band_px + 1, 2 * band_px + 1), np.uint8))
    band = cv2.GaussianBlur((hard - inner).astype(np.float32), (0, 0), band_px / 3)
    band = np.clip(band * 1.5, 0, 1) * (1 - inner)
    return mask * (1 - band) + np.minimum(mask, k) * band


def finish(img: Image.Image, mask: np.ndarray) -> Image.Image:
    """Choke, feather, decontaminate, crop square with margin, ≤ MAX_SIDE. Returns RGBA."""
    import cv2

    rgb = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    m = keep_main(np.clip(mask, 0, 1))
    m = cv2.erode(m, np.ones((3, 3), np.uint8))           # 1 px choke: drop the dark fringe
    m = cv2.GaussianBlur(m, (0, 0), 1.2)                  # feather
    # decontaminate: on a black background observed = alpha * F  →  F = observed / alpha (clipped)
    k = np.maximum(m, 0.08)[..., None]
    fg = np.clip(rgb / k, 0, 1)
    fg = np.where(m[..., None] > 0.97, rgb, fg)           # interior untouched
    # bleed the interior colour outwards under the soft edge for very low alpha (avoids noisy edges)
    blur_rgb = cv2.GaussianBlur(rgb * m[..., None], (0, 0), 3)
    blur_m = cv2.GaussianBlur(m, (0, 0), 3)[..., None] + 1e-4
    bleed = np.clip(blur_rgb / blur_m, 0, 1)
    t = np.clip((m - 0.08) / 0.3, 0, 1)[..., None]
    fg = fg * t + bleed * (1 - t)
    rgba = np.dstack([fg, m])
    ys, xs = np.nonzero(m > 0.05)
    h, w = m.shape
    if len(xs) == 0:
        raise ValueError("empty cut-out")
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * MARGIN)) + 2
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    out = np.zeros((side, side, 4), np.float32)
    sx0, sy0 = int(round(cx - side / 2)), int(round(cy - side / 2))
    ax0, ay0, ax1, ay1 = max(0, sx0), max(0, sy0), min(w, sx0 + side), min(h, sy0 + side)
    out[ay0 - sy0:ay1 - sy0, ax0 - sx0:ax1 - sx0] = rgba[ay0:ay1, ax0:ax1]
    im = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
    if side > MAX_SIDE:
        im = im.resize((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    return im


def halo_check(rgba: Image.Image) -> dict:
    """Edge pixels (0.15 < alpha < 0.85) vs interior (alpha > 0.97): mean luminance of the straight colour.
    ok when the edge is at least 0.55× the interior (a dark background halo would sit near 0)."""
    a = np.asarray(rgba.convert("RGBA"), dtype=np.float32) / 255.0
    lum = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    al = a[..., 3]
    edge = (al > 0.15) & (al < 0.85)
    inner = al > 0.97
    if edge.sum() < 10 or inner.sum() < 10:
        return {"ok": False, "edge": 0.0, "interior": 0.0, "ratio": 0.0, "coverage": float((al > 0.5).mean())}
    e, i = float(lum[edge].mean()), float(lum[inner].mean())
    ratio = e / max(i, 1e-6)
    return {"ok": ratio >= 0.55, "edge": round(e, 4), "interior": round(i, 4), "ratio": round(ratio, 3),
            "coverage": round(float((al > 0.5).mean()), 4)}


def cut_out(img: Image.Image, use_rembg: bool = True) -> tuple[Image.Image, dict]:
    """→ (RGBA sprite, info{method, seconds, halo, fallback?}). Raises only if both methods fail."""
    t0 = time.time()
    info: dict = {}
    if not use_rembg:
        info["fallback"] = "luminance/chroma key (rembg time window passed)"
    for method in (("rembg_birefnet", "key") if use_rembg else ("key",)):
        try:
            mask = refine_edges(img, rembg_mask(img)) if method == "rembg_birefnet" else key_mask(img)
            cov = float((mask > 0.5).mean())
            if cov < 0.01 or cov > 0.92:
                raise ValueError(f"implausible mask coverage {cov:.3f}")
            sprite = finish(img, mask)
            halo = halo_check(sprite)
            info.update(method=method, seconds=round(time.time() - t0, 2), halo=halo, coverage=round(cov, 4))
            return sprite, info
        except Exception as e:
            info.setdefault("errors", []).append(f"{method}: {type(e).__name__}: {str(e)[:120]}")
            if method == "rembg_birefnet":
                info["fallback"] = "luminance/chroma key"
    raise RuntimeError("; ".join(info.get("errors", [])))
