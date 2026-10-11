"""Spectrograms and level/band metrics of the offline audio renders (BUILD.md section 12, M7).

The WAVs are written by tests/e2e/audio.spec.ts (verification/audio/*.wav, 48 kHz stereo 16 bit,
rendered at master volume 1.0). For each WAV this writes <name>_spectrogram.png next to it:
  top:    spectrogram 20 Hz - 16 kHz (log frequency), 4096-point Hann, 75 % overlap, dB
  middle: 2.5 ms RMS envelope, 6-9 s (the buzz)
  bottom: 10 ms RMS over the whole render (dBFS)
and prints peak dBFS, RMS (6 s to the end, as audio-test.json), the spectral centroid and the
share of power in four bands (< 400 Hz, 400-3000 Hz, 3-6 kHz, > 6 kHz) over the same segment.

  uv run python tools/audio_spectrogram.py [--dir verification/audio] [--compare OTHER_DIR]
      [--json OUT.json] [--no-png]

--compare prints the same metrics for the WAVs of OTHER_DIR (e.g. an earlier render) side by side.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

BANDS = [(0, 400), (400, 3000), (3000, 6000), (6000, 24000)]
BAND_NAMES = ["<400", "400-3k", "3k-6k", ">6k"]


def load(path: Path) -> tuple[int, np.ndarray]:
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.dtype.kind == "f" and np.abs(x).max() <= 1.5:
        pass
    else:
        x = x / 32768.0
    if x.ndim == 1:
        x = x[:, None]
    return sr, x


def metrics(sr: int, x: np.ndarray, t0: float = 6.0) -> dict:
    peak = float(np.abs(x).max())
    seg = x[int(t0 * sr):]
    p = np.mean(seg ** 2)
    mono = seg.mean(axis=1)
    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono)))) ** 2
    f = np.fft.rfftfreq(len(mono), 1 / sr)
    tot = spec[f >= 20].sum() + 1e-30
    shares = {n: float(spec[(f >= lo) & (f < hi) & (f >= 20)].sum() / tot) for n, (lo, hi) in zip(BAND_NAMES, BANDS)}
    centroid = float((f * spec).sum() / (spec.sum() + 1e-30))
    return {
        "peak_dbfs": round(20 * np.log10(peak + 1e-12), 2),
        "rms_dbfs": round(10 * np.log10(p + 1e-15), 2),
        "centroid_hz": round(centroid, 0),
        "band_share_db": {k: round(10 * np.log10(v + 1e-15), 1) for k, v in shares.items()},
    }


def plot(sr: int, x: np.ndarray, out: Path, title: str) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    mono = x.mean(axis=1)
    f, t, z = stft(mono, fs=sr, window="hann", nperseg=4096, noverlap=3072)
    db = 20 * np.log10(np.abs(z) + 1e-9)
    fig, ax = plt.subplots(3, 1, figsize=(12, 9), gridspec_kw={"height_ratios": [3, 1, 1]})
    keep = (f >= 20) & (f <= 16000)
    m = ax[0].pcolormesh(t, f[keep], db[keep], shading="auto", cmap="magma", vmin=-130, vmax=-30)
    ax[0].set_yscale("log")
    ax[0].set_ylabel("Hz")
    ax[0].set_title(title)
    fig.colorbar(m, ax=ax[0], pad=0.01, label="dB")
    hop = int(0.0025 * sr)
    a, b = int(6 * sr), min(len(mono), int(9 * sr))
    seg = (x[a:b] ** 2).mean(axis=1)
    n = len(seg) // hop
    env = np.sqrt(seg[: n * hop].reshape(n, hop).mean(axis=1))
    ax[1].plot(6 + np.arange(n) * hop / sr, env, lw=0.8)
    ax[1].set_ylabel("env (lin)")
    ax[1].set_xlim(6, 9)
    hop = int(0.01 * sr)
    p = (x ** 2).mean(axis=1)
    n = len(p) // hop
    rms = 10 * np.log10(p[: n * hop].reshape(n, hop).mean(axis=1) + 1e-12)
    ax[2].plot(np.arange(n) * 0.01, np.maximum(rms, -80), lw=0.8)
    ax[2].axhline(-3, color="r", lw=0.6, ls="--")
    ax[2].set_ylabel("RMS dBFS (10 ms)")
    ax[2].set_xlabel("s")
    ax[2].set_ylim(-80, 0)
    fig.tight_layout()
    fig.savefig(out, dpi=80)
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default="verification/audio")
    ap.add_argument("--compare", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--no-png", action="store_true")
    args = ap.parse_args(argv)
    d = Path(args.dir)
    wavs = sorted(d.glob("*.wav"))
    if not wavs:
        print(f"no WAVs in {d}", file=sys.stderr)
        return 1
    out: dict = {}
    for w in wavs:
        sr, x = load(w)
        res = {"now": metrics(sr, x)}
        if args.compare and (Path(args.compare) / w.name).exists():
            sr2, x2 = load(Path(args.compare) / w.name)
            res["compare"] = metrics(sr2, x2)
        out[w.stem] = res
        if not args.no_png:
            plot(sr, x, d / f"{w.stem}_spectrogram.png", f"{w.stem}  (render at master volume 1.0)")
    hdr = f"{'file':<13}{'':>8}{'peak':>8}{'rms':>8}{'centr':>7}  " + "".join(f"{n:>8}" for n in BAND_NAMES)
    print(hdr)
    for name, res in out.items():
        for tag, m in res.items():
            print(f"{name:<13}{tag:>8}{m['peak_dbfs']:>8.2f}{m['rms_dbfs']:>8.2f}{m['centroid_hz']:>7.0f}  "
                  + "".join(f"{m['band_share_db'][n]:>8.1f}" for n in BAND_NAMES))
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
