"""Deterministic fixture images for the asset tests (no generated content, nothing graphic).

Run: uv run python -m backend.tests.fixtures.images.make_images
- abstract_bright.png   bright kaleidoscopic abstract (must pass the safety filter)
- red_blotches.png      abstract dark-red blotches on a muted ground (probes the CLIP "a wound" ranking; abstract)
- figure_on_black.png   a glowing synthetic figure on flat black with a few detached specks (cut-out tests)
- photo_gps.jpg         a 4:3 photo-like gradient carrying EXIF with GPS tags (metadata stripping)
- panorama.jpg          a 2:1 seamless equirect-like image (panorama detection / seam-aware depth)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent


def abstract_bright(size=512) -> Image.Image:
    y, x = (np.mgrid[0:size, 0:size] + 0.5) / size - 0.5
    r, t = np.hypot(x, y), np.arctan2(y, x)
    a = np.stack([0.5 + 0.45 * np.cos(8 * t + 20 * r), 0.5 + 0.45 * np.cos(6 * t - 14 * r + 2),
                  0.55 + 0.4 * np.cos(10 * r + 4 * t + 4)], -1)
    return Image.fromarray((np.clip(a, 0, 1) * 235).astype(np.uint8))


def red_blotches(size=512, seed=3) -> Image.Image:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size
    base = np.stack([0.55 + 0 * x, 0.42 + 0 * x, 0.38 + 0 * x], -1)  # muted skin-like ground
    m = np.zeros((size, size))
    for _ in range(9):
        cx, cy, rr = rng.uniform(0.2, 0.8), rng.uniform(0.2, 0.8), rng.uniform(0.04, 0.12)
        d = np.hypot(x - cx, (y - cy) * rng.uniform(0.6, 1.6)) / rr
        m = np.maximum(m, np.exp(-d ** 4))
    red = np.array([0.45, 0.02, 0.03])
    a = base * (1 - m[..., None]) + red * m[..., None]
    return Image.fromarray((a * 255).astype(np.uint8))


def figure_on_black(size=512) -> Image.Image:
    y, x = (np.mgrid[0:size, 0:size] + 0.5) / size - 0.5
    body = np.exp(-((x / 0.12) ** 2 + ((y - 0.08) / 0.3) ** 2) ** 3)
    head = np.exp(-((x / 0.08) ** 2 + ((y + 0.3) / 0.08) ** 2) ** 3)
    m = np.clip(body + head, 0, 1)
    col = np.stack([0.3 + 0.5 * (y + 0.5), 0.5 + 0.3 * np.cos(9 * y), 0.8 - 0.3 * (y + 0.5)], -1)
    a = col * m[..., None]
    for (cx, cy) in ((-0.4, -0.4), (0.38, 0.41), (0.42, -0.3)):  # detached specks
        a += (np.hypot(x - cx, y - cy) < 0.008)[..., None] * 0.7
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def photo_gps() -> Image.Image:
    a = np.zeros((600, 800, 3), np.float32)
    a[..., 0] = np.linspace(0.3, 0.8, 800)[None]
    a[..., 1] = np.linspace(0.6, 0.3, 600)[:, None]
    a[..., 2] = 0.4
    return Image.fromarray((a * 255).astype(np.uint8))


def panorama(w=1024) -> Image.Image:
    h = w // 2
    t = np.linspace(0, 2 * np.pi, w, endpoint=False)[None, :]
    ph = np.linspace(np.pi / 2, -np.pi / 2, h)[:, None]
    a = np.stack([0.4 + 0.3 * np.cos(3 * t) * np.cos(ph), 0.4 + 0.3 * np.sin(2 * t + ph), 0.5 + 0.3 * np.sin(ph) + 0 * t], -1)
    floor = (ph < -0.2) * (0.25 * np.cos(12 * t) * np.cos(8 * ph) + 0.2)
    a = a + floor[..., None]
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def main() -> None:
    abstract_bright().save(HERE / "abstract_bright.png")
    red_blotches().save(HERE / "red_blotches.png")
    figure_on_black().save(HERE / "figure_on_black.png")
    exif = Image.Exif()
    exif[0x010F] = "TestCam"
    gps = {1: "N", 2: (52.0, 22.0, 5.0), 3: "E", 4: (4.0, 53.0, 7.0)}
    exif[0x8825] = gps
    photo_gps().save(HERE / "photo_gps.jpg", "JPEG", exif=exif.tobytes(), quality=90)
    panorama().save(HERE / "panorama.jpg", "JPEG", quality=92)


if __name__ == "__main__":
    main()
