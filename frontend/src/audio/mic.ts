// Optional microphone (BUILD.md §12, off by default). The stream feeds an AnalyserNode only; it is
// never connected to the speakers. The reading {level, centroid} is exposed for geometry to use
// (speed and hue); the audio module does not drive geometry itself.

import { clamp01 } from './synth';

export interface MicReading {
  level: number;       // 0–1 loudness (−60 … −10 dBFS RMS mapped linearly), smoothed
  centroid: number;    // 0–1 spectral centroid on a log scale 100 Hz … 8 kHz, smoothed
  centroidHz: number;
}

export interface Mic {
  read(dtSec: number): MicReading;
  dispose(): void;
}

/** Pure: spectral centroid (Hz) of an AnalyserNode byte/float dB spectrum. */
export function spectralCentroid(dbSpectrum: Float32Array, sampleRate: number, fftSize: number): number {
  let num = 0;
  let den = 0;
  const binHz = sampleRate / fftSize;
  for (let i = 1; i < dbSpectrum.length; i++) {
    const db = dbSpectrum[i];
    if (!Number.isFinite(db)) continue;
    const mag = Math.pow(10, db / 20);
    num += mag * i * binHz;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}
export function centroidNorm(hz: number): number {
  if (hz <= 100) return 0;
  return clamp01(Math.log(hz / 100) / Math.log(80));
}
export function levelNorm(rmsDb: number): number {
  return clamp01((rmsDb + 60) / 50);
}

export async function createMic(ctx: AudioContext): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.5;
  src.connect(an); // analysis only: not connected to the destination
  const time = new Float32Array(an.fftSize);
  const freq = new Float32Array(an.frequencyBinCount);
  const r: MicReading = { level: 0, centroid: 0, centroidHz: 0 };
  return {
    read(dt: number) {
      an.getFloatTimeDomainData(time);
      let s = 0;
      for (let i = 0; i < time.length; i++) s += time[i] * time[i];
      const rmsDb = 10 * Math.log10(s / time.length + 1e-12);
      an.getFloatFrequencyData(freq);
      const hz = spectralCentroid(freq, ctx.sampleRate, an.fftSize);
      const k = Math.min(1, Math.max(0, dt) / 0.25); // 250 ms smoothing: geometry follows gently
      r.level += (levelNorm(rmsDb) - r.level) * k;
      r.centroidHz += (hz - r.centroidHz) * k;
      r.centroid = centroidNorm(r.centroidHz);
      return r;
    },
    dispose() {
      src.disconnect();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
