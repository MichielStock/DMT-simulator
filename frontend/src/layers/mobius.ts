// Pure TypeScript helpers for the chrysanthemum layer (BUILD.md §11.5): complex numbers, Möbius maps,
// the mirrors of the fundamental triangle of a hyperbolic triangle group (p,q,r) in the Poincaré disk,
// the reflection-folding algorithm the shader runs (mirrored here so it can be tested), Kleinian
// two-generator groups (Maskit's and Grandma's recipes from Mumford, Series & Wright, "Indra's Pearls")
// and the seeded group-crossfade scheduler. No WebGL here.

import { mulberry32, type Rng } from '../rng';

// ---------------------------------------------------------------------------------------------
// complex numbers as [re, im]

export type Cx = [number, number];

export const cx = (re: number, im = 0): Cx => [re, im];
export const cadd = (a: Cx, b: Cx): Cx => [a[0] + b[0], a[1] + b[1]];
export const csub = (a: Cx, b: Cx): Cx => [a[0] - b[0], a[1] - b[1]];
export const cmul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
export const cscale = (a: Cx, s: number): Cx => [a[0] * s, a[1] * s];
export const cconj = (a: Cx): Cx => [a[0], -a[1]];
export const cabs2 = (a: Cx): number => a[0] * a[0] + a[1] * a[1];
export const cabs = (a: Cx): number => Math.hypot(a[0], a[1]);
export function cdiv(a: Cx, b: Cx): Cx {
  const d = cabs2(b);
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
}
export function csqrt(a: Cx): Cx {
  const r = cabs(a);
  const re = Math.sqrt(Math.max(0, (r + a[0]) / 2));
  const im = Math.sqrt(Math.max(0, (r - a[0]) / 2));
  return [re, a[1] < 0 ? -im : im];
}
export const cexpi = (theta: number): Cx => [Math.cos(theta), Math.sin(theta)];

// ---------------------------------------------------------------------------------------------
// Möbius maps as 2×2 complex matrices [a, b, c, d]: z ↦ (a z + b) / (c z + d)

export type Mat2 = [Cx, Cx, Cx, Cx];

export const IDENTITY: Mat2 = [cx(1), cx(0), cx(0), cx(1)];

export function mobius(m: Mat2, z: Cx): Cx {
  return cdiv(cadd(cmul(m[0], z), m[1]), cadd(cmul(m[2], z), m[3]));
}
export function compose(m: Mat2, n: Mat2): Mat2 {   // m ∘ n
  return [
    cadd(cmul(m[0], n[0]), cmul(m[1], n[2])), cadd(cmul(m[0], n[1]), cmul(m[1], n[3])),
    cadd(cmul(m[2], n[0]), cmul(m[3], n[2])), cadd(cmul(m[2], n[1]), cmul(m[3], n[3])),
  ];
}
export const det = (m: Mat2): Cx => csub(cmul(m[0], m[3]), cmul(m[1], m[2]));
export const trace = (m: Mat2): Cx => cadd(m[0], m[3]);
/** Inverse (adjugate; same Möbius map as the true inverse up to scale, exact when det = 1). */
export const inverse = (m: Mat2): Mat2 => [m[3], cscale(m[1], -1), cscale(m[2], -1), m[0]];
/** Scale to determinant 1 (SL(2,C) representative). */
export function normalise(m: Mat2): Mat2 {
  const s = csqrt(det(m));
  return [cdiv(m[0], s), cdiv(m[1], s), cdiv(m[2], s), cdiv(m[3], s)];
}
/** tr(a b a⁻¹ b⁻¹) for det-1 matrices. */
export function commutatorTrace(a: Mat2, b: Mat2): Cx {
  return trace(compose(compose(a, b), compose(inverse(a), inverse(b))));
}

/** Disk automorphism z ↦ (z + a) / (1 + ā z), |a| < 1 (hyperbolic translation taking 0 to a). */
export function diskTranslation(a: Cx): Mat2 {
  return normalise([cx(1), a, cconj(a), cx(1)]);
}
/** Rotation about the disk centre. */
export function diskRotation(theta: number): Mat2 {
  return normalise([cexpi(theta), cx(0), cx(0), cx(1)]);
}
/** Hyperbolic distance in the Poincaré disk (curvature −1). */
export function diskDistance(z: Cx, w: Cx): number {
  const num = cabs(csub(z, w));
  const den = cabs(csub(cx(1), cmul(cconj(z), w)));
  const x = Math.min(1 - 1e-15, num / den);
  return 2 * Math.atanh(x);
}

// ---------------------------------------------------------------------------------------------
// triangle groups

export interface TriangleMirrors {
  p: number; q: number; r: number;
  /** angle of the second mirror line through the origin (first mirror = real axis) = π/p */
  wedge: number;
  /** unit normal of mirror 2 (line at angle π/p); the triangle is where dot(z, n2) <= 0 */
  n2: Cx;
  /** mirror 3: circle orthogonal to the unit circle; the triangle is outside it */
  centre: Cx;
  radius: number;
  /** vertices: A = 0 (angle π/p), B on the real axis (angle π/q), C on the ray at π/p (angle π/r) */
  A: Cx; B: Cx; C: Cx;
}

export function isHyperbolic(p: number, q: number, r: number): boolean {
  return p >= 2 && q >= 2 && r >= 2 && 1 / p + 1 / q + 1 / r < 1 - 1e-9;
}

/** Interior angle at B of the triangle (between B→A and the arc B→C). */
function angleAtB(t: { centre: Cx; B: Cx; C: Cx }): number {
  const rad = csub(t.B, t.centre);
  let tan: Cx = [-rad[1], rad[0]];
  if (tan[1] < 0) tan = [-tan[0], -tan[1]];     // the arc leaves B upwards, towards C
  const l = cabs(tan);
  return Math.acos(Math.max(-1, Math.min(1, -tan[0] / l)));
}
/** Interior angle at C (between C→A and the arc C→B). */
function angleAtC(t: { centre: Cx; B: Cx; C: Cx; wedge: number }): number {
  const rad = csub(t.C, t.centre);
  let tan: Cx = [-rad[1], rad[0]];
  // the arc leaves C towards B: towards the real axis side of the ray (dot with n2 < 0)
  const n2: Cx = [-Math.sin(t.wedge), Math.cos(t.wedge)];
  if (tan[0] * n2[0] + tan[1] * n2[1] > 0) tan = [-tan[0], -tan[1]];
  const toA = cscale(t.C, -1 / cabs(t.C));
  const l = cabs(tan);
  return Math.acos(Math.max(-1, Math.min(1, (tan[0] * toA[0] + tan[1] * toA[1]) / l)));
}

/**
 * The three mirrors of the fundamental triangle of the (p,q,r) triangle group, with vertex A at the
 * disk centre. Throws for non-hyperbolic triples.
 */
export function triangleMirrors(p: number, q: number, r: number): TriangleMirrors {
  if (!isHyperbolic(p, q, r)) throw new Error(`(${p},${q},${r}) is not a hyperbolic triangle group`);
  const wedge = Math.PI / p;
  const n1: Cx = [0, 1];
  const n2: Cx = [-Math.sin(wedge), Math.cos(wedge)];
  const cq = Math.cos(Math.PI / q);
  const cr = Math.cos(Math.PI / r);
  // Solve n1·c = s1 R cq, n2·c = s2 R cr, |c|² = R² + 1 (orthogonal to the unit circle). Pick the sign
  // pair whose triangle has the right interior angles.
  const detM = n1[0] * n2[1] - n1[1] * n2[0];
  let best: TriangleMirrors | null = null;
  let bestErr = Infinity;
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      const v1 = s1 * cq; const v2 = s2 * cr;
      // c = R · M⁻¹ v with rows n1, n2
      const ux = (v1 * n2[1] - n1[1] * v2) / detM;
      const uy = (n1[0] * v2 - v1 * n2[0]) / detM;
      const k = ux * ux + uy * uy - 1;
      if (k <= 0) continue;
      const R = 1 / Math.sqrt(k);
      const c: Cx = [ux * R, uy * R];
      // B: x² − 2 x cx + 1 = 0 ; C: s² − 2 s (u·c) + 1 = 0 (roots inside the disk)
      const disc1 = c[0] * c[0] - 1;
      const uc = Math.cos(wedge) * c[0] + Math.sin(wedge) * c[1];
      const disc2 = uc * uc - 1;
      if (disc1 < 0 || disc2 < 0 || c[0] <= 0 || uc <= 0) continue;
      const bx = c[0] - Math.sqrt(disc1);
      const cs = uc - Math.sqrt(disc2);
      if (!(bx > 0 && bx < 1 && cs > 0 && cs < 1)) continue;
      const B: Cx = [bx, 0];
      const C: Cx = [cs * Math.cos(wedge), cs * Math.sin(wedge)];
      const cand: TriangleMirrors = { p, q, r, wedge, n2, centre: c, radius: R, A: [0, 0], B, C };
      const err = Math.abs(angleAtB(cand) - Math.PI / q) + Math.abs(angleAtC(cand) - Math.PI / r);
      if (err < bestErr) { bestErr = err; best = cand; }
    }
  }
  if (!best || bestErr > 1e-6) throw new Error(`no fundamental triangle found for (${p},${q},${r})`);
  return best;
}

/** Interior angles [A, B, C] of the fundamental triangle (for tests). */
export function triangleAngles(t: TriangleMirrors): [number, number, number] {
  const a = Math.atan2(t.C[1], t.C[0]) - Math.atan2(t.B[1], t.B[0]);
  return [a, angleAtB(t), angleAtC(t)];
}

/** Reflection in a line through the origin with unit normal n. */
export function reflectLine(z: Cx, n: Cx): Cx {
  const d = z[0] * n[0] + z[1] * n[1];
  return [z[0] - 2 * d * n[0], z[1] - 2 * d * n[1]];
}
/** Inversion in the circle |z − c| = R. */
export function invertCircle(z: Cx, c: Cx, R: number): Cx {
  const w = csub(z, c);
  const k = (R * R) / cabs2(w);
  return [c[0] + w[0] * k, c[1] + w[1] * k];
}

export interface FoldResult {
  z: Cx;
  /** total number of reflections applied (parity colours the tiles) */
  reflections: number;
  /** number of circle inversions (≈ how many tile rings from the centre) */
  depth: number;
  /** conformal scale factor |dz_folded / dz| */
  scale: number;
  iterations: number;
  converged: boolean;
}

/** True when z lies in the closed fundamental triangle (within eps). */
export function inFundamental(t: TriangleMirrors, z: Cx, eps = 1e-9): boolean {
  return z[1] >= -eps && z[0] * t.n2[0] + z[1] * t.n2[1] <= eps && cabs(csub(z, t.centre)) >= t.radius - eps;
}

/**
 * Fold z (|z| < 1) into the fundamental triangle by iterated reflection in the three mirrors — the
 * algorithm the shader runs: one dihedral fold into the wedge [0, π/p] (k sector reflections), then
 * an inversion in the circle mirror, repeated until nothing changes or `maxIter` is reached.
 */
export function foldToFundamental(t: TriangleMirrors, z0: Cx, maxIter = 48): FoldResult {
  let z: Cx = [z0[0], z0[1]];
  let reflections = 0; let depth = 0; let scale = 1; let it = 0; let converged = false;
  const R2 = t.radius * t.radius;
  for (; it < maxIter; it++) {
    // dihedral fold into the wedge
    let a = Math.atan2(z[1], z[0]);
    if (a < 0) a += 2 * Math.PI;
    const k = Math.floor(a / t.wedge);
    if (k > 0) {
      const m = Math.hypot(z[0], z[1]);
      const a2 = k % 2 === 0 ? a - k * t.wedge : (k + 1) * t.wedge - a;
      z = [m * Math.cos(a2), m * Math.sin(a2)];
      reflections += k;
    }
    const w = csub(z, t.centre);
    const l2 = cabs2(w);
    if (l2 < R2) {
      z = [t.centre[0] + (w[0] * R2) / l2, t.centre[1] + (w[1] * R2) / l2];
      scale *= R2 / l2;
      reflections += 1;
      depth += 1;
    } else if (k === 0) {
      converged = true;
      break;
    }
  }
  return { z, reflections, depth, scale, iterations: it, converged };
}

// ---------------------------------------------------------------------------------------------
// Kleinian groups (Indra's Pearls)

export interface Generators { a: Mat2; b: Mat2 }

/** Maskit's recipe: a = [[−iμ, −i], [−i, 0]], b = [[1, 2], [0, 1]]; tr a = −iμ, tr b = 2, tr[a,b] = −2. */
export function maskitGenerators(mu: Cx): Generators {
  const mi: Cx = [0, -1];
  return {
    a: [cmul(mi, mu), mi, mi, cx(0)],
    b: [cx(1), cx(2), cx(0), cx(1)],
  };
}

/**
 * Grandma's recipe (Indra's Pearls, box 21): two generators with traces ta, tb whose commutator is
 * parabolic (tr abAB = −2). Returns the generators and tr ab.
 */
export function grandmaGenerators(ta: Cx, tb: Cx, plus = false): Generators & { tab: Cx } {
  const i: Cx = [0, 1];
  const tatb = cmul(ta, tb);
  const disc = csqrt(csub(cmul(tatb, tatb), cscale(cadd(cmul(ta, ta), cmul(tb, tb)), 4)));
  const tab = cscale(plus ? cadd(tatb, disc) : csub(tatb, disc), 0.5);
  const tabm2 = csub(tab, cx(2));
  const z0 = cdiv(cmul(tabm2, tb), cadd(csub(cmul(tb, tab), cscale(ta, 2)), cmul(cscale(i, 2), tab)));
  const half = (c: Cx) => cscale(c, 0.5);
  const tatab = cmul(ta, tab);
  const a: Mat2 = [
    half(ta),
    cdiv(cadd(csub(tatab, cscale(tb, 2)), cscale(i, 4)), cmul(cadd(cscale(tab, 2), cx(4)), z0)),
    cdiv(cmul(csub(csub(tatab, cscale(tb, 2)), cscale(i, 4)), z0), csub(cscale(tab, 2), cx(4))),
    half(ta),
  ];
  const b: Mat2 = [half(csub(tb, cscale(i, 2))), half(tb), half(tb), half(cadd(tb, cscale(i, 2)))];
  return { a, b, tab };
}

/**
 * Map the trip script's trace parameters (Re ≈ 1.9–2.3, Im ≈ 0–0.25 from the priors) onto the part of
 * the Maskit slice the shader renders robustly: μ = −shift + i·height with height in [1.93, 2.0]
 * (2 = the Apollonian-gasket cusp group) and a small horizontal shift that twists the pearl chains.
 */
export function maskitParams(traceA: Cx, traceB: Cx): { height: number; shift: number } {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const ua = clamp((traceA[0] - 1.9) / 0.4, 0, 1);           // 0..1 over the prior range
  const ub = clamp(traceB[1] / 0.25, 0, 1);
  const height = 2.0 - 0.07 * Math.abs(ua - 0.5) * 2;        // 1.93..2.0
  const shift = clamp(0.08 * (traceA[1] / 0.25) + 0.12 * (ub - 0.5), -0.15, 0.15);
  return { height, shift };
}

/** μ of maskitGenerators corresponding to the shader parameters (a(z) = μ + 1/z). */
export function maskitMu(p: { height: number; shift: number }): Cx {
  return [-p.shift, p.height];
}

// ---------------------------------------------------------------------------------------------
// group crossfade scheduler ("flicker" between groups, BUILD.md §4.1 / §11.5)

export const CROSSFADE_MIN_S = 0.3;

export interface SchedulerOptions {
  /** model-time interval between changes, seconds */
  minInterval?: number;
  maxInterval?: number;
  /** wall-clock crossfade length, seconds (never below CROSSFADE_MIN_S) */
  crossfade?: number;
}

export interface CrossfadeState {
  /** indices into the group list */
  from: number;
  to: number;
  /** 0 = only `from` visible, 1 = only `to` */
  mix: number;
  /** number of group changes started so far */
  changes: number;
}

/**
 * Seeded scheduler: picks the next group every 6–14 s of MODEL time (challenge: shorter), but each
 * change is a crossfade over ≥ 0.3 s of WALL time (smoothstep), and a new change never starts before
 * the previous crossfade has finished — so even at ?timewarp the groups never change faster than the
 * crossfade allows.
 */
export class GroupScheduler {
  private readonly rng: Rng;
  private readonly n: number;
  private from = 0;
  private to = 0;
  private progress = 1;          // 0..1 of the current crossfade (wall time)
  private nextAt: number;        // model seconds of the next change
  private modelT = 0;
  private changes = 0;
  readonly minInterval: number;
  readonly maxInterval: number;
  readonly crossfade: number;

  constructor(nGroups: number, seed: number, opts: SchedulerOptions = {}) {
    this.n = Math.max(1, Math.floor(nGroups));
    this.rng = mulberry32(seed);
    this.minInterval = opts.minInterval ?? 6;
    this.maxInterval = Math.max(this.minInterval, opts.maxInterval ?? 14);
    this.crossfade = Math.max(CROSSFADE_MIN_S, opts.crossfade ?? 1.2);
    this.nextAt = this.interval(0);
  }

  private interval(challenge: number): number {
    const k = 1 - 0.45 * Math.max(0, Math.min(1, challenge));    // challenge: changes come sooner
    return (this.minInterval + (this.maxInterval - this.minInterval) * this.rng()) * k;
  }

  /**
   * Advance by `modelDt` seconds of model time and `wallDt` seconds of wall time. `challenge` (0–1)
   * shortens the intervals; the crossfade length (wall) is never shortened below 0.3 s.
   */
  update(modelDt: number, wallDt: number, challenge = 0): CrossfadeState {
    this.modelT += Math.max(0, modelDt);
    if (this.progress < 1) this.progress = Math.min(1, this.progress + Math.max(0, wallDt) / this.crossfadeLength(challenge));
    if (this.progress >= 1 && this.modelT >= this.nextAt && this.n > 1) {
      this.from = this.to;
      let k = Math.floor(this.rng() * (this.n - 1));
      if (k >= this.from) k += 1;                                // never the same group
      this.to = k;
      this.progress = 0;
      this.changes++;
      this.nextAt = this.modelT + this.interval(challenge);
    } else if (this.progress >= 1 && this.modelT >= this.nextAt) {
      this.nextAt = this.modelT + this.interval(challenge);
    }
    return this.state;
  }

  crossfadeLength(challenge = 0): number {
    return Math.max(CROSSFADE_MIN_S, this.crossfade * (1 - 0.4 * Math.max(0, Math.min(1, challenge))));
  }

  get state(): CrossfadeState {
    const x = this.progress;
    return { from: this.from, to: this.to, mix: x * x * (3 - 2 * x), changes: this.changes };
  }
}

/** Groups from a trip script, filtered to valid hyperbolic triples; a default if none survive. */
export function sanitiseGroups(groups: unknown): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (Array.isArray(g) && g.length === 3) {
        const t = g.map((x) => Math.round(Number(x))) as [number, number, number];
        if (t.every((x) => Number.isFinite(x) && x >= 2 && x <= 24) && isHyperbolic(t[0], t[1], t[2])) {
          // the largest order goes to the centre vertex A (angle π/p): the most petals around the middle
          out.push([...t].sort((x, y) => y - x) as [number, number, number]);
        }
      }
    }
  }
  return out.length ? out : [[2, 3, 7], [2, 4, 5], [3, 3, 4]];
}
