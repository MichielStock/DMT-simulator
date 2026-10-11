// Neural field (BUILD.md §11.4, M5): the CPU reference of the dynamics run by the GPU layer.
// Spectrum gate: below the critical gain no spectral peak above noise; above it the dominant
// wavenumber matches the linear-stability prediction; hexagon mode is 6-fold; seeds reproduce.
import { describe, expect, it } from 'vitest';
import {
  FieldSim, FIELD_N, GAIN_MAX, LAMBDA_MAX, LAMBDA_MIN, activity, angularPeaks, angularSpectrum, classWeights,
  criticalGain, criticalIntensity, gainRatio, makeKernel, powerSpectrum2D, predictWavenumber, radialSpectrum,
  regimeAt, wavelengthCells,
} from '../src/layers/neuralFieldCpu';
import { RENDER_LIMITS, annulusPlan } from '../src/layers/neuralField';

const LAMBDA = 12;
const T = 180_000;

function run(mode: string, v: number, steps = 400, seed = 20261010) {
  const spec = { mode, wavelength: 0.95, spiral_bias: 0 };
  const sim = new FieldSim({ seed, lambda: LAMBDA, spec, v, spirals: true });
  sim.step(steps);
  const p2 = powerSpectrum2D(sim.u, sim.n);
  const rs = radialSpectrum(p2, sim.n);
  const pred = predictWavenumber(LAMBDA, regimeAt(spec, seed, 0));
  const ang = angularPeaks(angularSpectrum(p2, sim.n, rs.peakBin));
  return { sim, rs, pred, ang };
}

const sepMod180 = (a: number, b: number) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };

describe('linear stability', () => {
  it('predicts a wavelength of 8–16 cells near the design wavelength', () => {
    for (const lam of [LAMBDA_MIN, 12, LAMBDA_MAX]) {
      const p = predictWavenumber(lam);
      expect(p.lambda).toBeGreaterThan(lam * 0.85);
      expect(p.lambda).toBeLessThan(lam * 1.15);
    }
    expect(wavelengthCells(0.6)).toBe(LAMBDA_MIN);
    expect(wavelengthCells(1.3)).toBe(LAMBDA_MAX);
  });

  it('balanced kernel: zero mean, so u0 = 0 is the uniform state for every gain', () => {
    const k = makeKernel(12);
    const sum = (a: Float32Array) => a.reduce((s, x) => s + x, 0);
    expect(Math.abs(sum(k.ge) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(sum(k.gi) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(sum(k.gde) - sum(k.gdi))).toBeLessThan(1e-6);
  });

  it('critical gain: anisotropy lowers it; the uniform state loses stability at v ≈ 2 (neutral absorption)', () => {
    const iso = criticalGain(12);
    const ring = criticalGain(12, regimeAt({ mode: 'stripes_x' }, 1, 0));
    expect(ring).toBeLessThan(iso * 0.8);
    expect(criticalIntensity(1)).toBeCloseTo(2, 6);
    expect(gainRatio(2, 1)).toBeCloseTo(1, 6);
    expect(gainRatio(1, 1)).toBeLessThan(1);
    expect(gainRatio(10, 2)).toBeLessThanOrEqual(GAIN_MAX);
  });
});

describe('spectrum (CPU reference, 256², 400 steps)', () => {
  it('below the critical gain: no spectral peak above noise (peak/median < 3)', () => {
    const { rs, sim } = run('stripes_x', 1);
    expect(sim.ratio).toBeLessThan(1);
    expect(rs.peakToMedian).toBeLessThan(3);
  }, T);

  for (const [mode, angle] of [['stripes_x', 0], ['stripes_y', 90], ['spirals', 45]] as const) {
    it(`above the critical gain (${mode}): dominant wavenumber = prediction ±15%, peak/median ≥ 8, orientation`, () => {
      const { rs, pred, ang } = run(mode, 6);
      expect(Math.abs(rs.peakK - pred.k) / pred.k).toBeLessThan(0.15);
      expect(rs.peakToMedian).toBeGreaterThanOrEqual(8);
      const want = mode === 'spirals' && regimeAt({ mode }, 20261010, 0).diag === -1 ? 135 : angle;
      expect(sepMod180(ang[0].deg, want)).toBeLessThan(12);
    }, T);
  }

  it('hexagon mode: 6-fold angular power (three directions 60° apart)', () => {
    const { rs, pred, ang } = run('hexagons', 6);
    expect(Math.abs(rs.peakK - pred.k) / pred.k).toBeLessThan(0.15);
    expect(rs.peakToMedian).toBeGreaterThanOrEqual(8);
    expect(ang.length).toBeGreaterThanOrEqual(3);
    const top = ang.slice(0, 3);
    for (const p of top) expect(p.power / top[0].power).toBeGreaterThan(0.4);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.abs(sepMod180(top[i].deg, top[j].deg) - 60)).toBeLessThan(15);
    // stripes, by contrast, have one dominant direction
    const s = run('stripes_x', 6, 400);
    expect(s.ang.length < 2 || s.ang[1].power / s.ang[0].power < 0.2).toBe(true);
  }, T);
});

describe('determinism', () => {
  it('the same seed reproduces exactly; another seed differs', () => {
    const a = new FieldSim({ seed: 5, n: 64, lambda: 10, spec: { mode: 'mixed' }, v: 5, spirals: true });
    const b = new FieldSim({ seed: 5, n: 64, lambda: 10, spec: { mode: 'mixed' }, v: 5, spirals: true });
    const c = new FieldSim({ seed: 6, n: 64, lambda: 10, spec: { mode: 'mixed' }, v: 5, spirals: true });
    a.step(120); b.step(120); c.step(120);
    expect(Array.from(a.u)).toEqual(Array.from(b.u));
    expect(Array.from(a.u)).not.toEqual(Array.from(c.u));
    expect(FIELD_N).toBe(256);
  });

  it('mixed mode drifts slowly through the classes (weights sum to 1)', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 120; t += 2) {
      const w = classWeights({ mode: 'mixed' }, 3, t);
      expect(Object.values(w).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
      seen.add(Object.entries(w).sort((p, q) => q[1] - p[1])[0][0]);
    }
    expect(seen.size).toBe(4);
  });
});

describe('safety at source', () => {
  it('rendered pattern contrast is capped below 0.5 and drift is far below 2 Hz', () => {
    expect(RENDER_LIMITS.michelson).toBeLessThanOrEqual(0.45);
    expect(RENDER_LIMITS.driftHzMax).toBeLessThanOrEqual(0.5);
    for (const u of [-50, -1, 0, 1, 50]) { expect(activity(u)).toBeGreaterThanOrEqual(0); expect(activity(u)).toBeLessThanOrEqual(1); }
  });
});

describe('safety at source: dark-base luminance window (polish, D-P-form_constants-1)', () => {
  it('troughs sit on a dark base and the broad periodic structure keeps Lmax <= 2.35 Lmin at every intensity', () => {
    expect(RENDER_LIMITS.lMin).toBeLessThanOrEqual(0.05);
    expect(RENDER_LIMITS.lMin).toBeGreaterThanOrEqual(0.02);
    expect(RENDER_LIMITS.ratioLow).toBeLessThan(RENDER_LIMITS.ratioMax);
    expect(RENDER_LIMITS.ratioMax).toBeLessThanOrEqual(2.35);
    expect(RENDER_LIMITS.lMax / RENDER_LIMITS.lMin).toBeCloseTo(RENDER_LIMITS.ratioMax, 6);
    // Michelson of the broad pattern stays below the limiter guard's 0.45 tile test (and §4.1's 0.5)
    expect(RENDER_LIMITS.michelson).toBeLessThanOrEqual(0.41);
  });
});

describe('safety at source: core + lit annulus plan (polish round 2, D-P-form_constants-6)', () => {
  it('outside the core, any two points within a window keep brightest body / darkest trough <= winC (Michelson < 0.45)', () => {
    let rnd = 12345;
    const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
    let worst = 0;
    for (const b0 of RENDER_LIMITS.b0) {
      for (let i = 0; i < 4000; i++) {
        const light = rand() * 2 * Math.PI;
        // q anywhere on a 16:9 screen (and beyond, for mouse look) outside the core
        const x = (rand() * 2 - 1) * 1.1, y = (rand() * 2 - 1) * 0.75;
        if (Math.hypot(x, y) < 0.235) continue;
        const an = rand() * 2 * Math.PI, d = rand() * RENDER_LIMITS.win;
        const x2 = x + d * Math.cos(an), y2 = y + d * Math.sin(an);
        if (Math.hypot(x2, y2) < 0.235) continue;
        const a = annulusPlan(x, y, b0, light), b = annulusPlan(x2, y2, b0, light);
        worst = Math.max(worst, b.body / a.trough, a.body / b.trough);
        expect(a.trough).toBeGreaterThanOrEqual(RENDER_LIMITS.lMin - 1e-9);
        expect(a.body / a.trough).toBeLessThanOrEqual(RENDER_LIMITS.ratioMax + 1e-9);
      }
    }
    // exact bound (the shader uses an analytic upper bound of the envelope over the window)
    expect(worst).toBeLessThanOrEqual(RENDER_LIMITS.winC + 1e-9);
    expect((RENDER_LIMITS.winC - 1) / (RENDER_LIMITS.winC + 1)).toBeLessThan(0.45);
  });

  it('the high-contrast core is bounded and intensity drives the rendering (crest, bloom, bodies rise with v)', () => {
    expect(RENDER_LIMITS.coreAreaMax).toBeLessThan(0.09);
    expect(RENDER_LIMITS.coreROut[1]).toBeLessThanOrEqual(0.21);
    expect(RENDER_LIMITS.coreTrough).toBeLessThanOrEqual(0.02);
    for (const k of ['b0', 'coreBody', 'crestL', 'bloomA', 'bloomB'] as const) {
      const r = RENDER_LIMITS[k] as readonly [number, number];
      expect(r[1]).toBeGreaterThan(r[0]);
    }
    expect(RENDER_LIMITS.crestL[1]).toBeLessThanOrEqual(0.9);
    expect(RENDER_LIMITS.coreBody[1]).toBeLessThanOrEqual(0.45);
  });
});

describe('safety at source + intensity (polish round 3, D-P-form_constants-11..14)', () => {
  it('the annulus keeps its whole periodic structure inside the window; only the bounded core exceeds it', () => {
    // nebula dust lifts the troughs by at most dustMax (the shader also clamps it to the local Ro)
    expect(RENDER_LIMITS.dustMax).toBeGreaterThanOrEqual(1);
    expect(RENDER_LIMITS.dustMax).toBeLessThanOrEqual(RENDER_LIMITS.ratioMax);
    // the fully-lit core stays inside the bounded core
    expect(RENDER_LIMITS.coreRIn[1]).toBeLessThan(RENDER_LIMITS.coreROut[1]);
    expect(RENDER_LIMITS.coreAreaMax).toBeLessThan(0.09);
    // annulus centre-lines stay a dark-base pattern: trough = centre-line / ratio <= 0.055 at v 9
    expect(RENDER_LIMITS.b0[1] / RENDER_LIMITS.ratioMax).toBeLessThanOrEqual(0.055);
  });

  it('intensity drives the rendering over the whole field (lines, filaments, sparks, mid-ground)', () => {
    for (const k of ['crestW', 'glintL', 'filig', 'mid', 'coreRIn', 'b0'] as const) {
      const r = RENDER_LIMITS[k] as readonly [number, number];
      expect(r[1]).toBeGreaterThan(r[0]);
    }
    // a lower noise threshold = more sparks at higher intensity
    expect(RENDER_LIMITS.glintTh[1]).toBeLessThan(RENDER_LIMITS.glintTh[0]);
    // sparks are accents, never a full-white field
    expect(RENDER_LIMITS.glintL[1]).toBeLessThanOrEqual(0.9);
  });
});
