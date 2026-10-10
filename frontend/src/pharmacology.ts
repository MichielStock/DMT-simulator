// Live pharmacology model (BUILD.md §7): TypeScript port of backend/pharmacology.py.
// RK4 at a fixed sub-step of 1/600 min. step(dtMin) feeds an accumulator and advances an integer
// number of sub-steps, so results do not depend on frame rate or timewarp. Matches the protected
// golden file shared/golden/pharmacology.json to 1e-3 (frontend/tests/pharmacology.test.ts).
// Concentrations are dimensionless, relative to the half-effect level. Never real units.

export interface PkParams {
  ka: number;
  k10: number;
  k12: number;
  k21: number;
  ke0: readonly [number, number, number] | readonly number[];
  h: number;
}

export type DoseStep = 'threshold' | 'light' | 'strong' | 'breakthrough';

export const P: Readonly<PkParams> = Object.freeze({
  ka: 4.0, k10: 0.12, k12: 0.2, k21: 0.03, ke0: Object.freeze([2.5, 1.2, 0.6]) as readonly number[], h: 2.0,
});

export const DOSES: Readonly<Record<DoseStep, number>> = Object.freeze({
  threshold: 0.4, light: 1.0, strong: 2.0, breakthrough: 4.0,
});

/** Fixed integration sub-step in minutes. */
export const SUB_DT = 1 / 600;
/** Repeat hits are blocked while visual intensity is at or above this (§7.5). */
export const HIT_BLOCK_VISUAL = 3.0;
/** At most this many repeat hits after the first one (§4.2, §7.5). */
export const MAX_REPEAT_HITS = 3;
/** Safety bound on sub-steps per step() call (a 30-minute session at most); avoids runaway loops. */
const MAX_SUBSTEPS_PER_CALL = 30 * 600;

export interface Intensity { body: number; visual: number; auditory: number }

/** 0–10 intensity for an effect-site concentration (sigmoid Emax, EC50 = 1 / sensitivity). */
export function intensityOf(ce: number, sensitivity = 1, h: number = P.h): number {
  const c = Math.max(ce, 0);
  const ch = Math.pow(c, h);
  const eh = Math.pow(1 / sensitivity, h);
  return (10 * ch) / (ch + eh);
}

export class PharmacologyModel {
  readonly params: PkParams;
  readonly sensitivity: number;
  readonly clearance: number;
  /** Optional hook called after every sub-step (e.g. for exact 0.1-minute sampling). */
  onSubStep: ((m: PharmacologyModel) => void) | null = null;

  // state: A (depot), C (plasma), Pp (peripheral), Ce[3]
  private y = new Float64Array(6);
  private acc = 0; // accumulated sub-steps not yet integrated (fraction in [0, 1))
  private n = 0; // sub-steps done
  private hits = 0; // applied hits (first + repeats)
  private cached: Intensity | null = null;
  private readonly k10: number;
  private readonly ke: [number, number, number];

  constructor(params: PkParams = P, sensitivity = 1, clearance = 1) {
    this.params = params;
    this.sensitivity = sensitivity;
    this.clearance = clearance;
    this.k10 = params.k10 * clearance;
    this.ke = [params.ke0[0], params.ke0[1], params.ke0[2]];
  }

  /** Minutes on the model clock (integer number of sub-steps × 1/600). */
  get tMin(): number { return this.n * SUB_DT; }
  get subSteps(): number { return this.n; }
  get plasma(): number { return this.y[1]; }
  get depot(): number { return this.y[0]; }
  get effectSite(): [number, number, number] { return [this.y[3], this.y[4], this.y[5]]; }
  get hitCount(): number { return this.hits; }
  get repeatHitsUsed(): number { return Math.max(0, this.hits - 1); }
  get repeatHitsRemaining(): number { return Math.max(0, MAX_REPEAT_HITS - this.repeatHitsUsed); }

  get intensity(): Intensity {
    if (!this.cached) {
      const s = this.sensitivity, h = this.params.h;
      this.cached = {
        body: intensityOf(this.y[3], s, h),
        visual: intensityOf(this.y[4], s, h),
        auditory: intensityOf(this.y[5], s, h),
      };
    }
    return this.cached;
  }

  /** true if a hit would be accepted right now. */
  canHit(): boolean {
    if (this.hits === 0) return true;
    return this.intensity.visual < HIT_BLOCK_VISUAL && this.repeatHitsUsed < MAX_REPEAT_HITS;
  }

  /** Add `dose` (model units) to the absorption depot. Returns false (blocked, nothing changes)
   *  while visual intensity ≥ 3 or when the 3 repeat hits are used up. */
  addHit(dose: number): boolean {
    if (!(dose >= 0) || !Number.isFinite(dose)) return false;
    if (!this.canHit()) return false;
    this.y[0] += dose;
    this.hits += 1;
    return true;
  }

  /** Advance the model clock by dtMin minutes (any value ≥ 0; e.g. timewarp × wall dt). */
  step(dtMin: number): void {
    if (!(dtMin > 0) || !Number.isFinite(dtMin)) return;
    this.acc += dtMin / SUB_DT;
    let k = Math.floor(this.acc + 1e-7);
    this.acc -= k;
    if (this.acc < 0) this.acc = 0;
    if (k > MAX_SUBSTEPS_PER_CALL) k = MAX_SUBSTEPS_PER_CALL;
    for (let i = 0; i < k; i++) {
      this.rk4();
      this.n += 1;
      this.cached = null;
      if (this.onSubStep) this.onSubStep(this);
    }
  }

  private deriv(y: Float64Array, out: Float64Array): void {
    const { ka, k12, k21 } = this.params;
    const A = y[0], C = y[1], Pp = y[2];
    out[0] = -ka * A;
    out[1] = ka * A - (this.k10 + k12) * C + k21 * Pp;
    out[2] = k12 * C - k21 * Pp;
    out[3] = this.ke[0] * (C - y[3]);
    out[4] = this.ke[1] * (C - y[4]);
    out[5] = this.ke[2] * (C - y[5]);
  }

  private k1 = new Float64Array(6);
  private k2 = new Float64Array(6);
  private k3 = new Float64Array(6);
  private k4 = new Float64Array(6);
  private tmp = new Float64Array(6);

  private rk4(): void {
    const dt = SUB_DT, y = this.y, t = this.tmp;
    this.deriv(y, this.k1);
    for (let i = 0; i < 6; i++) t[i] = y[i] + (dt / 2) * this.k1[i];
    this.deriv(t, this.k2);
    for (let i = 0; i < 6; i++) t[i] = y[i] + (dt / 2) * this.k2[i];
    this.deriv(t, this.k3);
    for (let i = 0; i < 6; i++) t[i] = y[i] + dt * this.k3[i];
    this.deriv(t, this.k4);
    for (let i = 0; i < 6; i++) {
      y[i] = y[i] + (dt / 6) * (this.k1[i] + 2 * this.k2[i] + 2 * this.k3[i] + this.k4[i]);
    }
  }
}

export interface Curve {
  t: number[];
  plasma: number[];
  body: number[];
  visual: number[];
  auditory: number[];
}

/** Single-hit curve for the HUD / report preview, sampled every `sampleEveryMin` minutes
 *  (rounded to whole sub-steps), from 0 to T inclusive. */
export function simulateCurve(doseRel: number, sensitivity = 1, clearance = 1, T = 25,
  sampleEveryMin = 0.1, params: PkParams = P): Curve {
  const m = new PharmacologyModel(params, sensitivity, clearance);
  const every = Math.max(1, Math.round(sampleEveryMin / SUB_DT));
  const total = Math.round(T / SUB_DT);
  const out: Curve = { t: [], plasma: [], body: [], visual: [], auditory: [] };
  const record = (mm: PharmacologyModel) => {
    const I = mm.intensity;
    out.t.push(mm.tMin); out.plasma.push(mm.plasma);
    out.body.push(I.body); out.visual.push(I.visual); out.auditory.push(I.auditory);
  };
  m.addHit(doseRel);
  record(m);
  m.onSubStep = (mm) => { if (mm.subSteps % every === 0) record(mm); };
  let left = total;
  while (left > 0) {
    const k = Math.min(left, every * 100);
    // step whole sub-steps; integer k avoids accumulator rounding
    m.step(k * SUB_DT);
    left -= k;
  }
  return out;
}

/** Peak visual, its time and minutes with visual > 1, from a curve (sample-resolution). */
export function summariseCurve(c: Curve): { peakVisual: number; peakTimeMin: number; minutesAbove1: number } {
  let iMax = 0;
  for (let i = 1; i < c.visual.length; i++) if (c.visual[i] > c.visual[iMax]) iMax = i;
  const dt = c.t.length > 1 ? c.t[1] - c.t[0] : 0;
  const above = c.visual.filter((v) => v > 1).length * dt;
  return { peakVisual: c.visual[iMax] ?? 0, peakTimeMin: c.t[iMax] ?? 0, minutesAbove1: above };
}
