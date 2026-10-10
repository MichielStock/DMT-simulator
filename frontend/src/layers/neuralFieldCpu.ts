// CPU reference of the neural-field dynamics behind the form-constants layer (BUILD.md §11.4).
// The GPU layer (neuralField.ts + glsl/field*.glsl) runs exactly these equations with the same
// constants, kernels, noise hash and regime mapping; this file is used by the unit tests and to
// predict the selected wavenumber and the critical gain.
//
// Model (Ermentrout & Cowan 1979; Bressloff et al. 2001), on an N×N torus of cortical cells
// (x = log eccentricity, y = visual angle; both periodic, see NOTES.md D-NF1):
//
//   τ ∂u/∂t = −u + A·(w ⊛ f(u)) + h + I_spiral(x, y, t) + σ ξ(x, y, t)
//
//   w      = w_iso + ε_x w_x + ε_y w_y + ε_d w_d
//   w_iso  = G_σe − G_σi               (2-D, separable; normalised Gaussians, ratio σi/σe = ρ = 2)
//   w_x    = (g_σe − g_σi)(x) δ(y)     (1-D "line" kernels along x, y and a diagonal: anisotropic
//   w_y, w_d                            lateral connections; they bias the selected orientation)
//   f(u)   = S(βu) + α·(S(β_c u) − ½)²  S = logistic sigmoid; the quadratic term breaks u → −u symmetry
//   h      = 0
//
// Linear stability (derivation of criticalGain and predictWavenumber):
//   Every normalised Gaussian has unit mass, so ŵ(0) = 0 and the uniform state is u0 = h = 0 for
//   any β and α. At u0 = 0: S(0) = ½, S'(0) = β/4, and d/du (S(β_c u) − ½)² = 0, so f'(0) = β/4
//   independently of α. A perturbation δu ∝ exp(i k·x + λt) obeys
//        τ λ(k) = −1 + A · f'(0) · ŵ(k) = −1 + (A β / 4) · ŵ(k).
//   The uniform state loses stability when the largest eigenvalue crosses zero:
//        β_c · f'(u0)/β · A · ŵ(k*) = 1   ⇔   β_c = 4 / (A · max_k ŵ(k)),
//   and the pattern that grows has the wavevector k* that maximises ŵ. In the continuum,
//   ŵ_iso(k) = exp(−k²σe²/2) − exp(−k²σi²/2), maximal at k*² = 2 ln(ρ²) / (σi² − σe²), i.e.
//   k* σe = sqrt(2 ln ρ² / (ρ² − 1)) = 0.9613 for ρ = 2, with ŵ_iso(k*) = 0.4725. A line kernel
//   along direction d has transform ε·ŵ_1D(k·d) with the same shape, so modes with k ∥ d get
//   (1 + ε)·ŵ(k*): same wavenumber, lower threshold → orientation selection. On the lattice we
//   evaluate the discrete transforms exactly (tables of 1-D cosine sums), see `kernelSpectrum`.
//   The gain is β = β_c · (B0 + B1 · v · g), g = 0.5 + 0.5·absorptionGain, so with neutral
//   absorption (g = 1) the uniform state becomes unstable at v = (1 − B0)/B1 = 2.0; the ratio is capped at
//   GAIN_MAX and rate-limited (GAIN_RATE_UP/DOWN).
//   Euler–Maruyama with Δt/τ = 0.125 is stable: the linear eigenvalues lie in [−1/τ, (β/β_c − 1)/τ].

export const FIELD_N = 256;
/** Time constant of the field (seconds of WALL time; the field never runs on the time-warped model clock). */
export const TAU = 0.2;
/** Fixed integration step (wall seconds). The GPU layer runs floor(elapsed / DT) sub-steps per frame. */
export const DT = 0.025;
/** Cap on sub-steps per frame (a long frame slows the field instead of jumping it). */
export const MAX_STEPS_PER_FRAME = 6;
/** Kernel amplitude A. */
export const KERNEL_A = 2.0;
/** Inhibition / excitation width ratio ρ. */
export const SIGMA_RATIO = 2.0;
/** k*·σe for ρ = 2 (continuum). */
export const K_SIGMA_E = Math.sqrt((2 * Math.log(SIGMA_RATIO * SIGMA_RATIO)) / (SIGMA_RATIO * SIGMA_RATIO - 1));
/** Noise amplitude σ. */
export const NOISE_SIGMA = 0.03;
/** β / β_c = B0 + B1 · v · g, capped at GAIN_MAX (β0 = 0, κ = 0.5·β_c: critical at v·g = 2). The cap keeps
 *  the field in the weakly nonlinear regime, where patterns anneal into ordered planforms instead of
 *  freezing into labyrinths (checked with this reference; NOTES.md D-NF2). */
export const GAIN_B0 = 0;
export const GAIN_B1 = 0.5;
export const GAIN_MAX = 1.8;
/** The gain follows its target at a limited rate (per second of field time): patterns always
 *  nucleate near onset (ordered), and a jump of v never makes a pattern appear abruptly. */
export const GAIN_RATE_UP = 0.3;
export const GAIN_RATE_DOWN = 0.6;
/** Orientation bias of the line kernels for the striped regimes. */
export const ANISO_EPS = 1.0;
/** Quadratic asymmetry for hexagons. */
export const ALPHA_HEX = 3.0;
/** Pinning input: a weak, lattice-commensurate planform template at k* for the current class weights,
 *  switched on with the instability (smoothstep of β/β_c over 0.95–1.15, so it adds nothing below
 *  threshold). It selects among the degenerate orientations/phases of the Turing pattern so that
 *  domains agree (ordered rings, funnels, spirals, hexagonal lattices) instead of freezing into a
 *  polycrystal; the instability, the wavenumber and the stripes/hexagon choice stay with the dynamics. */
export const PIN_AMP = 0.015;
/** Display normalisation: activity a = ½ + ½ tanh(u / U_REF). */
export const U_REF = 0.3;
/** Spiral seeding: amplitude, radius (cells), rotation (Hz), duration (s), interval (s). */
export const SPIRAL = { amp: 0.12, radius: 46, hz: 0.08, durS: 10, minGapS: 20, maxGapS: 40 } as const;
/** Wavelength range (cells) and the trip-script mapping wavelength 0.6–1.3 → 8–16 cells. */
export const LAMBDA_MIN = 8;
export const LAMBDA_MAX = 16;

export function wavelengthCells(tripWavelength: number | null | undefined): number {
  const w = typeof tripWavelength === 'number' && Number.isFinite(tripWavelength) ? tripWavelength : 0.95;
  const t = Math.min(1, Math.max(0, (w - 0.6) / 0.7));
  return LAMBDA_MIN + (LAMBDA_MAX - LAMBDA_MIN) * t;
}

// ------------------------------------------------------------------------------------------------
// hash noise (identical integer arithmetic in glsl/fieldCommon.glsl)

export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Approximately standard normal noise for (cell, step, seed): sum of four uniforms, rescaled. */
export function gaussNoise(cell: number, step: number, seedHash: number): number {
  const h = hash32((cell + hash32((step + seedHash) >>> 0)) >>> 0);
  let s = 0;
  for (let k = 0; k < 4; k++) s += hash32((h + k * 0x9e3779b9) >>> 0) / 4294967296;
  return (s - 2) * 1.7320508;
}

export function seedHash(seed: number): number {
  return hash32((seed | 0) ^ 0x5bd1e995);
}

/** Uniform 0–1 from (seed, index, salt), for schedules and seeded phases. */
export function seededUniform(seed: number, index: number, salt: number): number {
  return hash32((seedHash(seed) + hash32((index * 7919 + salt) >>> 0)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------------------------------------
// kernels

export interface Kernel {
  lambda: number;
  sigmaE: number;
  sigmaI: number;
  radius: number;
  /** axis taps j = −R..R (index j + R), normalised */
  ge: Float32Array;
  gi: Float32Array;
  /** diagonal taps (step length √2), normalised */
  gde: Float32Array;
  gdi: Float32Array;
}

function gaussTaps(sigma: number, radius: number, step: number): Float32Array {
  const t = new Float32Array(2 * radius + 1);
  let s = 0;
  for (let j = -radius; j <= radius; j++) {
    const d = j * step;
    const v = Math.exp(-(d * d) / (2 * sigma * sigma));
    t[j + radius] = v; s += v;
  }
  for (let i = 0; i < t.length; i++) t[i] /= s;
  return t;
}

/** Maximum kernel radius (taps) supported by the GPU shaders. */
export const MAX_RADIUS = 24;

export function makeKernel(lambda: number): Kernel {
  const lam = Math.min(LAMBDA_MAX * 1.25, Math.max(LAMBDA_MIN * 0.75, lambda));
  const sigmaE = (K_SIGMA_E * lam) / (2 * Math.PI);
  const sigmaI = SIGMA_RATIO * sigmaE;
  const radius = Math.min(MAX_RADIUS, Math.ceil(3 * sigmaI));
  return {
    lambda: lam, sigmaE, sigmaI, radius,
    ge: gaussTaps(sigmaE, radius, 1), gi: gaussTaps(sigmaI, radius, 1),
    gde: gaussTaps(sigmaE, radius, Math.SQRT2), gdi: gaussTaps(sigmaI, radius, Math.SQRT2),
  };
}

// ------------------------------------------------------------------------------------------------
// regimes (trip script layers.form_constants → orientation bias + asymmetry)

export type FcMode = 'stripes_x' | 'stripes_y' | 'spirals' | 'hexagons';
export const FC_MODES: FcMode[] = ['stripes_x', 'stripes_y', 'spirals', 'hexagons'];

export interface Regime {
  epsX: number;   // line kernel along x  → stripes varying along x  → rings / tunnels
  epsY: number;   // line kernel along y  → stripes varying along y  → funnels
  epsD: number;   // line kernel along a diagonal → oblique stripes → spirals
  diag: 1 | -1;   // diagonal direction (spiral handedness)
  alpha: number;  // quadratic asymmetry → hexagons / lattices
}

export interface FormConstantsSpec { mode?: string | null; wavelength?: number | null; spiral_bias?: number | null }

const CLASS_REGIME: Record<FcMode, Omit<Regime, 'diag'>> = {
  stripes_x: { epsX: ANISO_EPS, epsY: 0, epsD: 0, alpha: 0 },
  stripes_y: { epsX: 0, epsY: ANISO_EPS, epsD: 0, alpha: 0 },
  spirals: { epsX: 0, epsY: 0, epsD: ANISO_EPS, alpha: 0 },
  hexagons: { epsX: 0, epsY: 0, epsD: 0, alpha: ALPHA_HEX },
};

/** Class weights (sum 1) for a trip-script spec at field time t (seconds). `mixed` drifts slowly
 *  through the four classes with a seeded phase (period ~110 s); `stripes` picks rings or funnels
 *  by seed unless spiral_bias ≥ 0.4 (then spirals). */
export function classWeights(spec: FormConstantsSpec | null | undefined, seed: number, t: number): Record<FcMode, number> {
  const w: Record<FcMode, number> = { stripes_x: 0, stripes_y: 0, spirals: 0, hexagons: 0 };
  const mode = String(spec?.mode ?? 'stripes');
  const bias = Math.min(1, Math.max(0, Number(spec?.spiral_bias ?? 0) || 0));
  if ((FC_MODES as string[]).includes(mode)) { w[mode as FcMode] = 1; return w; }
  if (mode === 'hexagons' || mode === 'lattice' || mode === 'lattices') { w.hexagons = 1; return w; }
  if (mode === 'mixed') {
    // a slow walk round the cycle rings → spirals → funnels → lattices, staying in each class
    // most of the time (smooth plateau), seeded phase; spiral_bias lengthens the spiral stay
    const period = 110;
    const ph = (t / period + seededUniform(seed, 1, 11)) % 1;
    const order: FcMode[] = ['stripes_x', 'spirals', 'stripes_y', 'hexagons'];
    const pos = ph * 4;
    const i = Math.floor(pos) % 4;
    const f = pos - Math.floor(pos);
    const s = smooth(0.65, 1.0, f); // plateau, then a crossfade over the last 35% of the quarter
    w[order[i]] += 1 - s;
    w[order[(i + 1) % 4]] += s;
    if (bias > 0) { const k = 0.5 * bias; for (const m of order) w[m] *= 1 - k; w.spirals += k; }
    return w;
  }
  // stripes (default)
  if (bias >= 0.4) w.spirals = 1;
  else if (seededUniform(seed, 2, 13) < 0.5) w.stripes_x = 1;
  else w.stripes_y = 1;
  return w;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The regime (orientation bias + asymmetry) at field time t. The asymmetry drifts slowly
 *  (period 97 s, seeded phase) around its class value: stripes ↔ hexagons mode selection. */
export function regimeAt(spec: FormConstantsSpec | null | undefined, seed: number, t: number): Regime {
  const w = classWeights(spec, seed, t);
  const r: Regime = { epsX: 0, epsY: 0, epsD: 0, diag: seededUniform(seed, 3, 17) < 0.5 ? 1 : -1, alpha: 0 };
  for (const m of FC_MODES) {
    const c = CLASS_REGIME[m];
    r.epsX += w[m] * c.epsX; r.epsY += w[m] * c.epsY; r.epsD += w[m] * c.epsD; r.alpha += w[m] * c.alpha;
  }
  const drift = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 97 + 2 * Math.PI * seededUniform(seed, 4, 19));
  r.alpha = Math.max(0, r.alpha + 0.2 * drift * (w.hexagons > 0.5 ? 1 : 0.5) - (w.hexagons > 0.5 ? 0.1 : 0));
  return r;
}

// ------------------------------------------------------------------------------------------------
// spectrum of the kernel, predictions

/** Discrete 1-D cosine transform table of taps over the N lattice wavenumbers 2πm/N. */
function cosTable(t: Float32Array, n: number): Float64Array {
  const R = (t.length - 1) / 2;
  const out = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    const k = (2 * Math.PI * m) / n;
    let s = 0;
    for (let j = -R; j <= R; j++) s += t[j + R] * Math.cos(k * j);
    out[m] = s;
  }
  return out;
}

export interface KernelSpectrum { what: Float64Array; n: number }

/** ŵ(m, n) on the lattice (index m along x, n along y), excluding the amplitude A. */
export function kernelSpectrum(kernel: Kernel, regime: Regime, n = FIELD_N): KernelSpectrum {
  const Ge = cosTable(kernel.ge, n), Gi = cosTable(kernel.gi, n);
  const De = cosTable(kernel.gde, n), Di = cosTable(kernel.gdi, n);
  const what = new Float64Array(n * n);
  for (let ky = 0; ky < n; ky++) {
    for (let kx = 0; kx < n; kx++) {
      const kd = (((kx + regime.diag * ky) % n) + n) % n;
      what[ky * n + kx] = Ge[kx] * Ge[ky] - Gi[kx] * Gi[ky]
        + regime.epsX * (Ge[kx] - Gi[kx]) + regime.epsY * (Ge[ky] - Gi[ky]) + regime.epsD * (De[kd] - Di[kd]);
    }
  }
  return { what, n };
}

export interface WavenumberPrediction {
  /** |k| in radians per cell */
  k: number;
  /** wavelength in cells */
  lambda: number;
  /** lattice mode indices of the most unstable wavevector (signed, −N/2..N/2) */
  mx: number;
  my: number;
  /** max ŵ (without A) */
  wMax: number;
}

const signedIndex = (m: number, n: number): number => (m > n / 2 ? m - n : m);

/** The wavevector the Turing instability selects: argmax of the discrete ŵ. */
export function predictWavenumber(lambdaCells: number, regime: Regime = CLASS_NONE, n = FIELD_N): WavenumberPrediction {
  const { what } = kernelSpectrum(makeKernel(lambdaCells), regime, n);
  let best = -Infinity, bi = 0;
  for (let i = 1; i < what.length; i++) if (what[i] > best) { best = what[i]; bi = i; }
  const mx = signedIndex(bi % n, n), my = signedIndex(Math.floor(bi / n), n);
  const k = (2 * Math.PI * Math.hypot(mx, my)) / n;
  return { k, lambda: (2 * Math.PI) / k, mx, my, wMax: best };
}

export const CLASS_NONE: Regime = { epsX: 0, epsY: 0, epsD: 0, diag: 1, alpha: 0 };

/** β_c = 4 / (A · max ŵ): the gain at which the uniform state u0 = 0 loses stability. */
export function criticalGain(lambdaCells: number, regime: Regime = CLASS_NONE, n = FIELD_N): number {
  return 4 / (KERNEL_A * predictWavenumber(lambdaCells, regime, n).wMax);
}

/** β / β_c as a function of visual intensity v (0–10) and absorptionGain (0–2, neutral 1). */
export function gainRatio(v: number, absorptionGain: number): number {
  const g = 0.5 + 0.5 * Math.min(2, Math.max(0, Number.isFinite(absorptionGain) ? absorptionGain : 1));
  return Math.min(GAIN_MAX, Math.max(0, GAIN_B0 + GAIN_B1 * Math.max(0, v) * g));
}

/** Visual intensity at which the uniform state loses stability (β = β_c). */
export function criticalIntensity(absorptionGain = 1): number {
  const g = 0.5 + 0.5 * Math.min(2, Math.max(0, absorptionGain));
  return (1 - GAIN_B0) / (GAIN_B1 * g);
}

// ------------------------------------------------------------------------------------------------
// pinning templates

export interface PinTerm { kx: number; ky: number; amp: number; phase: number }

/** Pin terms (wavevectors in radians per cell) for the class weights at time t. At most 6 terms. */
export function pinTerms(lambdaCells: number, w: Record<FcMode, number>, diag: 1 | -1, seed: number, n = FIELD_N): PinTerm[] {
  const m = Math.max(1, Math.round(n / lambdaCells));
  const md = Math.max(1, Math.round(n / (lambdaCells * Math.SQRT2)));
  const c = (2 * Math.PI) / n;
  const out: PinTerm[] = [];
  const ph = (k: number) => 2 * Math.PI * seededUniform(seed, k, 43);
  if (w.stripes_x > 0) out.push({ kx: m * c, ky: 0, amp: w.stripes_x, phase: ph(0) });
  if (w.stripes_y > 0) out.push({ kx: 0, ky: m * c, amp: w.stripes_y, phase: ph(1) });
  if (w.spirals > 0) out.push({ kx: md * c, ky: diag * md * c, amp: w.spirals, phase: ph(2) });
  if (w.hexagons > 0) {
    // resonant triad k1 + k2 + k3 = 0 on the lattice, |k_i| ≈ k*; phases summing to 0 → up-hexagons (spots)
    const a = Math.round(m / 2), b = Math.round((m * Math.sqrt(3)) / 2);
    const p1 = ph(3), p2 = ph(4);
    out.push({ kx: m * c, ky: 0, amp: w.hexagons / 1.5, phase: p1 });
    out.push({ kx: -a * c, ky: b * c, amp: w.hexagons / 1.5, phase: p2 });
    out.push({ kx: (a - m) * c, ky: -b * c, amp: w.hexagons / 1.5, phase: -p1 - p2 });
  }
  return out;
}

export function pinGate(ratio: number): number { return smooth(0.95, 1.15, ratio); }

export function pinInput(x: number, y: number, terms: PinTerm[], gate: number): number {
  if (gate <= 0) return 0;
  let s = 0;
  for (const t of terms) s += t.amp * Math.cos(t.kx * x + t.ky * y + t.phase);
  return PIN_AMP * gate * s;
}

// ------------------------------------------------------------------------------------------------
// spiral seeding schedule (field time, seconds)

export interface SpiralEvent { start: number; cx: number; cy: number; dir: 1 | -1 }

/** The k-th spiral seeding event: gaps of 20–40 s (seeded), centre and direction seeded. */
export function spiralEvent(seed: number, k: number): SpiralEvent {
  let start = 8 + seededUniform(seed, 0, 23) * 12;
  for (let i = 0; i < k; i++) start += SPIRAL.minGapS + (SPIRAL.maxGapS - SPIRAL.minGapS) * seededUniform(seed, i, 29);
  return {
    start,
    cx: seededUniform(seed, k, 31) * FIELD_N,
    cy: seededUniform(seed, k, 37) * FIELD_N,
    dir: seededUniform(seed, k, 41) < 0.5 ? 1 : -1,
  };
}

/** The spiral event active at time t (or null) and its envelope 0–1. */
export function activeSpiral(seed: number, t: number): { ev: SpiralEvent; env: number } | null {
  for (let k = 0; k < 1000; k++) {
    const ev = spiralEvent(seed, k);
    if (ev.start > t) return null;
    if (t < ev.start + SPIRAL.durS) {
      const s = Math.sin((Math.PI * (t - ev.start)) / SPIRAL.durS);
      return { ev, env: s * s };
    }
  }
  return null;
}

/** Spiral input at a cell (identical formula in fieldStep.frag.glsl). */
export function spiralInput(x: number, y: number, t: number, ev: SpiralEvent, env: number, k: number, n = FIELD_N): number {
  let dx = x - ev.cx, dy = y - ev.cy;
  dx -= n * Math.round(dx / n); dy -= n * Math.round(dy / n);
  const d = Math.hypot(dx, dy);
  const phi = Math.atan2(dy, dx);
  const R = SPIRAL.radius;
  return SPIRAL.amp * env * Math.exp(-(d * d) / (2 * R * R)) * Math.tanh(d / 3)
    * Math.cos(phi - ev.dir * 2 * Math.PI * SPIRAL.hz * t + k * d);
}

// ------------------------------------------------------------------------------------------------
// the simulation

/** Rate-limited approach of the gain ratio (identical in the GPU layer). */
export function approachRatio(cur: number, target: number, dt: number): number {
  if (target > cur) return Math.min(target, cur + GAIN_RATE_UP * dt);
  return Math.max(target, cur - GAIN_RATE_DOWN * dt);
}

/** Approximate class weights of an explicit regime (tests with a fixed regime). */
export function weightsFromRegime(r: Regime): Record<FcMode, number> {
  return {
    stripes_x: r.epsX / ANISO_EPS, stripes_y: r.epsY / ANISO_EPS, spirals: r.epsD / ANISO_EPS,
    hexagons: r.epsX + r.epsY + r.epsD === 0 && r.alpha > 0 ? 1 : 0,
  };
}

export function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

/** f(u) = S(βu) + α (S(β_c u) − ½)². */
export function firing(u: number, beta: number, betaC: number, alpha: number): number {
  const q = sigmoid(betaC * u) - 0.5;
  return sigmoid(beta * u) + alpha * q * q;
}

export function activity(u: number): number { return 0.5 + 0.5 * Math.tanh(u / U_REF); }

export interface SimOptions {
  n?: number;
  seed?: number;
  lambda?: number;
  /** trip-script form_constants spec; or set `regime` directly */
  spec?: FormConstantsSpec | null;
  regime?: Regime | null;
  /** target β / β_c (overrides v); the actual ratio approaches it at GAIN_RATE_UP/DOWN */
  gainRatio?: number;
  /** initial β / β_c (default 0) */
  startRatio?: number;
  v?: number;
  absorptionGain?: number;
  spirals?: boolean;
  noise?: number;
}

export class FieldSim {
  readonly n: number;
  readonly seed: number;
  readonly seedH: number;
  u: Float32Array;
  private F: Float32Array;
  private He: Float32Array;
  private Hi: Float32Array;
  kernel: Kernel;
  regime: Regime;
  pins: PinTerm[] = [];
  ratio: number;
  targetRatio: number;
  betaC: number;
  steps = 0;
  spec: FormConstantsSpec | null;
  spirals: boolean;
  noise: number;
  private fixedRegime: boolean;

  constructor(o: SimOptions = {}) {
    this.n = o.n ?? FIELD_N;
    this.seed = o.seed ?? 1;
    this.seedH = seedHash(this.seed);
    this.u = new Float32Array(this.n * this.n);
    this.F = new Float32Array(this.n * this.n);
    this.He = new Float32Array(this.n * this.n);
    this.Hi = new Float32Array(this.n * this.n);
    this.kernel = makeKernel(o.lambda ?? 12);
    this.spec = o.spec ?? null;
    this.fixedRegime = !!o.regime;
    this.regime = o.regime ?? regimeAt(this.spec, this.seed, 0);
    this.targetRatio = o.gainRatio ?? gainRatio(o.v ?? 6, o.absorptionGain ?? 1);
    this.ratio = o.startRatio ?? 0;
    this.betaC = criticalGain(this.kernel.lambda, this.regime, this.n);
    this.spirals = o.spirals ?? false;
    this.noise = o.noise ?? NOISE_SIGMA;
    // initial state: small seeded noise
    for (let i = 0; i < this.u.length; i++) this.u[i] = 0.01 * gaussNoise(i, 0xffffff, this.seedH);
  }

  get time(): number { return this.steps * DT; }

  step(count = 1): void {
    for (let s = 0; s < count; s++) this.stepOnce();
  }

  private stepOnce(): void {
    const n = this.n, N2 = n * n;
    const t = this.time;
    if (!this.fixedRegime) {
      this.regime = regimeAt(this.spec, this.seed, t);
      this.betaC = criticalGain(this.kernel.lambda, this.regime, this.n);
    }
    this.ratio = approachRatio(this.ratio, this.targetRatio, DT);
    const { ge, gi, gde, gdi, radius: R } = this.kernel;
    const reg = this.regime;
    if (!this.fixedRegime || this.pins.length === 0) {
      const w = this.fixedRegime ? weightsFromRegime(reg) : classWeights(this.spec, this.seed, t);
      this.pins = pinTerms(this.kernel.lambda, w, reg.diag, this.seed, this.n);
    }
    const gate = pinGate(this.ratio);
    const beta = this.ratio * this.betaC;
    const betaC = this.betaC;
    const u = this.u, F = this.F, He = this.He, Hi = this.Hi;
    for (let i = 0; i < N2; i++) F[i] = firing(u[i], beta, betaC, reg.alpha);
    // horizontal pass (along x)
    for (let y = 0; y < n; y++) {
      const row = y * n;
      for (let x = 0; x < n; x++) {
        let se = 0, si = 0;
        for (let j = -R; j <= R; j++) {
          const f = F[row + ((x + j + n) & (n - 1))];
          se += ge[j + R] * f; si += gi[j + R] * f;
        }
        He[row + x] = se; Hi[row + x] = si;
      }
    }
    const a = DT / TAU;
    const na = this.noise * Math.sqrt(a);
    const sp = this.spirals ? activeSpiral(this.seed, t) : null;
    const kStar = (K_SIGMA_E / this.kernel.sigmaE);
    const next = new Float32Array(N2);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let conv = 0;
        for (let j = -R; j <= R; j++) {
          const yy = ((y + j + n) & (n - 1)) * n + x;
          conv += ge[j + R] * He[yy] - gi[j + R] * Hi[yy];
        }
        if (reg.epsX > 0 || reg.epsY > 0 || reg.epsD > 0) {
          let lx = 0, ly = 0, ld = 0;
          for (let j = -R; j <= R; j++) {
            const wa = ge[j + R] - gi[j + R];
            const wd = gde[j + R] - gdi[j + R];
            const xx = (x + j + n) & (n - 1);
            const yy = (y + j + n) & (n - 1);
            const yd = (y + reg.diag * j + n) & (n - 1);
            lx += wa * F[y * n + xx];
            ly += wa * F[yy * n + x];
            ld += wd * F[yd * n + xx];
          }
          conv += reg.epsX * lx + reg.epsY * ly + reg.epsD * ld;
        }
        const i = y * n + x;
        let inp = KERNEL_A * conv;
        if (gate > 0) inp += pinInput(x, y, this.pins, gate);
        if (sp) inp += spiralInput(x, y, t, sp.ev, sp.env, kStar, n);
        next[i] = u[i] + a * (-u[i] + inp) + na * gaussNoise(i, this.steps, this.seedH);
      }
    }
    this.u = next;
    this.steps++;
  }
}

// ------------------------------------------------------------------------------------------------
// spectra (tests; tools/field_spectrum.py does the same in numpy)

function fft1(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * cr - ai * ci, ti = ar * ci + ai * cr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** 2-D power spectrum |FFT(u − mean)|², index ky * n + kx. n must be a power of two. */
export function powerSpectrum2D(u: ArrayLike<number>, n: number): Float64Array {
  let mean = 0;
  for (let i = 0; i < n * n; i++) mean += u[i];
  mean /= n * n;
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) re[i] = u[i] - mean;
  const rr = new Float64Array(n), ri = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { rr[x] = re[y * n + x]; ri[x] = im[y * n + x]; }
    fft1(rr, ri);
    for (let x = 0; x < n; x++) { re[y * n + x] = rr[x]; im[y * n + x] = ri[x]; }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rr[y] = re[y * n + x]; ri[y] = im[y * n + x]; }
    fft1(rr, ri);
    for (let y = 0; y < n; y++) { re[y * n + x] = rr[y]; im[y * n + x] = ri[y]; }
  }
  const p = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

export interface RadialSpectrum {
  /** mean power per integer |m| bin (bin b covers |m| in [b − ½, b + ½)), b = 0..n/2 */
  power: Float64Array;
  peakBin: number;
  /** |k| of the peak in radians per cell (power-weighted inside the peak bin ±1) */
  peakK: number;
  /** peak bin power / median bin power (bins 1..n/2) */
  peakToMedian: number;
}

export function radialSpectrum(p2: Float64Array, n: number): RadialSpectrum {
  const nb = n / 2 + 1;
  const sum = new Float64Array(nb), cnt = new Float64Array(nb);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(signedIndex(x, n), signedIndex(y, n));
      const b = Math.round(r);
      if (b < nb) { sum[b] += p2[y * n + x]; cnt[b]++; }
    }
  }
  const power = new Float64Array(nb);
  for (let b = 0; b < nb; b++) power[b] = cnt[b] ? sum[b] / cnt[b] : 0;
  let peakBin = 1;
  for (let b = 1; b < nb; b++) if (power[b] > power[peakBin]) peakBin = b;
  const sorted = Array.from(power.slice(1)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-30;
  // power-weighted |m| over the 2-D modes in bins peak±1
  let wsum = 0, msum = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(signedIndex(x, n), signedIndex(y, n));
      if (Math.abs(r - peakBin) <= 1.5) { wsum += p2[y * n + x]; msum += p2[y * n + x] * r; }
    }
  }
  const peakM = wsum > 0 ? msum / wsum : peakBin;
  return { power, peakBin, peakK: (2 * Math.PI * peakM) / n, peakToMedian: power[peakBin] / median };
}

/** Angular power distribution (mod π) of the modes within ±dk bins of |m| = ring, in `bins` bins. */
export function angularSpectrum(p2: Float64Array, n: number, ring: number, bins = 36, dk = 2): Float64Array {
  const out = new Float64Array(bins);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const mx = signedIndex(x, n), my = signedIndex(y, n);
      const r = Math.hypot(mx, my);
      if (r < 1 || Math.abs(r - ring) > dk) continue;
      let a = Math.atan2(my, mx);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      out[Math.min(bins - 1, Math.floor((a / Math.PI) * bins))] += p2[y * n + x];
    }
  }
  return out;
}

/** Dominant directions (mod 180°) of an angular spectrum: local maxima (circular) sorted by power. */
export function angularPeaks(ang: Float64Array): { deg: number; power: number }[] {
  const b = ang.length;
  // smooth with a 3-bin circular window so a direction split between two bins is one peak
  const s = new Float64Array(b);
  for (let i = 0; i < b; i++) s[i] = ang[(i - 1 + b) % b] * 0.5 + ang[i] + ang[(i + 1) % b] * 0.5;
  const peaks: { deg: number; power: number }[] = [];
  for (let i = 0; i < b; i++) {
    if (s[i] > s[(i - 1 + b) % b] && s[i] >= s[(i + 1) % b]) peaks.push({ deg: ((i + 0.5) * 180) / b, power: s[i] });
  }
  return peaks.sort((p, q) => q.power - p.power);
}
