"""Asset generation hook (BUILD.md §10).

`generate_assets(trip_script, session_dir, progress)` is the single entry point the app calls after planning.
For now every world and being is procedural (front-end glyph beings and geometry worlds): it marks the script
accordingly and returns it. The image-generation track replaces the body of `generate_assets` (keeping the
signature) with SDXL generation + the image safety filter; until then nothing is ever loaded onto the card.

`prepare_room(session_dir, source, upload=None)` writes assets/room.jpg (EXIF stripped, ≤ 2048 px) and
assets/room_depth.png using the synthetic-depth fallback of §0.6 (vertical gradient + edge-aware blur).
"""
from __future__ import annotations

import io
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from backend import runtime

IMAGE_BACKEND = "procedural"  # the image track sets this to sdxl_lightning / sdxl_turbo when generation is active
SAMPLE_ROOM = runtime.ROOT / "assets" / "sample" / "room.jpg"
MAX_SIDE = 2048


def generate_assets(trip_script: dict, session_dir, progress: Callable[[str, str], None] | None = None) -> dict:
    """Return the trip script with asset paths/flags filled in. Procedural for now (no models loaded)."""
    bt = trip_script.get("breakthrough") or {}
    if bt.get("world"):
        bt["world"]["procedural"] = True
        bt["world"]["image"] = None
        bt["world"]["images"] = []
    for ent in bt.get("entities") or []:
        ent["procedural"] = True
        ent["sprites"] = []
    trip_script.setdefault("provenance", {})["images"] = "procedural"
    if progress:
        progress("images", "procedural worlds and glyph beings")
    return trip_script


# --------------------------------------------------------------------------- room

def _procedural_room(w: int = 1600, h: int = 1000) -> Image.Image:
    """A plain, warm interior used when no sample photo exists (fallback for assets/sample/room.jpg)."""
    img = Image.new("RGB", (w, h), (182, 160, 132))
    d = ImageDraw.Draw(img)
    horizon = int(h * 0.68)
    for y in range(horizon):  # wall with soft vertical light falloff
        k = 0.85 + 0.15 * (1 - abs(y / horizon - 0.4))
        d.line([(0, y), (w, y)], fill=(int(196 * k), int(178 * k), int(150 * k)))
    for y in range(horizon, h):  # wooden floor
        k = 0.7 + 0.3 * (y - horizon) / (h - horizon)
        d.line([(0, y), (w, y)], fill=(int(120 * k), int(84 * k), int(56 * k)))
    d.rectangle([int(w * 0.62), int(h * 0.12), int(w * 0.86), int(h * 0.5)], fill=(210, 226, 238), outline=(240, 236, 228), width=10)
    d.line([(int(w * 0.74), int(h * 0.12)), (int(w * 0.74), int(h * 0.5))], fill=(240, 236, 228), width=6)
    d.rectangle([int(w * 0.08), int(h * 0.16), int(w * 0.30), int(h * 0.66)], fill=(110, 78, 54))
    for i, y in enumerate(range(int(h * 0.22), int(h * 0.64), int(h * 0.1))):
        d.line([(int(w * 0.08), y), (int(w * 0.30), y)], fill=(80, 56, 38), width=8)
        for j in range(8):
            x = int(w * 0.09) + j * int(w * 0.026)
            d.rectangle([x, y - int(h * 0.07), x + int(w * 0.018), y - 4],
                        fill=[(150, 60, 60), (60, 90, 140), (200, 170, 90), (70, 120, 80)][(i + j) % 4])
    d.rounded_rectangle([int(w * 0.32), int(h * 0.5), int(w * 0.70), int(h * 0.78)], radius=30, fill=(92, 104, 120))
    d.rounded_rectangle([int(w * 0.34), int(h * 0.44), int(w * 0.68), int(h * 0.58)], radius=30, fill=(104, 118, 136))
    d.ellipse([int(w * 0.88), int(h * 0.55), int(w * 0.96), int(h * 0.7)], fill=(150, 96, 70))
    for a in range(12):
        x0 = int(w * 0.92)
        d.line([(x0, int(h * 0.56)), (x0 + int(60 * np.cos(a * 0.5)), int(h * 0.56) - int(90 + 40 * np.sin(a)))],
               fill=(60, 130, 70), width=10)
    return img.filter(ImageFilter.GaussianBlur(1.2))


def _load_upload(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # respect orientation, then drop all metadata by re-encoding
    return img.convert("RGB")


def _downscale(img: Image.Image) -> Image.Image:
    w, h = img.size
    s = MAX_SIDE / max(w, h)
    if s < 1:
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    return img


def synthetic_depth(img: Image.Image) -> Image.Image:
    """§0.6 fallback: vertical gradient (near at the bottom = bright) + edge-aware blur guided by the photo."""
    import cv2

    w, h = img.size
    grad = np.tile(np.linspace(0.15, 1.0, h, dtype=np.float32)[:, None], (1, w))
    gray = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
    # brighter, flatter regions (walls, windows) read slightly further away
    lum = cv2.GaussianBlur(gray, (0, 0), sigmaX=max(2.0, w / 120))
    depth = np.clip(0.8 * grad + 0.2 * (1.0 - lum), 0, 1)
    guide = (gray * 255).astype(np.uint8)
    d8 = (depth * 255).astype(np.uint8)
    for _ in range(2):  # edge-aware smoothing: bilateral on depth, then snap to photo edges
        d8 = cv2.bilateralFilter(d8, 9, 40, 9)
    edges = cv2.Canny(guide, 60, 160)
    d8 = np.where(edges > 0, cv2.medianBlur(d8, 5), d8).astype(np.uint8)
    return Image.fromarray(d8, mode="L")


def prepare_room(session_dir, source: str = "photo", upload: bytes | None = None) -> dict:
    """Write assets/room.jpg and assets/room_depth.png. Returns the API response dict."""
    session_dir = Path(session_dir)
    adir = session_dir / "assets"
    adir.mkdir(parents=True, exist_ok=True)
    if upload:
        img = _load_upload(upload)
    elif SAMPLE_ROOM.exists():
        img = _load_upload(SAMPLE_ROOM.read_bytes())
    else:
        img = _procedural_room()
    img = _downscale(img)
    clean = Image.new("RGB", img.size)
    clean.paste(img)
    clean.save(adir / "room.jpg", "JPEG", quality=92)  # fresh image: no EXIF/GPS
    synthetic_depth(clean).save(adir / "room_depth.png")
    src = source if source in ("photo", "panorama") else "photo"
    if src == "panorama":
        w, h = clean.size
        if abs(w / h - 2.0) > 0.15:  # §0.6: not equirectangular → treat as photo
            src = "photo"
            runtime.note_fallback("panorama: not 2:1, treated as photo")
    return {"image": "assets/room.jpg", "depth": "assets/room_depth.png", "source": src}
