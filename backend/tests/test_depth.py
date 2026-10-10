"""Room depth, panorama detection and photo import (BUILD.md §8.1, §10, §0.6, §4.6).
Depth convention (CONTRACTS.md amendment): 8-bit greyscale, same size as room.jpg, WHITE = NEAR."""
from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from backend import runtime  # noqa: E402
from backend.assets import panorama, prepare_room, synthetic_depth  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parent / "fixtures" / "images"
SAMPLE = ROOT / "assets" / "sample" / "room.jpg"


def _bands(d: np.ndarray):
    h = d.shape[0]
    return float(d[: h // 5].mean()), float(d[-h // 5:].mean())


def test_equirect_detection_tolerance():
    assert panorama.is_equirect((2048, 1024))
    assert panorama.is_equirect((2000, 1024))      # 1.95:1, within 5 %
    assert panorama.is_equirect((2140, 1024))      # 2.09:1
    assert not panorama.is_equirect((2200, 1024))  # 2.15:1
    assert not panorama.is_equirect((1600, 1200))


def test_synthetic_depth_convention():
    img = Image.open(SAMPLE).convert("RGB") if SAMPLE.exists() else Image.new("RGB", (400, 300), (120, 110, 100))
    d = np.asarray(synthetic_depth(img), np.float32)
    top, bottom = _bands(d)
    assert bottom > top + 40  # floor (bottom) is near = white


def test_prepare_room_strips_metadata_and_writes_depth(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")  # synthetic depth: fast, no model
    raw = (FIX / "photo_gps.jpg").read_bytes()
    assert Image.open(io.BytesIO(raw)).getexif().get_ifd(0x8825)  # the fixture does carry GPS
    r = prepare_room(tmp_path, "photo", raw)
    assert r == {"image": "assets/room.jpg", "depth": "assets/room_depth.png", "source": "photo"}
    im = Image.open(tmp_path / "assets" / "room.jpg")
    assert len(im.getexif()) == 0 and "exif" not in im.info and "icc_profile" not in im.info
    d = Image.open(tmp_path / "assets" / "room_depth.png")
    assert d.mode == "L" and d.size == im.size


def test_panorama_upload_detected_and_non_2to1_panorama_is_a_photo(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")
    r = prepare_room(tmp_path / "a", "panorama", (FIX / "panorama.jpg").read_bytes())
    assert r["source"] == "panorama"
    w, h = Image.open(tmp_path / "a" / "assets" / "room.jpg").size
    assert w == 2 * h
    r = prepare_room(tmp_path / "b", "panorama", (FIX / "photo_gps.jpg").read_bytes())
    assert r["source"] == "photo"
    assert any("panorama" in f for f in runtime.fallbacks())


def test_large_image_downscaled(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")
    buf = io.BytesIO()
    Image.new("RGB", (4000, 3000), (90, 100, 110)).save(buf, "JPEG")
    prepare_room(tmp_path, "photo", buf.getvalue())
    assert max(Image.open(tmp_path / "assets" / "room.jpg").size) == 2048


# ------------------------------------------------------------------------------- real model (gpu)

@pytest.mark.gpu
@pytest.mark.skipif(not SAMPLE.exists(), reason="no sample room photo")
def test_depth_anything_on_sample_room(tmp_path, monkeypatch):
    monkeypatch.delenv("HYPERSPACE_NO_IMAGES", raising=False)
    r = prepare_room(tmp_path, "photo", SAMPLE.read_bytes())
    meta = (tmp_path / "assets" / "room_meta.json").read_text()
    assert "depth_anything_v2_small" in meta
    d = np.asarray(Image.open(tmp_path / "assets" / "room_depth.png"), np.float32)
    im = Image.open(tmp_path / "assets" / "room.jpg")
    assert d.shape == (im.size[1], im.size[0])
    top, bottom = _bands(d)
    assert bottom > top + 40, (top, bottom)       # white = near: the floor in front is brighter
    assert d.std() > 25                           # real structure, not a flat plane
    assert r["source"] == "photo"
    assert all(m["name"] != "depth_anything_v2_small" for m in runtime.resident_models())


@pytest.mark.gpu
def test_panorama_depth_is_continuous_across_the_seam():
    from backend.assets.depth import DepthModel

    img = Image.open(FIX / "panorama.jpg").convert("RGB")
    with DepthModel() as m:
        d = np.asarray(m.estimate(img, panorama=True), np.float32)
    seam = np.abs(d[:, -1] - d[:, 0]).mean()
    inner = np.abs(np.diff(d, axis=1)).mean()
    assert seam <= 3 * inner + 1.0, (seam, inner)
    assert all(m["name"] != "depth_anything_v2_small" for m in runtime.resident_models())
