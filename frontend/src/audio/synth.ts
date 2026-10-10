// Pure mappings for the synthesised sound of BUILD.md section 12. Nothing in this file touches Web
// Audio, so it is unit-tested directly (frontend/tests/audio.test.ts). The graph lives in index.ts.

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const dbToGain = (db: number): number => (db <= SILENT_DB ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g));
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Levels at or below this are treated as silence. */
export const SILENT_DB = -90;

// ---------------------------------------------------------------- safety constants (§4.2)
/** Output ceiling of the master chain in dBFS (the WaveShaper hard ceiling sits just under it). */
export const CEILING_DBFS = -3;
/** Minimum attack of any gain onset in the trip chain, seconds. */
export const MIN_ATTACK_S = 0.2;
/** Maximum rate at which any continuous level may rise (dB per second): 20 dB/s = 4 dB per 200 ms. */
export const MAX_RISE_DB_PER_S = 20;
export const MAX_FALL_DB_PER_S = 60;
/** Master fade-in from −60 dB: 4 s → 15 dB/s. */
export const START_FADE_S = 4;

// ---------------------------------------------------------------- carrier, whine, buzz, crackle, rumble
/** Carrier pitch: 220 · 2^(3 · auditory / 10) Hz (§12). */
export function carrierHz(auditory: number): number {
  return 220 * Math.pow(2, (3 * clamp(auditory, 0, 10)) / 10);
}
/** The faint high whine partial: always ≥ 2 kHz, gliding 2.4 → 6.8 kHz with intensity. */
export function whineHz(auditory: number): number {
  return 2400 * Math.pow(2, 1.5 * clamp01(auditory / 10));
}
/** Whine level relative to the carrier. */
export const WHINE_REL_DB = -24;

export const AM_MIN_HZ = 4;
/** Top of the buzz mapping; the lock may round down to an integer multiple of the pulse, never up. */
export const AM_TOP_HZ = 11.5;
/** Absolute cap on the AM oscillator, including phase-lock corrections. */
export const AM_MAX_HZ = 12;

/** Buzz (amplitude-modulation) target rate, 4 → 11.5 Hz, rising with intensity. */
export function amRateHz(intensity: number): number {
  return AM_MIN_HZ + (AM_TOP_HZ - AM_MIN_HZ) * clamp01(intensity / 10);
}

/**
 * AM depth d: the modulated gain swings between 1 − 2d and 1 (sinusoidally), so d ≤ 0.2 keeps the
 * trough at ≥ 0.6 (≤ 4.4 dB swing on the modulated voices, well under the 12 dB/200 ms onset test).
 * Depth swells with the shared pulse, so geometry and sound breathe together.
 */
export const AM_DEPTH_MAX = 0.2;
export function amDepth(intensity: number, pulseNorm: number): number {
  const x = clamp01((intensity - 1) / 9);
  return AM_DEPTH_MAX * x * (0.55 + 0.45 * clamp01(pulseNorm));
}

/**
 * Lock the buzz to the pulse: the AM runs at an integer multiple n of the pulse frequency, the
 * nearest one to the target rate that stays ≥ 0.3 Hz under the 12 Hz cap. Without a usable pulse
 * it falls back to the target rate.
 */
export function lockedAm(targetHz: number, pulseHz: number): { n: number; hz: number } {
  if (!(pulseHz > 0.02)) return { n: 0, hz: clamp(targetHz, 1, AM_MAX_HZ) };
  let n = Math.max(1, Math.round(targetHz / pulseHz));
  while (n > 1 && n * pulseHz > AM_MAX_HZ - 0.3) n--; // leave room for phase trims under the cap
  return { n, hz: Math.min(AM_MAX_HZ, n * pulseHz) };
}

/** Crackle grains per second, 0 below auditory 0.5, rising to 5/s at 10 (sparse soft popcorn). */
export function crackleRate(auditory: number): number {
  if (auditory < 0.5) return 0;
  return 0.25 + 4.75 * Math.pow(clamp01(auditory / 10), 1.4);
}
/** Body rumble 40–60 Hz following the body channel. */
export function rumbleHz(body: number): number {
  return 40 + 2 * clamp(body, 0, 10);
}

/** Level maps (dB before the master chain). Everything is gated to silence near intensity 0. */
export function carrierDb(auditory: number): number {
  const g = smoothstep(0.1, 1.2, auditory);
  if (g <= 0) return SILENT_DB;
  return -42 + 24 * clamp01(auditory / 10) + 20 * Math.log10(g);
}
export function rumbleDb(body: number): number {
  const g = smoothstep(0.1, 1.5, body);
  if (g <= 0) return SILENT_DB;
  return -48 + 18 * clamp01(body / 10) + 20 * Math.log10(g);
}
export function crackleDb(auditory: number): number {
  const g = smoothstep(0.3, 1.5, auditory);
  if (g <= 0) return SILENT_DB;
  return -40 + 12 * clamp01(auditory / 10) + 20 * Math.log10(g);
}
/**
 * Detune of the second carrier oscillator (cents): normally a slow 0.5 Hz beat at any pitch (well
 * under the 2 Hz modulation limit), in a difficult passage up to +42 cents of roughness
 * (≈ 25–45 Hz beating), released in the relief beat.
 */
export const CARRIER_BEAT_HZ = 0.5;
export function carrierDetuneCents(challenge: number, relief: number, fc = 440): number {
  const base = 1200 * Math.log2(1 + CARRIER_BEAT_HZ / Math.max(1, fc));
  return base + 42 * clamp01(challenge) * (1 - clamp01(relief));
}
/** Level of the detuned second carrier relative to the first: shallow beats, deeper when rough. */
export function carrierBLevel(challenge: number, relief: number): number {
  return 0.3 + 0.3 * clamp01(challenge) * (1 - clamp01(relief));
}
/** Ring-modulation mix 0–0.8 from the challenge level, released in the relief beat. */
export function ringModAmount(challenge: number, relief: number): number {
  return 0.8 * clamp01(challenge) * (1 - clamp01(relief));
}
/** Eyes closed muffles the room-ish elements: low-pass cutoff 14 kHz → 1.8 kHz (geometric). */
export function eyesCutoffHz(eyesClosed: number): number {
  return 14000 * Math.pow(1800 / 14000, clamp01(eyesClosed));
}

// ---------------------------------------------------------------- breakthrough chords
export const CHORD_PERIOD_S = 10;
export const CHORD_XFADE_S = 3; // ≥ 2 s (task spec)
/** Consonant progression, semitones from the pad root: Iadd9 → vi7 → IV → Vsus4 (open voicings). */
export const CHORDS_CONSONANT: number[][] = [
  [0, 7, 14, 16],
  [-3, 4, 7, 12],
  [-7, 0, 5, 9],
  [-5, 2, 7, 12],
];
/** Difficult passage: clusters with minor seconds and tritones. */
export const CHORDS_DISSONANT: number[][] = [
  [0, 1, 6, 11],
  [-1, 0, 6, 13],
];
/** Relief beat: an open major chord. */
export const CHORD_RELIEF: number[] = [0, 7, 12, 16];

export type ChordKind = 'consonant' | 'dissonant' | 'relief';
/** Which chord sounds at a wall time; a new `key` means a crossfade to a new chord. */
export function chordAt(wallTime: number, challenge: number, relief: number): { key: string; kind: ChordKind; chord: number[] } {
  const step = Math.floor(Math.max(0, wallTime) / CHORD_PERIOD_S);
  if (relief > 0.05) return { key: 'relief', kind: 'relief', chord: CHORD_RELIEF };
  if (challenge > 0.3) {
    const i = step % CHORDS_DISSONANT.length;
    return { key: `d${i}:${step}`, kind: 'dissonant', chord: CHORDS_DISSONANT[i] };
  }
  const i = step % CHORDS_CONSONANT.length;
  return { key: `c${i}:${step}`, kind: 'consonant', chord: CHORDS_CONSONANT[i] };
}
/** Pad root: the carrier folded down by octaves into [110, 220) Hz, so pad and carrier agree. */
export function padRootHz(carrier: number): number {
  let f = carrier;
  while (f >= 220) f /= 2;
  while (f < 110) f *= 2;
  return f;
}
export function chordFreqs(root: number, chord: number[]): number[] {
  return chord.map((s) => root * Math.pow(2, s / 12));
}
/** Is every interval in the chord consonant (no minor/major seconds, no tritone mod 12)? */
export function isConsonant(chord: number[]): boolean {
  for (let i = 0; i < chord.length; i++) {
    for (let j = i + 1; j < chord.length; j++) {
      const iv = (((chord[j] - chord[i]) % 12) + 12) % 12;
      if (iv === 1 || iv === 6 || iv === 11) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- entity voices
/** Formant targets (Hz) of five vowels (Peterson & Barney averages); voices are vowels, never words. */
export const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
};
export const VOWEL_KEYS = Object.keys(VOWELS);

// ---------------------------------------------------------------- envelopes and smoothing
/**
 * Raised-cosine grain envelope sampled into `n` points: rise over `attack` s (≥ MIN_ATTACK_S),
 * fall over `release` s. Used with setValueCurveAtTime for crackle grains and the exit tone.
 */
export function grainCurve(attack: number, release: number, peak: number, n = 96): Float32Array {
  const a = Math.max(MIN_ATTACK_S, attack);
  const total = a + release;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * total;
    out[i] = t < a ? peak * (0.5 - 0.5 * Math.cos((Math.PI * t) / a)) : peak * (0.5 + 0.5 * Math.cos((Math.PI * (t - a)) / release));
  }
  return out;
}

/** A level in dB whose rises are slew-limited (dB/s), so no continuous voice can swell abruptly. */
export class DbSlew {
  db: number;
  constructor(initial = SILENT_DB, readonly rise = MAX_RISE_DB_PER_S, readonly fall = MAX_FALL_DB_PER_S) { this.db = initial; }
  step(targetDb: number, dt: number): number {
    const t = Math.max(SILENT_DB, targetDb);
    if (t > this.db) this.db = Math.min(t, this.db + this.rise * dt);
    else this.db = Math.max(t, this.db - this.fall * dt);
    return this.db;
  }
  /** Jump to a level (only while the master fade owns the onset, e.g. right after start()). */
  snap(targetDb: number): void { this.db = Math.max(SILENT_DB, targetDb); }
  get gain(): number { return dbToGain(this.db); }
}

/**
 * Recovers the phase (0–1) and frequency of the shared pulse from its value alone:
 * pulse = g · (1 − cos 2πφ) / 2 with an unknown, slowly varying gain g. φ comes from acos of the
 * normalised value plus the direction of travel; the frequency from the time between peaks.
 */
export class PulseTracker {
  phase = 0;
  hz = 0;
  norm = 0;
  private gEst = 0;
  private prev = 0;
  private rising = true;
  private t = 0;
  private lastPeakT = -1;
  update(pulse: number, dt: number, explicit?: { phase?: number; hz?: number }): void {
    this.t += dt;
    const p = clamp01(pulse);
    this.gEst = Math.max(p, this.gEst - 0.03 * dt);
    this.norm = this.gEst > 1e-4 ? clamp01(p / this.gEst) : 0;
    if (explicit && typeof explicit.phase === 'number') {
      this.phase = ((explicit.phase % 1) + 1) % 1;
      if (typeof explicit.hz === 'number') this.hz = explicit.hz;
      this.prev = p;
      return;
    }
    const dp = p - this.prev;
    if (Math.abs(dp) > 1e-7) {
      const nowRising = dp > 0;
      if (this.rising && !nowRising && this.norm > 0.6) {
        if (this.lastPeakT >= 0) {
          const period = this.t - this.lastPeakT;
          if (period > 0.4 && period < 20) this.hz = this.hz > 0 ? 0.5 * this.hz + 0.5 / period : 1 / period;
        }
        this.lastPeakT = this.t;
      }
      this.rising = nowRising;
    }
    this.prev = p;
    const half = Math.acos(clamp(1 - 2 * this.norm, -1, 1)) / (2 * Math.PI);
    const measured = this.rising ? half : 1 - half;
    if (this.gEst < 0.01) this.hz = 0;
    if (this.hz > 0) {
      // free-running phase at the measured frequency, pulled toward the measurement only where acos
      // is well conditioned (away from the extremes), so the estimate is smooth
      let ph = this.phase + this.hz * dt;
      if (this.norm > 0.1 && this.norm < 0.9) {
        let e = measured - ph;
        e -= Math.round(e);
        ph += e * Math.min(1, dt / 0.4);
      }
      this.phase = ph - Math.floor(ph);
    } else {
      this.phase = measured;
    }
  }
}

/**
 * Software phase lock of the buzz oscillator to the pulse. The oscillator's phase is modelled
 * exactly (frequency is changed only by setValueAtTime steps at the times passed in here), so the
 * phase error n·φ_pulse − θ_osc can be corrected by small frequency trims.
 */
export class AmLock {
  theta = 0;   // oscillator phase in cycles at tLast
  f: number;   // current oscillator frequency
  tLast: number;
  n = 0;
  private lastPulsePhase = 0;
  constructor(t0: number, f0: number) { this.tLast = t0; this.f = f0; }
  static readonly GAIN = 1.2; // Hz per cycle of phase error
  step(tSched: number, pulsePhase: number, pulseHz: number, targetHz: number): number {
    const thetaAt = this.theta + this.f * Math.max(0, tSched - this.tLast);
    const lk = lockedAm(targetHz, pulseHz);
    let fNew: number;
    if (lk.n === 0) {
      this.n = 0;
      fNew = lk.hz;
    } else {
      // change the multiple only when the pulse wraps (n·φ is continuous there)
      if (this.n === 0 || (pulsePhase < this.lastPulsePhase - 0.5)) this.n = lk.n;
      if (Math.abs(this.n - lk.n) > 3) this.n = lk.n; // big jumps (forced intensity) re-lock at once
      let err = this.n * pulsePhase - thetaAt;
      err -= Math.round(err);
      fNew = this.n * pulseHz + AmLock.GAIN * err;
    }
    this.lastPulsePhase = pulsePhase;
    fNew = clamp(fNew, 1, AM_MAX_HZ);
    this.theta = thetaAt - Math.floor(thetaAt);
    this.tLast = tSched;
    this.f = fNew;
    return fNew;
  }
}

/**
 * A swell for sounds that may start from silence (exit tone): the attack rises linearly in dB from
 * `fromDb` below the peak (so the rise rate is |fromDb|/attack dB/s, ≤ 12 dB per 200 ms with the
 * defaults), then falls on a raised cosine. Sampled for setValueCurveAtTime.
 */
export function swellCurve(attack: number, release: number, peak: number, fromDb = -50, n = 128): Float32Array {
  const a = Math.max(MIN_ATTACK_S, attack);
  const total = a + release;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * total;
    out[i] = t < a ? peak * Math.pow(10, (fromDb * (1 - t / a)) / 20) : peak * (0.5 + 0.5 * Math.cos((Math.PI * (t - a)) / release));
  }
  out[0] = 0;
  return out;
}
