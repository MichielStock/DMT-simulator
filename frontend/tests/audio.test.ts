// Pure parts of the audio (BUILD.md §12, §4.2): mappings, chord tables, envelopes, the pulse
// tracker and the AM phase lock. The rendered graph is tested in tests/e2e/audio.spec.ts.
import { describe, expect, it } from 'vitest';
import {
  AM_MAX_HZ, AmLock, CHORDS_CONSONANT, CHORDS_DISSONANT, CHORD_RELIEF, CHORD_XFADE_S, DbSlew, MAX_RISE_DB_PER_S,
  MIN_ATTACK_S, PulseTracker, VOWELS, amDepth, amRateHz, carrierDb, carrierDetuneCents, carrierHz, chordAt,
  crackleRate, eyesCutoffHz, amDepthShape, carrierLpfHz, crackleDb, grainCentreHz, ringModAmount, CARRIER_HARMONICS,
  CRACKLE_BAND_HZ, WHINE_REL_DB, PAD_DB, padDb, grainCurve, isConsonant, lockedAm, padRootHz, rumbleDb, rumbleHz, swellCurve, whineHz,
} from '../src/audio/synth';
import { ceilingCurve, CEILING_LINEAR, DEFAULT_VOLUME } from '../src/audio/limiter';
import { centroidNorm, levelNorm, spectralCentroid } from '../src/audio/mic';

describe('carrier and partials', () => {
  it('pitch is 220 · 2^(3a/10)', () => {
    expect(carrierHz(0)).toBeCloseTo(220, 6);
    expect(carrierHz(10)).toBeCloseTo(1760, 6);
    expect(carrierHz(5)).toBeCloseTo(220 * Math.pow(2, 1.5), 6);
    expect(carrierHz(20)).toBeCloseTo(1760, 6); // clamped
  });
  it('the whine partial is always at or above 2 kHz', () => {
    for (let a = 0; a <= 10; a += 0.5) expect(whineHz(a)).toBeGreaterThanOrEqual(2000);
  });
  it('levels rise with intensity and are silent at 0', () => {
    expect(carrierDb(0)).toBeLessThanOrEqual(-90);
    expect(carrierDb(2)).toBeLessThan(carrierDb(8));
    expect(rumbleDb(2)).toBeLessThan(rumbleDb(8));
    expect(rumbleHz(0)).toBe(40);
    expect(rumbleHz(10)).toBe(60);
  });
  it('the normal carrier beat is 0.5 Hz at any pitch; roughness only in a challenge', () => {
    for (const a of [0, 5, 10]) {
      const fc = carrierHz(a);
      const beat = fc * (Math.pow(2, carrierDetuneCents(0, 0, fc) / 1200) - 1);
      expect(beat).toBeCloseTo(0.5, 3);
    }
    expect(carrierDetuneCents(1, 0, 1000)).toBeGreaterThan(40);
    expect(carrierDetuneCents(1, 1, 1000)).toBeLessThan(1);
  });
});

describe('buzz', () => {
  it('AM rate rises 4 → ≤ 12 Hz with intensity', () => {
    expect(amRateHz(0)).toBe(4);
    expect(amRateHz(10)).toBeLessThanOrEqual(12);
    expect(amRateHz(10)).toBeGreaterThan(11);
    for (let i = 0; i < 10; i++) expect(amRateHz(i + 1)).toBeGreaterThan(amRateHz(i));
  });
  it('the lock picks the nearest integer multiple of the pulse, under the 12 Hz cap', () => {
    const l = lockedAm(11.5, 0.5);
    expect(l.n).toBe(23);
    expect(l.hz).toBeCloseTo(11.5, 9);
    const l2 = lockedAm(7, 0.3);
    expect(l2.n).toBe(23);
    expect(Math.abs(l2.hz - 7)).toBeLessThanOrEqual(0.15);
    const l3 = lockedAm(11.5, 0.52); // slight over-estimate of the pulse must not cross the cap
    expect(l3.hz).toBeLessThanOrEqual(11.7);
    expect(lockedAm(8, 0).n).toBe(0);
  });
  it('AM depth is bounded (≤ 4.4 dB swing) and swells with the pulse', () => {
    expect(amDepth(10, 1)).toBeLessThanOrEqual(0.2);
    expect(20 * Math.log10(1 / (1 - 2 * amDepth(10, 1)))).toBeLessThan(4.5);
    expect(amDepth(10, 1)).toBeGreaterThan(amDepth(10, 0));
    expect(amDepth(0, 1)).toBe(0);
  });
  it('the pulse tracker recovers the phase and frequency of main.ts pulse', () => {
    const tr = new PulseTracker();
    const dt = 1 / 60; let ph = 0; const f = 0.37;
    let err = 0; let n = 0;
    for (let k = 0; k < 60 * 30; k++) {
      ph = (ph + f * dt) % 1;
      tr.update((0.5 - 0.5 * Math.cos(2 * Math.PI * ph)) * 0.8, dt);
      if (k > 60 * 10) { let e = tr.phase - ph; e -= Math.round(e); err = Math.max(err, Math.abs(e)); n++; }
    }
    expect(tr.hz).toBeCloseTo(f, 2);
    expect(err).toBeLessThan(0.05);
  });
  it('the AM oscillator phase locks to n · pulse phase and stays ≤ 12 Hz', () => {
    const lock = new AmLock(0, 4);
    const dt = 1 / 60; let ph = 0; const fp = 0.5;
    let t = 0; let lastErr = 1;
    for (let k = 0; k < 60 * 20; k++) {
      t += dt; ph = (ph + fp * dt) % 1;
      const f = lock.step(t, ph, fp, 11.5);
      expect(f).toBeLessThanOrEqual(AM_MAX_HZ);
      let e = lock.n * ph - lock.theta; e -= Math.round(e); lastErr = Math.abs(e);
    }
    expect(lock.n).toBe(23);
    expect(lastErr).toBeLessThan(0.02);
  });
});

describe('crackle, eyes, envelopes', () => {
  it('crackle rate rises with intensity and is off near 0', () => {
    expect(crackleRate(0)).toBe(0);
    expect(crackleRate(3)).toBeLessThan(crackleRate(9));
  });
  it('eyes closed lowers the room cutoff', () => {
    expect(eyesCutoffHz(0)).toBeCloseTo(14000);
    expect(eyesCutoffHz(1)).toBeCloseTo(1800);
  });
  it('grain envelopes take at least 200 ms to reach their peak', () => {
    const c = grainCurve(0.05, 0.3, 1, 200); // asks for 50 ms, gets 200 ms
    const total = MIN_ATTACK_S + 0.3;
    const peakIdx = c.indexOf(Math.max(...c));
    expect((peakIdx / (c.length - 1)) * total).toBeGreaterThanOrEqual(MIN_ATTACK_S - 0.01);
    expect(c[0]).toBe(0);
  });
  it('swells from silence rise ≤ 12 dB per 200 ms', () => {
    const A = 0.9; const c = swellCurve(A, 1, 1, -50, 400); const dtc = (A + 1) / 399;
    const span = Math.round(0.2 / dtc);
    for (let i = 1; i + span < c.length; i++) {
      if (c[i] <= 0) continue;
      expect(20 * Math.log10(c[i + span] / c[i])).toBeLessThan(12);
    }
  });
  it('DbSlew limits rises to MAX_RISE_DB_PER_S', () => {
    const s = new DbSlew();
    s.step(0, 0.2);
    expect(s.db).toBeCloseTo(-90 + MAX_RISE_DB_PER_S * 0.2, 6);
    s.step(-100, 1);
    expect(s.db).toBe(-90);
  });
});

describe('chords', () => {
  it('consonant tables are consonant, dissonant ones are not, relief is a major chord', () => {
    for (const c of CHORDS_CONSONANT) expect(isConsonant(c)).toBe(true);
    for (const c of CHORDS_DISSONANT) expect(isConsonant(c)).toBe(false);
    expect(isConsonant(CHORD_RELIEF)).toBe(true);
    expect(CHORD_RELIEF).toContain(16); // major third (+ octave)
  });
  it('the progression changes about every 10 s with ≥ 2 s crossfades', () => {
    expect(CHORD_XFADE_S).toBeGreaterThanOrEqual(2);
    expect(chordAt(1, 0, 0).key).toBe(chordAt(9.9, 0, 0).key);
    expect(chordAt(9.9, 0, 0).key).not.toBe(chordAt(10.1, 0, 0).key);
    expect(chordAt(5, 1, 0).kind).toBe('dissonant');
    expect(chordAt(5, 1, 1).kind).toBe('relief');
  });
  it('the pad root is the carrier folded into [110, 220)', () => {
    for (const a of [0, 3, 7, 10]) {
      const r = padRootHz(carrierHz(a));
      expect(r).toBeGreaterThanOrEqual(110);
      expect(r).toBeLessThan(220);
      const ratio = Math.log2(carrierHz(a) / r);
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9);
    }
  });
  it('vowel formants are ordered F1 < F2 < F3', () => {
    for (const f of Object.values(VOWELS)) { expect(f[0]).toBeLessThan(f[1]); expect(f[1]).toBeLessThan(f[2]); }
  });
});

describe('master ceiling and mic', () => {
  it('the hard-ceiling curve never exceeds −3 dBFS and is linear below the knee', () => {
    const c = ceilingCurve();
    expect(Math.max(...Array.from(c, Math.abs))).toBeLessThan(Math.pow(10, -3 / 20));
    expect(CEILING_LINEAR).toBeLessThan(Math.pow(10, -3 / 20));
    const mid = (c.length - 1) / 2; const i = mid + Math.round(0.3 * mid);
    expect(c[i]).toBeCloseTo(0.3, 3);
  });
  it('mic mappings', () => {
    expect(levelNorm(-80)).toBe(0);
    expect(levelNorm(-10)).toBe(1);
    expect(centroidNorm(100)).toBe(0);
    expect(centroidNorm(8000)).toBeCloseTo(1);
    const spec = new Float32Array(1024).fill(-200); spec[100] = 0;
    expect(spectralCentroid(spec, 48000, 2048)).toBeCloseTo(100 * 48000 / 2048, 0);
  });
});

describe('softening (D-A-soft)', () => {
  it('default volume is 0.5 and reachable in 0.1 steps', () => {
    expect(DEFAULT_VOLUME).toBe(0.5);
    expect(Math.round(DEFAULT_VOLUME * 10)).toBeCloseTo(DEFAULT_VOLUME * 10, 9);
  });
  it('the whine partial is ≥ 30 dB under the carrier and the carrier is low-passed at 4–6 kHz', () => {
    expect(WHINE_REL_DB).toBeLessThanOrEqual(-30);
    expect(carrierLpfHz(0)).toBe(4000);
    expect(carrierLpfHz(10)).toBe(6000);
    // soft waveform: each harmonic ≤ 0.2 of the fundamental and falling
    for (let k = 2; k < CARRIER_HARMONICS.length; k++) {
      expect(CARRIER_HARMONICS[k]).toBeLessThanOrEqual(0.2);
      expect(CARRIER_HARMONICS[k]).toBeLessThan(CARRIER_HARMONICS[k - 1]);
    }
  });
  it('buzz depth shape: 0 below 1, 0.3 at 3, 0.8 at 9, rising; ≤ 3.1 dB swing', () => {
    expect(amDepthShape(1)).toBe(0);
    expect(amDepthShape(3)).toBeCloseTo(0.3, 9);
    expect(amDepthShape(9)).toBeCloseTo(0.8, 9);
    for (let v = 0; v < 10; v += 0.5) expect(amDepthShape(v + 0.5)).toBeGreaterThanOrEqual(amDepthShape(v));
    expect(20 * Math.log10(1 / (1 - 2 * amDepth(10, 1)))).toBeLessThan(3.2);
    expect(amDepth(5, 1)).toBeLessThan(0.08);
  });
  it('crackle is quieter, sparse at low intensity, and band-limited to 400–3000 Hz', () => {
    expect(crackleDb(10)).toBeLessThanOrEqual(-36);
    expect(crackleRate(2)).toBeLessThan(0.35);
    expect(CRACKLE_BAND_HZ).toEqual([400, 3000]);
    expect(grainCentreHz(0)).toBeGreaterThanOrEqual(400);
    expect(grainCentreHz(1)).toBeLessThanOrEqual(3000);
  });
  it('the pad is more present; challenge roughness scales with the challenge level', () => {
    expect(PAD_DB).toBeGreaterThan(-14);
    expect(padDb('consonant')).toBe(PAD_DB);
    expect(padDb('relief')).toBe(PAD_DB);
    expect(padDb('dissonant')).toBeLessThanOrEqual(-14);
    expect(ringModAmount(0.3, 0)).toBeLessThan(0.15);
    expect(ringModAmount(0.6, 0)).toBeLessThan(ringModAmount(1, 0));
    expect(ringModAmount(1, 0)).toBeCloseTo(0.6, 9);
    expect(ringModAmount(1, 1)).toBe(0);
    expect(carrierDetuneCents(0.3, 0, 1000)).toBeLessThan(carrierDetuneCents(1, 0, 1000));
  });
});
