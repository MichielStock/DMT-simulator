import { describe, expect, it } from 'vitest';
import { ALPHABET_MAX, ALPHABET_MIN, makeAlphabet } from '../src/layers/glyphs';
import {
  FRAME_EDGE_HZ_CHALLENGE, FRAME_RATIO_MAX, VEIL_S, WORLD_XFADE_S, aperture, echoCount, frameFold, frameLuminance,
  frameRotationRev, messageEnvelope, michelson, morphFromPhase, ringCount, ringRotationRev, veilProgress,
  worldPixelTransitionS, worldSchedule, MEMBRANE_CELLS, MEMBRANE_FILL, APERTURE_MAX,
} from '../src/layers/breakthroughMath';

describe('glyph alphabet', () => {
  it('is deterministic for a seed', () => {
    expect(JSON.stringify(makeAlphabet(1234))).toBe(JSON.stringify(makeAlphabet(1234)));
  });
  it('differs between seeds', () => {
    expect(JSON.stringify(makeAlphabet(1)) === JSON.stringify(makeAlphabet(2))).toBe(false);
  });
  it('has 20-30 distinct glyphs of 2+ strokes inside the cell', () => {
    for (let s = 0; s < 200; s++) {
      const a = makeAlphabet(s * 7919 + 3);
      expect(a.glyphs.length).toBeGreaterThanOrEqual(ALPHABET_MIN);
      expect(a.glyphs.length).toBeLessThanOrEqual(ALPHABET_MAX);
      const keys = new Set(a.glyphs.map((g) => JSON.stringify(g)));
      expect(keys.size).toBe(a.glyphs.length);
      for (const g of a.glyphs) {
        expect(g.strokes.length).toBeGreaterThanOrEqual(2);
        for (const st of g.strokes) {
          const pts = st.kind === 'line' ? [st.x0, st.y0, st.x1, st.y1] : st.kind === 'arc' ? [st.cx, st.cy] : [st.x, st.y];
          for (const p of pts) { expect(p).toBeGreaterThan(-0.1); expect(p).toBeLessThan(1.1); }
        }
      }
    }
  });
});

describe('frame luminance arithmetic (BUILD.md 4.1)', () => {
  it('keeps the broad periodic structure (fills, seams, studs) within 1:3 and under the guard tile test', () => {
    for (let v = 0; v <= 10; v += 0.25) {
      for (const ch of [0, 0.5, 1]) {
        const f = frameLuminance(v, ch);
        const lo = f.lMin;
        const hi = Math.max(f.lMax, f.seam, f.stud);
        expect(hi / lo).toBeLessThanOrEqual(FRAME_RATIO_MAX + 1e-9);
        expect(hi).toBeLessThanOrEqual(3 * lo);
        expect(michelson(lo, hi)).toBeLessThan(0.45);
        expect(f.lMin).toBeGreaterThanOrEqual(0.02);   // dark base, not black
        expect(f.edge).toBeGreaterThanOrEqual(0.6);
        expect(f.edge).toBeLessThanOrEqual(0.9);
      }
    }
  });
  it('rotations never let edges pass a pixel faster than 2 Hz', () => {
    for (let s = 0; s < 50; s++) {
      const N = frameFold(s);
      expect(N).toBeGreaterThanOrEqual(7);
      expect(N).toBeLessThanOrEqual(12);
      for (const cells of [N, 2 * N, 4 * N]) {
        for (const ch of [0, 1]) {
          for (const v of [5, 9, 10]) {
            const rev = frameRotationRev(cells, v, ch);
            expect(cells * rev).toBeLessThanOrEqual(FRAME_EDGE_HZ_CHALLENGE + 1e-9);
            expect(cells * rev).toBeLessThan(2);
          }
        }
        // the band rotation gain in breakthrough.ts is <= 1
      }
    }
  });
  it('aperture opens with v and the veil, closes on descent and tightens in a difficult passage', () => {
    expect(aperture(9, 1, 0)).toBeGreaterThan(aperture(7, 1, 0));
    expect(aperture(7, 1, 0)).toBeGreaterThan(aperture(5, 1, 0));
    expect(aperture(9, 0, 0)).toBeLessThan(0.2);
    expect(aperture(9, 1, 1)).toBeLessThan(aperture(9, 1, 0));
  });
});

describe('veil', () => {
  it('lifts over >= 2 s, monotonically', () => {
    expect(VEIL_S).toBeGreaterThanOrEqual(2);
    expect(veilProgress(0)).toBe(0);
    expect(veilProgress(1.0)).toBeLessThan(0.5);
    expect(veilProgress(VEIL_S)).toBe(1);
    let prev = 0;
    for (let t = 0; t <= 4; t += 0.05) { const p = veilProgress(t); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
  });
});

describe('world crossfade schedule', () => {
  it('holds each world 25-45 s, crossfades over >= 2 s and never cuts', () => {
    expect(WORLD_XFADE_S).toBeGreaterThanOrEqual(2);
    expect(worldPixelTransitionS()).toBeGreaterThanOrEqual(0.3);
    for (const count of [2, 3]) {
      for (const seed of [11, 23, 99]) {
        const dt = 1 / 60;
        let prevShown: number[] | null = null;
        let prevMix = 0;
        let changes = 0;
        let lastChange = -Infinity;
        let prevA = -1;
        for (let t = 0; t < 400; t += dt) {
          const m = worldSchedule(t, count, seed);
          expect(m.a).not.toBe(m.b);
          expect(m.a).toBeGreaterThanOrEqual(0);
          expect(m.b).toBeLessThan(count);
          // the displayed blend as weights per world
          const shown = new Array(count).fill(0);
          shown[m.a] += 1 - m.mix;
          shown[m.b] += m.mix;
          if (prevShown) {
            for (let k = 0; k < count; k++) {
              // smoothstep over 4 s: max slope 1.5 / 4 per second
              expect(Math.abs(shown[k] - prevShown[k])).toBeLessThanOrEqual((1.5 / WORLD_XFADE_S) * dt + 1e-6);
            }
          }
          if (m.a !== prevA) {
            if (prevA >= 0) {
              expect(t - lastChange).toBeGreaterThanOrEqual(25 - 1e-6);
              expect(t - lastChange).toBeLessThanOrEqual(45 + 1e-6);
              expect(prevMix).toBeGreaterThan(0.999);
              changes++;
            }
            lastChange = t;
            prevA = m.a;
          }
          prevShown = shown;
          prevMix = m.mix;
        }
        expect(changes).toBeGreaterThanOrEqual(8);
      }
    }
  });
  it('one world: no crossfade', () => {
    expect(worldSchedule(100, 1, 5)).toEqual({ a: 0, b: 0, mix: 0, segment: 0 });
  });
});

describe('entities and message', () => {
  it('echo count is 3-7 and seeded', () => {
    const seen = new Set<number>();
    for (let s = 0; s < 500; s++) {
      const n = echoCount(s);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      expect(echoCount(s)).toBe(n);
      seen.add(n);
    }
    expect(seen.size).toBe(5);
  });
  it('morph crossfades are continuous', () => {
    let prev = morphFromPhase(0);
    for (let ph = 0; ph < 6; ph += 0.001) {
      const m = morphFromPhase(ph);
      const x0 = prev.variant + prev.morph;
      const x1 = m.variant + m.morph;
      const d = Math.min(Math.abs(x1 - x0), Math.abs(x1 - x0 + 3), Math.abs(x1 - x0 - 3));
      expect(d).toBeLessThan(0.01);
      prev = m;
    }
  });
  it('2-4 rings rotating <= 0.5 Hz with glyph passing <= 1 Hz', () => {
    for (let s = 0; s < 200; s++) {
      const n = ringCount(s);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    }
    for (let j = 0; j < 4; j++) {
      for (const cells of [10, 30, 80]) {
        const r = Math.abs(ringRotationRev(j, cells));
        expect(r).toBeLessThanOrEqual(0.5);
        expect(r * cells).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
  it('message envelope fades in and out (no step)', () => {
    expect(messageEnvelope(false, 5)).toBe(0);
    expect(messageEnvelope(true, 0)).toBe(0);
    expect(messageEnvelope(true, 6)).toBe(1);
    expect(messageEnvelope(true, 12)).toBe(0);
  });
});

describe('membrane and portal (round 2)', () => {
  it('opens the portal to >= 80 % of a 16:9 screen at v >= 7.5 (polygon of 7-12 sides)', () => {
    for (const n of [7, 12]) {
      for (const v of [7.5, 9]) {
        const R = aperture(v, 1, 0);
        expect(R).toBeCloseTo(APERTURE_MAX, 5);
        // Monte-Carlo-free area: grid over the screen in half-height units, inside = polygon radius <= R
        let inside = 0, total = 0;
        for (let y = -1; y <= 1; y += 0.02) {
          for (let x = -16 / 9; x <= 16 / 9; x += 0.02) {
            const th = Math.atan2(y, x); const s = (2 * Math.PI) / n;
            const a = ((th % s) + s) % s - 0.5 * s;
            const rp = Math.hypot(x, y) * Math.cos(a) / Math.cos(0.5 * s);
            total++; if (rp <= R) inside++;
          }
        }
        expect(inside / total).toBeGreaterThanOrEqual(0.8);
      }
    }
    expect(aperture(9, 1, 1)).toBeLessThan(aperture(9, 1, 0) * 0.75);   // narrower in a difficult passage
  });
  it('keeps the membrane cells near-black and its cell count constant (no re-layout pop)', () => {
    expect(MEMBRANE_FILL[0]).toBeGreaterThan(0.004);
    expect(MEMBRANE_FILL[1]).toBeLessThanOrEqual(0.02);
    expect(Number.isInteger(MEMBRANE_CELLS)).toBe(true);
  });
});
