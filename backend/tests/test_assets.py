"""Asset generation (BUILD.md §10, §16.2 "Assets", §16.4 "Breakthrough").

Fast tests: procedural worlds (seamless, no pole detail, never near-white), glyph beings (deterministic, RGBA,
three variants), cut-out post-processing (no halo, specks dropped), room-only fast path.
GPU tests (marked `gpu`, run by default here): the real pipeline within the §10 budget, then a full session
through the API with real images: models unloaded at ready (/api/status resident_models == []), manifest
provenance, seamless worlds, clean sprites.
"""
from __future__ import annotations

import importlib
import json
import os
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from backend import runtime  # noqa: E402
from backend.assets import cutout, procedural  # noqa: E402
from backend.assets.imagegen import calm_poles, seam_score, wrap_resize  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parent / "fixtures" / "images"
JEWEL = ["#1b0a3c", "#5b1a8f", "#c2187a", "#e8a33b", "#1f8f7a", "#3a5bd9"]
NEON = ["#0d0221", "#ff2a6d", "#05d9e8", "#d1f7ff", "#7b2ff7", "#f9c80e"]
SEAM_MAX = 1.6  # seam difference / typical neighbouring-column difference


def _lin_lum(img: Image.Image) -> np.ndarray:
    a = np.asarray(img.convert("RGB"), np.float32) / 255.0
    a = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return a @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def check_world(img: Image.Image) -> None:
    assert img.size == (2048, 1024)
    s = seam_score(img)
    assert s["ratio"] <= SEAM_MAX, s
    a = np.asarray(img.convert("RGB"), np.float32)
    for row in (a[0], a[-1]):  # poles: the extreme rows carry no detail (no pinch)
        assert row.std(axis=0).max() < 6.0
    lum = _lin_lum(img)
    assert np.percentile(lum, 99.5) < 0.85 and lum.mean() < 0.6  # never near-white


def check_sprite(img: Image.Image) -> dict:
    assert img.mode == "RGBA" and img.size[0] == img.size[1] and img.size[0] <= 1024
    al = np.asarray(img, np.float32)[..., 3] / 255.0
    assert 0.03 < (al > 0.5).mean() < 0.9
    edge = np.concatenate([al[0], al[-1], al[:, 0], al[:, -1]])
    assert edge.max() < 0.35  # the figure is not cut off by the crop
    h = cutout.halo_check(img)
    assert h["ok"], h
    return h


# ------------------------------------------------------------------------------------------ procedural

@pytest.mark.parametrize("category", ["dome_temple", "infinite_hall", "cosmic_space", "carnival", "organic_jungle",
                                      "geometric_chamber", "workshop"])
def test_procedural_worlds_are_seamless_and_safe(category):
    img = procedural.world(category, JEWEL if hash(category) % 2 else NEON, 5)
    check_world(img)
    assert np.asarray(img).std() > 12  # real structure


def test_procedural_world_deterministic():
    a = np.asarray(procedural.world("dome_temple", JEWEL, 9))
    b = np.asarray(procedural.world("dome_temple", JEWEL, 9))
    c = np.asarray(procedural.world("dome_temple", JEWEL, 10))
    assert (a == b).all() and not (a == c).all()


def test_glyph_alphabet_deterministic():
    a, b = procedural.glyph_alphabet(4), procedural.glyph_alphabet(4)
    assert all(np.allclose(x, y) for ga, gb in zip(a, b) for x, y in zip(ga, gb))
    assert procedural.glyph_alphabet(5)[0][0].tolist() != a[0][0].tolist()


@pytest.mark.parametrize("etype", ["jester", "living_geometry"])
def test_glyph_beings(etype):
    vs = procedural.glyph_being_variants(etype, NEON, 77)
    assert len(vs) == 3
    for v in vs:
        assert v.size == (1024, 1024)
        check_sprite(v)
    arrs = [np.asarray(v, np.float32) for v in vs]
    assert np.abs(arrs[0] - arrs[1]).mean() > 1 and np.abs(arrs[0] - arrs[2]).mean() > 1  # distinct variants
    assert (np.asarray(procedural.glyph_being(etype, NEON, 77, 0)) == arrs[0].astype(np.uint8)).all()
    lum = _lin_lum(vs[0].convert("RGB"))
    assert np.percentile(lum, 99.9) < 0.9


def test_wrap_resize_and_calm_poles_keep_the_seam():
    rng = np.random.default_rng(0)
    base = procedural._periodic_noise(rng, (256, 512))
    img = Image.fromarray((np.stack([base] * 3, -1) * 200).astype(np.uint8))
    out = calm_poles(wrap_resize(img, (2048, 1024)))
    assert seam_score(out)["ratio"] <= SEAM_MAX


# ------------------------------------------------------------------------------------------ cut-outs

def test_key_cutout_drops_specks_and_has_no_halo():
    img = Image.open(FIX / "figure_on_black.png").convert("RGB")
    sprite, info = cutout.cut_out(img, use_rembg=False)
    assert info["method"] == "key"
    h = check_sprite(sprite)
    assert h["ratio"] > 0.55
    al = np.asarray(sprite)[..., 3]
    import cv2

    n, _, stats, _ = cv2.connectedComponentsWithStats((al > 64).astype(np.uint8))
    assert n - 1 == 1  # one figure, the three detached specks are gone


@pytest.mark.gpu
def test_rembg_cutout_on_fixture():
    img = Image.open(FIX / "figure_on_black.png").convert("RGB").resize((1024, 1024))
    try:
        sprite, info = cutout.cut_out(img)
    finally:
        cutout.unload()
    assert info["method"] in ("rembg_birefnet", "key")
    check_sprite(sprite)
    assert all(m["name"] != cutout.REGISTRY_NAME for m in runtime.resident_models())


# ------------------------------------------------------------------------------------------ orchestration

def _script(dose: str, seed: int, want_beings: bool = True):
    from backend.planner.expand import assemble_trip_script, expand_with_provenance
    from backend.planner.sampler import sample_skeleton
    from backend.tests._helpers import intake_for

    for s in range(seed, seed + 80):
        intake = intake_for(s, dose)
        sk = sample_skeleton(intake, s)
        exp, prov = expand_with_provenance(sk, intake, s)
        ts = assemble_trip_script(sk, exp, intake, None, planner=prov)
        bt = ts["breakthrough"]
        if not want_beings or (bt["world"] and bt["entities"]):
            return ts
    raise AssertionError("no matching script")


def test_room_only_fast_path(tmp_path, monkeypatch):
    import backend.assets as A

    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")
    ts = _script("threshold", 3, want_beings=False)
    ts["breakthrough"]["world"] = None
    ts["breakthrough"]["entities"] = []
    t = time.time()
    out = A.generate_assets(ts, tmp_path, None)
    assert time.time() - t < 2.0
    man = json.loads((tmp_path / "assets" / "manifest.json").read_text())
    assert out["provenance"]["images"] == "procedural" and man["unload"]["ok"]
    assert not list((tmp_path / "assets").glob("world_*.png"))


def test_no_images_mode_is_procedural_and_never_loads(tmp_path, monkeypatch):
    import sys

    import backend.assets as A
    from backend.planner.expand import validate_trip_script

    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")
    ts = _script("breakthrough", 20261010)
    out = A.generate_assets(ts, tmp_path, None)
    assert validate_trip_script(out) == []
    w = out["breakthrough"]["world"]
    assert w["procedural"] and w["image"] == "assets/world_0.png"
    check_world(Image.open(tmp_path / w["image"]))
    for e in out["breakthrough"]["entities"]:
        assert e["procedural"] and e["sprites"] == [] and len(e["glyph_sprites"]) == 3
    assert out["provenance"]["images"] == "procedural"
    assert "diffusers" not in sys.modules or runtime.resident_models() == []


# ------------------------------------------------------------------------------------------ real models (gpu)

def _check_generated(sdir: Path, ts: dict, man: dict) -> None:
    bt = ts["breakthrough"]
    assert man["filter"]["status"] == "loaded"
    assert man["budget"]["generation_seconds"] <= 90.0
    planned = man["plan"]["worlds"] + 3 * len(man["plan"]["beings_generated"])
    assert planned <= 12
    for a in man["assets"]:
        if a["kind"] in ("world", "entity"):
            assert a["generator"] in ("sdxl_lightning", "procedural")
            if a["generator"] != "procedural":
                assert a["filter"]["ok"] and "scores" in a["filter"] and isinstance(a["seed"], int)
                assert "negative_prompt" in a and all(w in a["negative_prompt"] for w in
                                                      ("text", "letters", "watermark", "gore", "blood", "nudity"))
    for p in bt["world"]["images"]:
        check_world(Image.open(sdir / p))
    for e in bt["entities"]:
        for p in (e["sprites"] or e.get("glyph_sprites") or []):
            check_sprite(Image.open(sdir / p))
    assert man["unload"]["ok"] and man["unload"]["allocated_mb"] < 200
    assert set(ts["provenance"]) == {"planner", "images"} and (sdir / "assets" / "manifest.json").exists()


@pytest.mark.gpu
def test_generation_smoke_within_budget(tmp_path, monkeypatch):
    import backend.assets as A
    from backend.planner.expand import validate_trip_script

    monkeypatch.delenv("HYPERSPACE_NO_IMAGES", raising=False)
    ts = _script("breakthrough", 20261010)
    t = time.time()
    out = A.generate_assets(ts, tmp_path, None)
    total = time.time() - t
    man = json.loads((tmp_path / "assets" / "manifest.json").read_text())
    assert validate_trip_script(out) == []
    _check_generated(tmp_path, out, man)
    assert out["provenance"]["images"] == "sdxl_lightning"

    for k, p in enumerate(out["breakthrough"]["world"]["images"]):  # §4.1 patterns, views over the sphere band
        _pan_frames(Image.open(tmp_path / p), tmp_path / f"pan{k}", n=60)
        rep = _flashcheck(tmp_path / f"pan{k}")
        assert rep["pattern_frames"] == 0, rep["violations"]
    assert total < 120, total
    assert runtime.resident_models() == []
    import torch

    assert torch.cuda.memory_allocated() < 200 * 2 ** 20


@pytest.mark.gpu
def test_full_session_through_api_with_real_images(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")
    monkeypatch.delenv("HYPERSPACE_NO_IMAGES", raising=False)
    monkeypatch.setenv("HYPERSPACE_SESSIONS_DIR", str(tmp_path / "sessions"))
    from fastapi.testclient import TestClient

    import backend.app as appmod

    importlib.reload(appmod)
    with TestClient(appmod.create_app()) as c:
        sid = c.post("/api/session", json={"seed": 4242}).json()["id"]
        r = c.post(f"/api/session/{sid}/room", files={"file": ("room.jpg", (ROOT / "assets/sample/room.jpg").read_bytes(),
                                                               "image/jpeg")}, data={"kind": "photo"})
        assert r.status_code == 200 and r.json()["source"] == "photo"
        intake = json.loads((ROOT / "tests/e2e/profiles/neutral.json").read_text())
        intake.update(dose_step="breakthrough", seed=4242)
        intake["room"] = {"source": "photo", "image": "assets/room.jpg", "depth": "assets/room_depth.png"}
        assert c.post(f"/api/session/{sid}/intake", json=intake).json()["accepted"]
        t0, details = time.time(), set()
        while True:
            p = c.get(f"/api/session/{sid}/progress").json()
            details.add(p["lines"][1]["detail"])
            if p["ready"] or p["stage"] == "error":
                break
            assert time.time() - t0 < 240, p
            time.sleep(0.2)
        assert p["ready"], p
        st = c.get("/api/status").json()
        assert st["resident_models"] == []
        assert st["images"] == "sdxl_lightning"
        ts = c.get(f"/api/session/{sid}/trip_script").json()
        sdir = tmp_path / "sessions" / sid
        man = json.loads((sdir / "assets" / "manifest.json").read_text())
        _check_generated(sdir, ts, man)
        assert "depth_anything_v2_small" in (sdir / "assets" / "room_meta.json").read_text()
        assert any(d.startswith("being ") for d in details) or not ts["breakthrough"]["entities"]
        # files are served for the front end
        w = ts["breakthrough"]["world"]["image"]
        assert c.get(f"/sessions/{sid}/{w}").status_code == 200


# ------------------------------------------------------------------------------------------ §4.1 pattern rule

def _pan_frames(img: Image.Image, out: Path, n: int = 90, fps: int = 30, realtime: bool = False) -> None:
    """Perspective views (640×360, 90° fov) of the equirect world. realtime=True: a real-time pan (3°/s yaw, slow
    ±10° pitch) for the temporal checks; otherwise sparse views over the whole sphere band (±25° pitch) for the
    per-frame pattern check only."""
    import math

    import cv2

    out.mkdir(parents=True, exist_ok=True)
    eq = np.asarray(img.convert("RGB"))
    Hh, Ww = eq.shape[:2]
    w, h = 640, 360
    f = (w / 2) / math.tan(math.radians(45))
    xs, ys = np.meshgrid(np.arange(w) - w / 2 + 0.5, np.arange(h) - h / 2 + 0.5)
    d = np.stack([xs, -ys, np.full_like(xs, f)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    for i in range(n):
        if realtime:
            t = i / fps
            yaw, pitch = math.radians(3 * t), math.radians(10 * math.sin(t * 0.3))
        else:
            yaw, pitch = 2 * math.pi * i / n, math.radians(25 * math.sin(i * 0.7))
        Ry = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
        Rx = np.array([[1, 0, 0], [0, math.cos(pitch), -math.sin(pitch)], [0, math.sin(pitch), math.cos(pitch)]])
        v = d @ (Ry @ Rx).T
        lon = np.arctan2(v[..., 0], v[..., 2])
        lat = np.arcsin(np.clip(v[..., 1], -1, 1))
        fr = cv2.remap(eq, (((lon / (2 * np.pi)) % 1.0) * Ww).astype(np.float32), ((0.5 - lat / np.pi) * Hh).astype(np.float32),
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        Image.fromarray(fr).save(out / f"f{i:04d}.png")


def _flashcheck(frames: Path) -> dict:
    import subprocess
    import sys

    subprocess.run([sys.executable, str(ROOT / "tools" / "flashcheck.py"), str(frames), "--fps", "30",
                    "--json", str(frames / "fc.json")], capture_output=True, text=True)
    return json.loads((frames / "fc.json").read_text())


@pytest.mark.parametrize("category", ["dome_temple", "infinite_hall", "carnival", "cosmic_space"])
def test_procedural_world_views_have_no_large_high_contrast_pattern(category, tmp_path):
    _pan_frames(procedural.world(category, NEON, 3), tmp_path / "frames")
    rep = _flashcheck(tmp_path / "frames")
    assert rep["pattern_frames"] == 0, rep["violations"]


def test_procedural_world_realtime_pan_passes_flashcheck(tmp_path):
    _pan_frames(procedural.world("dome_temple", JEWEL, 4), tmp_path / "frames", n=300, realtime=True)
    rep = _flashcheck(tmp_path / "frames")
    assert rep["passed"], rep["violations"]
