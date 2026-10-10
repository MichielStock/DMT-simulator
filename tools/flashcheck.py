#!/usr/bin/env python3
"""flashcheck: photosensitivity check for captured frames (BUILD.md section 4.1).

Usage:
    uv run python tools/flashcheck.py <frames_dir | video> [--fps N] [--json out.json]

Reads a folder of frames (sorted by name; png/jpg) or a video (needs opencv), at the frame rate from
--fps, else <dir>/capture.json, else the video header, else 30. Frames must be captured at real-time
speed (never time-warped).

Checks (exit status 1 on any violation, 2 on error, 0 on pass):
  * General flashes: per signal, a transition is a change of >= FLASH_DELTA relative luminance between
    successive local extrema (hysteresis tracker) whose darker state is < DARK_MAX; a flash is a pair of
    opposing transitions (flashes = transitions / 2). Signals: every tile of a 64x36 grid (region =
    tiles, area must exceed 25%), the whole-frame mean, and a 128x72 grid of point probes (catches
    fine patterns that flicker inside a tile; area again > 25% of probes). Violation if more than
    MAX_FLASHES_PER_S flashes fall in any sliding 1-second window.
  * Red flashes: the same on the saturated-red signal (linear R where R/(R+G+B) >= RED_SAT, ramped in
    from 0.7) per tile and whole frame.
  * Patterns: the frame is split into 8x4 blocks; a block is a high-contrast periodic pattern when its
    2-D spectrum has a dominant peak (>= 3 cycles per block, >= 30% of the AC energy) and its Michelson
    contrast (2nd/98th percentile of linear luminance) exceeds PATTERN_CONTRAST_MAX. A frame with such
    blocks covering more than 25% of the screen is a pattern violation. Periodic patterns (any contrast
    >= 0.1) covering more than 25% whose point probes oscillate faster than PATTERN_HZ_MAX
    (more than 2 * PATTERN_HZ_MAX transitions in 1 s over > 25% of probes) are a pattern-motion violation.
Self-contained: numpy, PIL, scipy (unused if absent); cv2 optional (videos only).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# PROTECTED (BUILD.md §0.7) — threshold constants, identical to frontend/src/safety/thresholds.ts.
FLASH_DELTA = 0.10           # relative luminance change for a transition
DARK_MAX = 0.80              # darker state must be below this
RED_SAT = 0.8                # saturated red: R / (R + G + B) >= 0.8
MAX_FLASHES_PER_S = 3        # ceiling, any 1-second window, either kind
AREA_FRACTION = 0.25         # region larger than 25% of the screen
PATTERN_CONTRAST_MAX = 0.5   # Michelson contrast cap for large periodic patterns
PATTERN_HZ_MAX = 2           # pattern reversal / oscillation / drift cap (Hz)
TILE_GRID = (64, 36)         # analysis tile grid (columns, rows)
WINDOW_S = 1.0               # sliding window
# Analysis-only parameters (not thresholds of the rule itself).
PROBE_GRID = (128, 72)
PATTERN_BLOCKS = (8, 4)
PATTERN_MIN_CYCLES = 3.0
PATTERN_PEAK_FRACTION = 0.30
PATTERN_PERIODIC_MIN_CONTRAST = 0.10
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}


def srgb_lut() -> np.ndarray:
    c = np.arange(256, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return lin.astype(np.float32)


LUT = srgb_lut()


# ------------------------------------------------------------------------------------------------
# Frame sources
def iter_frames(src: Path):
    if src.is_dir():
        files = sorted(p for p in src.iterdir() if p.suffix.lower() in IMAGE_EXT)
        if not files:
            raise SystemExit(f"flashcheck: no image frames in {src}")
        for p in files:
            with Image.open(p) as im:
                yield np.asarray(im.convert("RGB"))
    else:
        try:
            import cv2  # type: ignore
        except ImportError as e:  # pragma: no cover
            raise SystemExit("flashcheck: reading videos needs opencv (cv2)") from e
        cap = cv2.VideoCapture(str(src))
        if not cap.isOpened():
            raise SystemExit(f"flashcheck: cannot open {src}")
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            yield bgr[:, :, ::-1]
        cap.release()


def detect_fps(src: Path, override: float | None) -> tuple[float, dict]:
    meta: dict = {}
    if src.is_dir() and (src / "capture.json").exists():
        try:
            meta = json.loads((src / "capture.json").read_text())
        except Exception:
            meta = {}
    if override:
        return float(override), meta
    if meta.get("fps"):
        return float(meta["fps"]), meta
    if src.is_file():
        try:
            import cv2  # type: ignore
            cap = cv2.VideoCapture(str(src))
            f = cap.get(cv2.CAP_PROP_FPS)
            cap.release()
            if f and f > 0:
                return float(f), meta
        except ImportError:
            pass
    return 30.0, meta


# ------------------------------------------------------------------------------------------------
# Per-frame measurements
def block_means(a: np.ndarray, grid: tuple[int, int]) -> np.ndarray:
    """Mean of a (H, W[, C]) array over a cols x rows grid of near-equal blocks."""
    h, w = a.shape[:2]
    cols, rows = grid
    re = np.linspace(0, h, rows + 1).astype(int)
    ce = np.linspace(0, w, cols + 1).astype(int)
    s = np.add.reduceat(np.add.reduceat(a, re[:-1], axis=0), ce[:-1], axis=1)
    cnt = np.outer(np.diff(re), np.diff(ce)).astype(np.float32)
    if a.ndim == 3:
        cnt = cnt[:, :, None]
    return s / cnt


def red_signal(rgb_lin_means: np.ndarray) -> np.ndarray:
    r = rgb_lin_means[..., 0]
    tot = rgb_lin_means.sum(axis=-1)
    ratio = np.where(tot > 1e-4, r / np.maximum(tot, 1e-4), 0.0)
    weight = np.clip((ratio - (RED_SAT - 0.1)) / 0.1, 0.0, 1.0)
    return (r * weight).astype(np.float32)


def pattern_blocks(y: np.ndarray) -> tuple[float, float, float]:
    """Return (area fraction of high-contrast periodic blocks, area fraction periodic, max contrast)."""
    h, w = y.shape
    if w > 1920:
        f = 1920 / w
        y = np.asarray(Image.fromarray(y).resize((1920, max(1, int(round(h * f)))), Image.BOX))
        h, w = y.shape
    cols, rows = PATTERN_BLOCKS
    re = np.linspace(0, h, rows + 1).astype(int)
    ce = np.linspace(0, w, cols + 1).astype(int)
    bad = 0
    periodic = 0
    max_c = 0.0
    for i in range(rows):
        for j in range(cols):
            b = y[re[i]:re[i + 1], ce[j]:ce[j + 1]].astype(np.float64)
            bh, bw = b.shape
            if bh < 8 or bw < 8:
                continue
            lo, hi = np.percentile(b, [2, 98])
            if hi - lo < 0.02:
                continue
            contrast = (hi - lo) / max(hi + lo, 1e-6)
            if contrast < PATTERN_PERIODIC_MIN_CONTRAST:
                continue
            win = np.outer(np.hanning(bh), np.hanning(bw))
            spec = np.abs(np.fft.fft2((b - b.mean()) * win)) ** 2
            fy = np.fft.fftfreq(bh) * bh
            fx = np.fft.fftfreq(bw) * bw
            rad = np.sqrt(fy[:, None] ** 2 + fx[None, :] ** 2)
            total = spec.sum() - spec[0, 0]
            if total <= 0:
                continue
            masked = np.where(rad >= PATTERN_MIN_CYCLES, spec, 0.0)
            k = np.unravel_index(int(np.argmax(masked)), spec.shape)
            # energy of the peak neighbourhood (3x3, wrapping) and its conjugate mirror
            e = 0.0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    e += spec[(k[0] + dy) % bh, (k[1] + dx) % bw]
                    e += spec[(-k[0] + dy) % bh, (-k[1] + dx) % bw]
            if e / total >= PATTERN_PEAK_FRACTION:
                periodic += 1
                max_c = max(max_c, contrast)
                if contrast > PATTERN_CONTRAST_MAX:
                    bad += 1
    n = rows * cols
    return bad / n, periodic / n, max_c


# ------------------------------------------------------------------------------------------------
# Transition tracking over time (vectorised over signals)
class Tracker:
    def __init__(self, n: int, delta: float, dark_max: float):
        self.delta = delta
        self.dark_max = dark_max
        self.dir = np.zeros(n, np.int8)
        self.ext = np.zeros(n, np.float32)
        self.lo = None
        self.hi = None

    def update(self, v: np.ndarray) -> np.ndarray:
        """Feed one frame; returns a bool array: a qualifying transition happened on this frame."""
        v = v.astype(np.float32).ravel()
        if self.lo is None:
            self.lo = v.copy()
            self.hi = v.copy()
            return np.zeros(v.shape, bool)
        d = self.delta
        out = np.zeros(v.shape, bool)
        z = self.dir == 0
        if z.any():
            self.lo[z] = np.minimum(self.lo[z], v[z])
            self.hi[z] = np.maximum(self.hi[z], v[z])
            up = z & (v - self.lo >= d)
            dn = z & ~up & (self.hi - v >= d)
            out |= (up & (np.minimum(v, self.lo) < self.dark_max)) | (dn & (np.minimum(v, self.hi) < self.dark_max))
            self.dir[up] = 1
            self.dir[dn] = -1
            self.ext[up | dn] = v[up | dn]
        p = self.dir == 1
        n = self.dir == -1
        # rising: extend or reverse
        ext_p = p & (v >= self.ext)
        rev_p = p & ~ext_p & (self.ext - v >= d)
        ext_n = n & (v <= self.ext)
        rev_n = n & ~ext_n & (v - self.ext >= d)
        darker = np.minimum(v, self.ext)
        out |= (rev_p | rev_n) & (darker < self.dark_max)
        self.ext[ext_p | ext_n | rev_p | rev_n] = v[ext_p | ext_n | rev_p | rev_n]
        self.dir[rev_p] = -1
        self.dir[rev_n] = 1
        return out


def window_counts(trans: np.ndarray, w: int) -> np.ndarray:
    """trans: (T, N) bool. Returns (max(T-w+1,1), N) transition counts in every w-frame window."""
    t = trans.shape[0]
    c = np.concatenate([np.zeros((1, trans.shape[1]), np.int32), np.cumsum(trans, axis=0, dtype=np.int32)])
    w = min(w, t)
    return c[w:] - c[:-w] if t >= w else c[-1:] - c[:1]


def area_count(counts: np.ndarray) -> np.ndarray:
    """Per window: the transition count reached by MORE than AREA_FRACTION of the signals."""
    n = counts.shape[1]
    k = int(math.floor(AREA_FRACTION * n))  # index in descending order -> k+1 signals have >= value
    k = min(k, n - 1)
    part = -np.partition(-counts, k, axis=1)
    return part[:, k]


# ------------------------------------------------------------------------------------------------
def analyse(src: Path, fps: float, meta: dict) -> dict:
    tg = Tracker(TILE_GRID[0] * TILE_GRID[1], FLASH_DELTA, DARK_MAX)
    tf = Tracker(1, FLASH_DELTA, DARK_MAX)
    tp = Tracker(PROBE_GRID[0] * PROBE_GRID[1], FLASH_DELTA, DARK_MAX)
    tr = Tracker(TILE_GRID[0] * TILE_GRID[1], FLASH_DELTA, math.inf)
    trf = Tracker(1, FLASH_DELTA, math.inf)
    g_tr, f_tr, p_tr, r_tr, rf_tr = [], [], [], [], []
    pat_bad, pat_periodic, pat_maxc, mean_lum = [], [], [], []
    shape = None
    for rgb in iter_frames(src):
        if shape is None:
            shape = rgb.shape
        lin = LUT[rgb]  # (H, W, 3) float32 linear
        y = lin @ LUMA
        tiles_rgb = block_means(lin, TILE_GRID)
        tiles_y = tiles_rgb @ LUMA
        frame_y = np.array([y.mean()], np.float32)
        h, w = y.shape
        pr = np.linspace(0, h - 1, PROBE_GRID[1]).round().astype(int)
        pc = np.linspace(0, w - 1, PROBE_GRID[0]).round().astype(int)
        probes = y[np.ix_(pr, pc)]
        red_t = red_signal(tiles_rgb)
        red_f = np.array([red_t.mean()], np.float32)
        g_tr.append(tg.update(tiles_y))
        f_tr.append(tf.update(frame_y))
        p_tr.append(tp.update(probes))
        r_tr.append(tr.update(red_t))
        rf_tr.append(trf.update(red_f))
        b, per, mc = pattern_blocks(y)
        pat_bad.append(b)
        pat_periodic.append(per)
        pat_maxc.append(mc)
        mean_lum.append(float(frame_y[0]))
    if shape is None:
        raise SystemExit("flashcheck: no frames")
    nfr = len(g_tr)
    w = max(1, int(round(fps * WINDOW_S)))
    G = window_counts(np.array(g_tr), w)
    F = window_counts(np.array(f_tr), w)
    P = window_counts(np.array(p_tr), w)
    R = window_counts(np.array(r_tr), w)
    RF = window_counts(np.array(rf_tr), w)
    g_area = area_count(G) / 2.0
    p_area = area_count(P) / 2.0
    f_whole = F[:, 0] / 2.0
    r_area = area_count(R) / 2.0
    r_whole = RF[:, 0] / 2.0
    general = np.maximum(np.maximum(g_area, f_whole), p_area)
    red = np.maximum(r_area, r_whole)

    pat_bad_a = np.array(pat_bad)
    pattern_frames = int((pat_bad_a > AREA_FRACTION).sum())
    periodic_frames = np.array(pat_periodic) > AREA_FRACTION
    # pattern motion: windows overlapping periodic frames where probes oscillate faster than PATTERN_HZ_MAX
    per_c = np.concatenate([[0], np.cumsum(periodic_frames.astype(np.int32))])
    ww = min(w, nfr)
    per_in_win = per_c[ww:] - per_c[:-ww] if nfr >= ww else per_c[-1:] - per_c[:1]
    probe_trans_area = area_count(P)
    motion_windows = int(((per_in_win > 0) & (probe_trans_area > 2 * PATTERN_HZ_MAX)).sum())

    def series(a: np.ndarray) -> list[float]:
        return [round(float(x), 2) for x in a[:: max(1, w // 2)]]

    viol = []
    if general.max() > MAX_FLASHES_PER_S:
        viol.append(f"general flashes {general.max():.1f}/s > {MAX_FLASHES_PER_S}")
    if red.max() > MAX_FLASHES_PER_S:
        viol.append(f"red flashes {red.max():.1f}/s > {MAX_FLASHES_PER_S}")
    if pattern_frames:
        viol.append(f"{pattern_frames} frame(s) with high-contrast periodic pattern > {AREA_FRACTION:.0%} of screen")
    if motion_windows:
        viol.append(f"{motion_windows} window(s) with a large periodic pattern oscillating > {PATTERN_HZ_MAX} Hz")
    return {
        "source": str(src),
        "frames": nfr,
        "fps": fps,
        "duration_s": round(nfr / fps, 2),
        "resolution": [int(shape[1]), int(shape[0])],
        "achieved_fps": meta.get("achievedFps"),
        "capture_method": meta.get("method"),
        "max_general_flashes_per_s": round(float(general.max()), 2),
        "max_general_tile_area": round(float(g_area.max()), 2),
        "max_general_whole_frame": round(float(f_whole.max()), 2),
        "max_general_fine_detail": round(float(p_area.max()), 2),
        "max_red_flashes_per_s": round(float(red.max()), 2),
        "pattern_frames": pattern_frames,
        "pattern_motion_windows": motion_windows,
        "max_pattern_area": round(float(pat_bad_a.max()), 3),
        "max_periodic_contrast": round(float(max(pat_maxc)), 3),
        "max_mean_luminance": round(float(max(mean_lum)), 3),
        "general_series": series(general),
        "red_series": series(red),
        "thresholds": {
            "FLASH_DELTA": FLASH_DELTA, "DARK_MAX": DARK_MAX, "RED_SAT": RED_SAT,
            "MAX_FLASHES_PER_S": MAX_FLASHES_PER_S, "AREA_FRACTION": AREA_FRACTION,
            "PATTERN_CONTRAST_MAX": PATTERN_CONTRAST_MAX, "PATTERN_HZ_MAX": PATTERN_HZ_MAX,
            "TILE_GRID": list(TILE_GRID),
        },
        "violations": viol,
        "passed": not viol,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", help="folder of frames or a video file")
    ap.add_argument("--fps", type=float, default=None, help="frame rate (default: capture.json or 30)")
    ap.add_argument("--json", dest="json_out", default=None, help="write the report as JSON")
    args = ap.parse_args(argv)
    src = Path(args.source)
    if not src.exists():
        print(f"flashcheck: {src} not found", file=sys.stderr)
        return 2
    fps, meta = detect_fps(src, args.fps)
    rep = analyse(src, fps, meta)
    print(f"flashcheck: {rep['source']}")
    ach = f", capture achieved {rep['achieved_fps']} fps" if rep["achieved_fps"] is not None else ""
    print(f"  frames {rep['frames']} at {fps:g} fps ({rep['duration_s']} s){ach}")
    print(f"  general flashes: max {rep['max_general_flashes_per_s']}/s in any 1 s window "
          f"(tile area {rep['max_general_tile_area']}, whole frame {rep['max_general_whole_frame']}, "
          f"fine detail {rep['max_general_fine_detail']}; limit {MAX_FLASHES_PER_S})")
    print(f"  red flashes:     max {rep['max_red_flashes_per_s']}/s (limit {MAX_FLASHES_PER_S})")
    print(f"  pattern frames:  {rep['pattern_frames']} (max area {rep['max_pattern_area']}, "
          f"max periodic contrast {rep['max_periodic_contrast']}); motion windows {rep['pattern_motion_windows']}")
    print(f"  max mean luminance {rep['max_mean_luminance']}")
    if rep["achieved_fps"] is not None and rep["achieved_fps"] < 20:
        print(f"  WARNING: capture achieved only {rep['achieved_fps']} fps")
    print("  RESULT: " + ("PASS" if rep["passed"] else "FAIL: " + "; ".join(rep["violations"])))
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(rep, indent=2))
    return 0 if rep["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
