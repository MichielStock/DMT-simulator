"""PROTECTED (BUILD.md §0.7, §16.2 "Safety"): tools/flashcheck.py on synthetic frame folders."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "flashcheck.py"
W, H = 320, 180


def lin_to_srgb8(y: float) -> int:
    c = 12.92 * y if y <= 0.0031308 else 1.055 * y ** (1 / 2.4) - 0.055
    return int(round(np.clip(c, 0, 1) * 255))


def write_frames(d: Path, frames, fps: float) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    for i, arr in enumerate(frames):
        Image.fromarray(arr.astype(np.uint8), "RGB").save(d / f"frame_{i + 1:06d}.png")
    (d / "capture.json").write_text(json.dumps({"fps": fps, "achievedFps": fps, "method": "synthetic"}))
    return d


def solid(rgb) -> np.ndarray:
    return np.broadcast_to(np.array(rgb, np.uint8), (H, W, 3)).copy()


def flicker(hz: float, fps: float, seconds: float, a, b):
    out = []
    for f in range(int(seconds * fps)):
        on = int(np.floor(f / fps * hz * 2 + 1e-9)) % 2 == 0
        out.append(solid(a if on else b))
    return out


def stripes(period_px: int, lo_lin: float, hi_lin: float, n: int, phase_flip_hz: float = 0.0, fps: float = 30):
    lo, hi = lin_to_srgb8(lo_lin), lin_to_srgb8(hi_lin)
    x = np.arange(W)
    out = []
    for f in range(n):
        ph = int(np.floor(f / fps * phase_flip_hz * 2)) % 2 if phase_flip_hz else 0
        row = np.where(((x // (period_px // 2)) + ph) % 2 == 0, hi, lo).astype(np.uint8)
        img = np.repeat(np.repeat(row[None, :, None], H, axis=0), 3, axis=2)
        out.append(img)
    return out


def run(d: Path, *extra: str):
    out_json = d / "report.json"
    p = subprocess.run([sys.executable, str(TOOL), str(d), "--json", str(out_json), *extra],
                       capture_output=True, text=True, timeout=600)
    rep = json.loads(out_json.read_text()) if out_json.exists() else None
    return p.returncode, rep, p.stdout + p.stderr


def test_bw_10hz_fails(tmp_path):
    d = write_frames(tmp_path / "bw10", flicker(10, 60, 3, (255, 255, 255), (0, 0, 0)), 60)
    code, rep, out = run(d)
    assert code == 1, out
    assert rep["max_general_flashes_per_s"] > 3
    assert not rep["passed"]


def test_2hz_passes(tmp_path):
    d = write_frames(tmp_path / "bw2", flicker(2, 60, 3, (255, 255, 255), (0, 0, 0)), 60)
    code, rep, out = run(d)
    assert code == 0, out
    assert rep["max_general_flashes_per_s"] <= 3


def test_red_8hz_fails(tmp_path):
    d = write_frames(tmp_path / "red8", flicker(8, 60, 3, (255, 0, 0), (0, 0, 0)), 60)
    code, rep, out = run(d)
    assert code == 1, out
    assert rep["max_red_flashes_per_s"] > 3


def test_red_4hz_low_luminance_still_counted_as_red(tmp_path):
    # saturated red <-> darker saturated red: red flashes are counted even at modest luminance
    d = write_frames(tmp_path / "red4", flicker(4, 60, 3, (255, 0, 0), (90, 0, 0)), 60)
    code, rep, out = run(d)
    assert rep["max_red_flashes_per_s"] >= 3.5, out
    assert code == 1


def test_high_contrast_static_stripes_pattern_violation(tmp_path):
    d = write_frames(tmp_path / "stripes_hi", stripes(16, 0.0, 1.0, 20), 30)
    code, rep, out = run(d)
    assert code == 1, out
    assert rep["pattern_frames"] == 20
    assert rep["max_general_flashes_per_s"] == 0


def test_low_contrast_stripes_pass(tmp_path):
    d = write_frames(tmp_path / "stripes_lo", stripes(16, 0.35, 0.65, 20), 30)  # Michelson 0.30
    code, rep, out = run(d)
    assert code == 0, out
    assert rep["pattern_frames"] == 0
    assert 0.2 < rep["max_periodic_contrast"] < 0.4


def test_low_contrast_stripes_reversing_fast_fail(tmp_path):
    # contrast within the cap, but the pattern reverses at 6 Hz (> PATTERN_HZ_MAX) over the whole screen
    d = write_frames(tmp_path / "stripes_rev", stripes(16, 0.35, 0.65, 60, phase_flip_hz=6, fps=30), 30)
    code, rep, out = run(d)
    assert code == 1, out
    assert rep["pattern_motion_windows"] > 0 or rep["max_general_fine_detail"] > 3


def test_soft_1hz_pulse_passes(tmp_path):
    fps = 30
    frames = []
    for f in range(4 * fps):
        y = 0.3 + 0.25 * np.sin(2 * np.pi * 1.0 * f / fps)
        frames.append(solid((lin_to_srgb8(y),) * 3))
    d = write_frames(tmp_path / "pulse1", frames, fps)
    code, rep, out = run(d)
    assert code == 0, out
    assert rep["max_general_flashes_per_s"] <= 1.5


def test_small_area_flicker_passes(tmp_path):
    frames = []
    for f in range(90):
        img = solid((40, 40, 40))
        if (f // 3) % 2 == 0:
            img[: H // 4, : W // 4] = 255  # 1/16 of the screen at 10 Hz
        frames.append(img)
    d = write_frames(tmp_path / "small", frames, 60)
    code, rep, out = run(d)
    assert code == 0, out


def test_fps_from_argument_and_video_free_folder(tmp_path):
    d = write_frames(tmp_path / "arg", flicker(10, 60, 2, (255, 255, 255), (0, 0, 0)), 60)
    (d / "capture.json").unlink()
    code, rep, _ = run(d, "--fps", "60")
    assert code == 1 and rep["fps"] == 60


def test_thresholds_match_frontend():
    ts = (ROOT / "frontend" / "src" / "safety" / "thresholds.ts").read_text()
    py = TOOL.read_text()
    for name, val in [("FLASH_DELTA", "0.10"), ("DARK_MAX", "0.80"), ("RED_SAT", "0.8"),
                      ("MAX_FLASHES_PER_S", "3"), ("AREA_FRACTION", "0.25"),
                      ("PATTERN_CONTRAST_MAX", "0.5"), ("PATTERN_HZ_MAX", "2")]:
        assert f"export const {name} = {val};" in ts, name
        assert f"{name} = {val}" in py, name
    assert "TILE_GRID: readonly [number, number] = [64, 36]" in ts
    assert "TILE_GRID = (64, 36)" in py
    assert "PROTECTED (BUILD.md §0.7)" in ts and "PROTECTED (BUILD.md §0.7)" in py


@pytest.mark.parametrize("hz,flashes", [(1, 1.0), (3, 3.0), (4, 4.0)])
def test_square_wave_rates(tmp_path, hz, flashes):
    # an N Hz square wave = 2N transitions per second = N flashes; only > 3 is a violation
    d = write_frames(tmp_path / f"sq{hz}", flicker(hz, 30, 3, (230, 230, 230), (20, 20, 20)), 30)
    code, rep, out = run(d)
    assert rep["max_general_flashes_per_s"] == pytest.approx(flashes, abs=0.51), out
    assert code == (1 if flashes > 3 else 0), out
