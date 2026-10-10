// TypeScript pharmacology vs the protected golden file (BUILD.md §6.4, §7, §16.2).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOSES, HIT_BLOCK_VISUAL, MAX_REPEAT_HITS, P, PharmacologyModel, SUB_DT, intensityOf, simulateCurve, summariseCurve,
} from '../src/pharmacology';

interface GoldenCase {
  name: string; dose: number; sensitivity: number; clearance: number; hits: [number, number][];
  t: number[]; plasma: number[]; body: number[]; visual: number[]; auditory: number[];
  hits_applied?: { requested_t: number; applied_t: number; index: number }[];
}
const golden = JSON.parse(readFileSync(resolve(__dirname, '../../shared/golden/pharmacology.json'), 'utf8')) as {
  meta: { T: number; dt: number; sample_every_steps: number; params: typeof P; doses: typeof DOSES };
  cases: GoldenCase[];
};
const TOL = 1e-3;
const EVERY = golden.meta.sample_every_steps; // 60
const TOTAL = Math.round(golden.meta.T / golden.meta.dt); // 15000

/** Deterministic PRNG for irregular frame times. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FrameGen = () => number; // returns dtMin for the next frame

interface Run { samples: Map<number, number[]>; applied: number[] }

/** Drive the model like the front end would: frames of dtMin, hits through addHit at the requested
 *  times; a blocked hit is retried every sub-step (the reference rule: first moment at or after the
 *  requested time with visual < 3). Near a requested time the loop advances single sub-steps so the
 *  request lands on the exact sub-step, as in the reference loop. */
function run(c: GoldenCase, frame: FrameGen): Run {
  const m = new PharmacologyModel(P, c.sensitivity, c.clearance);
  const samples = new Map<number, number[]>();
  const record = (mm: PharmacologyModel) => {
    const I = mm.intensity;
    samples.set(mm.subSteps / EVERY, [mm.tMin, mm.plasma, I.body, I.visual, I.auditory]);
  };
  expect(m.addHit(c.dose)).toBe(true);
  record(m);
  m.onSubStep = (mm) => { if (mm.subSteps % EVERY === 0) record(mm); };
  const pending = [...c.hits].sort((a, b) => a[0] - b[0]);
  const applied: number[] = [];
  let guard = 0;
  while (m.subSteps < TOTAL) {
    if (++guard > 5_000_000) throw new Error('runaway');
    if (pending.length && m.tMin >= pending[0][0]) {
      if (m.addHit(pending[0][1])) { applied.push(m.tMin); pending.shift(); continue; }
      expect(m.intensity.visual).toBeGreaterThanOrEqual(HIT_BLOCK_VISUAL);
      m.step(SUB_DT);
      continue;
    }
    const dt = frame();
    if (pending.length) {
      const subToReq = (pending[0][0] - m.tMin) / SUB_DT;
      if (subToReq <= dt / SUB_DT + 1) { m.step(SUB_DT); continue; }
    }
    m.step(dt);
  }
  return { samples, applied };
}

function compare(c: GoldenCase, r: Run): number {
  let worst = 0;
  for (let j = 0; j < c.t.length; j++) {
    const s = r.samples.get(j);
    expect(s, `${c.name} sample ${j}`).toBeDefined();
    const g = [c.t[j], c.plasma[j], c.body[j], c.visual[j], c.auditory[j]];
    for (let k = 0; k < 5; k++) worst = Math.max(worst, Math.abs(s![k] - g[k]));
  }
  return worst;
}

const uniform: () => FrameGen = () => () => 1 / 60;
const irregular: () => FrameGen = () => {
  const rnd = mulberry(1234);
  // wall frame times 4–60 ms with occasional 250 ms hitches, at timewarp 1
  return () => {
    const ms = rnd() < 0.02 ? 250 : 4 + 56 * rnd();
    return ms / 1000 / 60;
  };
};
const timewarp10: () => FrameGen = () => {
  const rnd = mulberry(99);
  return () => 10 * ((1 / 60 + (rnd() - 0.5) * 0.004) / 60); // ~60 fps wall frames × 10
};

describe('PharmacologyModel vs golden file', () => {
  it('golden meta matches the exported constants', () => {
    expect(golden.meta.params.ka).toBe(P.ka);
    expect(golden.meta.params.k10).toBe(P.k10);
    expect(golden.meta.params.k12).toBe(P.k12);
    expect(golden.meta.params.k21).toBe(P.k21);
    expect([...golden.meta.params.ke0]).toEqual([...P.ke0]);
    expect(golden.meta.params.h).toBe(P.h);
    expect(golden.meta.doses).toEqual({ ...DOSES });
    expect(golden.meta.dt).toBeCloseTo(SUB_DT, 15);
    expect(golden.cases.length).toBe(8);
  });

  for (const [label, gen] of [['uniform 1/60 min frames', uniform], ['irregular frames', irregular], ['timewarp 10', timewarp10]] as const) {
    describe(label, () => {
      for (const c of golden.cases) {
        it(`${c.name} within 1e-3`, () => {
          const r = run(c, gen());
          expect(compare(c, r)).toBeLessThan(TOL);
          if (c.hits_applied) {
            expect(r.applied.length).toBe(c.hits_applied.length);
            r.applied.forEach((t, i) => expect(Math.abs(t - c.hits_applied![i].applied_t)).toBeLessThan(1e-9));
          }
        });
      }
    });
  }

  it('simulateCurve reproduces the single-hit golden cases', () => {
    for (const c of golden.cases.filter((x) => x.hits.length === 0)) {
      const cv = simulateCurve(c.dose, c.sensitivity, c.clearance, 25);
      expect(cv.t.length).toBe(c.t.length);
      for (let j = 0; j < c.t.length; j++) {
        expect(Math.abs(cv.visual[j] - c.visual[j])).toBeLessThan(TOL);
        expect(Math.abs(cv.plasma[j] - c.plasma[j])).toBeLessThan(TOL);
        expect(Math.abs(cv.t[j] - c.t[j])).toBeLessThan(1e-9);
      }
    }
  });
});

describe('PharmacologyModel behaviour', () => {
  it('result is independent of how time is chopped up', () => {
    const a = new PharmacologyModel(P, 1, 1); a.addHit(2);
    const b = new PharmacologyModel(P, 1, 1); b.addHit(2);
    a.step(3);
    for (let i = 0; i < 1800; i++) b.step(1 / 600);
    expect(a.subSteps).toBe(1800);
    expect(b.subSteps).toBe(1800);
    expect(a.intensity.visual).toBe(b.intensity.visual);
    expect(a.plasma).toBe(b.plasma);
  });

  it('accumulates fractional steps instead of dropping them', () => {
    const m = new PharmacologyModel();
    for (let i = 0; i < 3000; i++) m.step(SUB_DT / 3);
    expect(m.subSteps).toBe(1000);
    m.step(0); m.step(-1); m.step(Number.NaN);
    expect(m.subSteps).toBe(1000);
  });

  it('blocks repeat hits while visual >= 3 and allows them below', () => {
    const m = new PharmacologyModel(P, 1, 1);
    expect(m.addHit(DOSES.strong)).toBe(true);
    m.step(1.8);
    expect(m.intensity.visual).toBeGreaterThan(HIT_BLOCK_VISUAL);
    const depot = m.depot;
    expect(m.canHit()).toBe(false);
    expect(m.addHit(DOSES.strong)).toBe(false);
    expect(m.depot).toBe(depot);
    while (m.intensity.visual >= HIT_BLOCK_VISUAL) m.step(SUB_DT);
    expect(m.addHit(DOSES.strong)).toBe(true);
    expect(m.repeatHitsUsed).toBe(1);
  });

  it('caps repeat hits at 3', () => {
    const m = new PharmacologyModel(P, 1, 1);
    expect(m.addHit(DOSES.threshold)).toBe(true);
    for (let i = 0; i < MAX_REPEAT_HITS; i++) {
      while (m.intensity.visual >= HIT_BLOCK_VISUAL) m.step(0.1);
      expect(m.addHit(0.01)).toBe(true);
    }
    expect(m.repeatHitsRemaining).toBe(0);
    expect(m.addHit(0.01)).toBe(false);
  });

  it('intensityOf is the sigmoid Emax with EC50 = 1/sensitivity', () => {
    expect(intensityOf(1, 1)).toBeCloseTo(5, 12);
    expect(intensityOf(0.5, 2)).toBeCloseTo(5, 12);
    expect(intensityOf(-1, 1)).toBe(0);
    expect(intensityOf(1e9, 1)).toBeCloseTo(10, 6);
  });

  it('typical strong session summary (§7.3)', () => {
    const s = summariseCurve(simulateCurve(DOSES.strong, 1, 1, 25, 1 / 600));
    expect(Math.abs(s.peakVisual - 6.0)).toBeLessThan(0.1);
    expect(Math.abs(s.peakTimeMin - 1.8)).toBeLessThan(0.1);
    expect(Math.abs(s.minutesAbove1 - 7.2)).toBeLessThan(0.2);
  });
});

describe('golden comparison is sensitive (negative control)', () => {
  it('a 1% sensitivity change is detected', () => {
    const c = golden.cases.find((x) => x.name === 'strong')!;
    const worstOk = compare(c, run(c, uniform()));
    const worstBad = compare({ ...c, sensitivity: 1.01 } as GoldenCase, run({ ...c, sensitivity: 1.01 }, uniform()));
    expect(worstOk).toBeLessThan(1e-6);
    expect(worstBad).toBeGreaterThan(TOL);
  });
});
