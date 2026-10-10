"""Panorama input (BUILD.md §8.1, §0.6): detect 2:1 equirectangular images; seam-aware depth for them."""
from __future__ import annotations

import numpy as np
from PIL import Image

ASPECT_TOL = 0.05  # aspect within 5% of 2:1


def is_equirect(size: tuple[int, int]) -> bool:
    w, h = size
    return h > 0 and abs((w / h) / 2.0 - 1.0) <= ASPECT_TOL


def to_equirect(img: Image.Image) -> Image.Image:
    """Snap a near-2:1 image to exactly 2:1 (width kept, height = width / 2)."""
    w, h = img.size
    return img if w == 2 * h else img.resize((w, w // 2), Image.LANCZOS)


def wrap_blend(depth_fn, img: Image.Image) -> np.ndarray:
    """Run `depth_fn(PIL) -> float32 HxW (0..1, near=1)` on the panorama and on a copy rolled by half a turn, then
    blend so each column comes mostly from the run in which it is far from that run's left/right image edge.
    The result is continuous across the 360° seam."""
    a = np.asarray(img.convert("RGB"))
    h, w, _ = a.shape
    d1 = depth_fn(img)
    d2 = np.roll(depth_fn(Image.fromarray(np.roll(a, w // 2, axis=1))), -(w // 2), axis=1)
    # match the second run's level/scale to the first on the columns both see well
    x = np.arange(w)
    mid = np.abs(((x + w / 4) % w) - w / 2) < w / 8  # columns at a quarter turn from both seams
    m1, s1 = np.median(d1[:, mid]), d1[:, mid].std() + 1e-6
    m2, s2 = np.median(d2[:, mid]), d2[:, mid].std() + 1e-6
    d2 = (d2 - m2) * (s1 / s2) + m1
    wgt = np.sin(np.pi * (x + 0.5) / w) ** 2  # 1 in the middle of run 1, 0 at its edges (= middle of run 2)
    d = d1 * wgt[None, :] + d2 * (1 - wgt[None, :])
    lo, hi = np.percentile(d, 1), np.percentile(d, 99)
    return np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)
