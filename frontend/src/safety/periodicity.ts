// Periodicity score for the SafetyLimiter's large-area contrast guard (NOTES.md S8).
//
// BUILD.md §4.1 caps contrast only for PERIODIC patterns (stripes, rings, lattices, checkerboards) that
// cover more than 25% of the screen. The guard therefore counts and compresses a tile only when the
// luminance around it repeats. This file is the pure-TS reference of the GPU periodicity pass
// (limiterShaders.ts `periodicityFrag`, a literal port) and is what the unit tests pin.
//
// Per tile, luminance profiles are taken through the tile centre along 8 directions (every 22.5 degrees,
// so a pattern is never more than 11.25 degrees off a profile and its apparent period never more than 2%
// longer) at these scales (in units of the tile width, so the analysis is resolution independent):
//   - coarse: 128 samples, step 1/7 tile, each sample a 2-tap box over the step (window 18.3 tiles = 29%
//     of the screen width; periods from ~0.43 tile up to 4.6 tiles = W/14, i.e. 91 px at 1280 wide),
//   - fine:   128 samples, step 1/60 tile (window ~2 tiles; periods from ~1/30 tile up to ~0.5 tile),
//   - grid:   the 64x36 grid of exact-area tile means, step 1 tile, 32 samples along the 8 directions
//     (bilinear between tile centres; periods up to 8 tiles, also for curved rings) plus 48 samples
//     horizontally (straight stripes up to 12 tiles = W/5.3, i.e. more than 5 cycles across the screen).
// Each profile gets `periodicityScore`; the tile's score p is the maximum over all 25 profiles.
//
// periodicityScore (classic autocorrelation pitch detection, McLeod/Wyvill NSDF):
//   1. remove the least-squares linear trend (a pure gradient has no residual => p = 0); a residual with
//      rms below PERIODICITY_MIN_RMS scores 0 (too faint to matter, and it rejects the 8-bit quantisation
//      staircase of smooth gradients, rms 1/255/sqrt(12) = 0.0011, which is perfectly periodic);
//   2. normalised square-difference autocorrelation r(k) = 2 sum d_i d_(i+k) / sum (d_i^2 + d_(i+k)^2)
//      over the overlap, which is bounded in [-1, 1] and does not blow up when one side is flat;
//   3. find the first lag k0 where r drops below PERIODICITY_DROP (no drop within N/4 => p = 0: smooth
//      or ramp-like content);
//   4. for each local maximum k of r after k0 with k <= N/4 (at least 4 cycles in the window) that rises
//      above PERIODICITY_DROP again, the
//      candidate is min(r(k), max r(2k-1 .. 2k+1)): the pattern must also repeat a SECOND time (>= 3
//      cycles), which rejects pairs of bright features (two filaments, two blobs) whose single spacing
//      would otherwise correlate perfectly;
//   5. p = the largest candidate, clamped to [0, 1].
// A periodic pattern scores ~1; white noise, 1/f ("photo-like") profiles, blobs on black and a few
// bright filaments score well below 0.5 (frontend/tests/periodicity.test.ts).

/** Autocorrelation must first fall below this before a repeat peak counts (classic pitch detection). */
export const PERIODICITY_DROP = 0.3;
/** Profiles whose detrended rms is below this score 0. A pattern needs a peak-to-peak range > 0.05 to
 *  count for the guard at all (safetyLimiter.ts), i.e. rms >= 0.011 even for 5%-duty thin lines. */
export const PERIODICITY_MIN_RMS = 0.004;
/** Samples per pixel-scale profile (coarse and fine). */
export const PROFILE_N = 128;
/** Coarse profile step in tile widths (2-tap box filtered). */
export const COARSE_STEP_TILES = 1 / 7;
/** Fine profile step in tile widths (single bilinear tap). */
export const FINE_STEP_TILES = 1 / 60;
/** Tile-grid profile lengths, step 1 tile: the extra horizontal profile, and the 8-direction profiles. */
export const GRID_N_H = 48;
export const GRID_N = 32;
/** Number of profile directions (angles i * 180 / N_DIRS degrees). */
export const N_DIRS = 8;
/** Profile directions (unit vectors; pixel space for the pixel scales, tile space for the grid). */
export const DIRS: ReadonlyArray<readonly [number, number]> = Array.from({ length: N_DIRS }, (_, i) =>
  [Math.cos((i * Math.PI) / N_DIRS), Math.sin((i * Math.PI) / N_DIRS)] as const);

/** Stop searching once a repeat this strong is found (only values >= it are affected). */
export const PERIODICITY_EARLY_EXIT = 0.98;

/** Periodicity score p in [0, 1] of a luminance profile (see the header). Needs >= 8 samples.
 *  All lags 1 .. 2*floor(n/4)+1 are computed first (the GPU port is fully unrolled so the profile stays
 *  in registers); the overlap energy is 2E - head(k) - tail(k) with running head/tail sums of d^2. */
export function periodicityScore(profile: ArrayLike<number>): number {
  const n = profile.length;
  if (n < 8) return 0;
  const d = new Float64Array(n);
  const c0 = 0.5 * (n - 1);
  let s0 = 0; let s1 = 0;
  for (let i = 0; i < n; i++) { s0 += profile[i]; s1 += (i - c0) * profile[i]; }
  const a = s0 / n;
  const b = s1 / ((n * (n * n - 1)) / 12);
  let energy = 0;
  for (let i = 0; i < n; i++) { const v = profile[i] - a - b * (i - c0); d[i] = v; energy += v * v; }
  if (energy < n * PERIODICITY_MIN_RMS * PERIODICITY_MIN_RMS) return 0;   // flat, a pure gradient, too faint
  const kmax = Math.floor(n / 4);
  const K = 2 * kmax + 1;
  // NSDF r(k) = 2 sum_{i<n-k} d_i d_(i+k) / sum_{i<n-k} (d_i^2 + d_(i+k)^2)
  const r = new Float64Array(K + 1);
  r[0] = 1;
  let head = 0; let tail = 0;
  for (let k = 1; k <= K; k++) {
    head += d[k - 1] * d[k - 1]; tail += d[n - k] * d[n - k];
    let c = 0;
    for (let i = 0; i < n - k; i++) c += d[i] * d[i + k];
    const e = 2 * energy - head - tail;
    r[k] = e > 1e-12 ? (2 * c) / e : 0;
  }
  let dropped = false; let done = false; let best = 0;
  for (let k = 1; k <= kmax && !done; k++) {
    if (!dropped) {
      if (r[k] < PERIODICITY_DROP) dropped = true;      // k0: first decorrelation
    } else if (r[k] > r[k - 1] && r[k] >= r[k + 1] && r[k] > Math.max(best, PERIODICITY_DROP)) {
      best = Math.max(best, Math.min(r[k], Math.max(r[2 * k - 1], r[2 * k], r[2 * k + 1])));
      if (best >= PERIODICITY_EARLY_EXIT) done = true;
    }
  }
  return dropped ? Math.min(1, Math.max(0, best)) : 0;   // never decorrelates: smooth / ramp-like
}

/** Luminance lookup in pixel coordinates (x right, y along rows), e.g. a bilinear texture fetch. */
export type LumaFn = (x: number, y: number) => number;

function clampCentre(c: number, ext: number, size: number): number {
  const lo = ext; const hi = size - ext;
  return lo <= hi ? Math.min(hi, Math.max(lo, c)) : 0.5 * size;
}

/** Sample a profile of n points through (cx, cy) along unit direction (dx, dy) with `step` px between
 *  samples; taps = 2 averages two points at +-step/4 (box prefilter). The window is shifted to stay on
 *  screen (W x H px). Mirrors `sampleProfile` in the GLSL. */
export function sampleProfile(lum: LumaFn, W: number, H: number, cx: number, cy: number,
  dx: number, dy: number, step: number, n: number, taps: 1 | 2, out = new Float64Array(n)): Float64Array {
  const half = 0.5 * (n - 1) * step;
  const ccx = clampCentre(cx, Math.abs(dx) * half, W);
  const ccy = clampCentre(cy, Math.abs(dy) * half, H);
  for (let i = 0; i < n; i++) {
    const s = (i - 0.5 * (n - 1)) * step;
    if (taps === 1) out[i] = lum(ccx + s * dx, ccy + s * dy);
    else {
      const o = 0.25 * step;
      out[i] = 0.5 * (lum(ccx + (s - o) * dx, ccy + (s - o) * dy) + lum(ccx + (s + o) * dx, ccy + (s + o) * dy));
    }
  }
  return out;
}

/** Pixel-scale score (coarse + fine, 8 directions) of tile (tx, ty) on a W x H screen with `cols` columns. */
export function pixelPeriodicity(lum: LumaFn, W: number, H: number, tx: number, ty: number,
  cols = 64, rows = 36): number {
  const tw = W / cols;
  const cx = (tx + 0.5) * tw;
  const cy = (ty + 0.5) * (H / rows);
  const buf = new Float64Array(PROFILE_N);
  let p = 0;
  for (const [dx, dy] of DIRS) {
    p = Math.max(p, periodicityScore(sampleProfile(lum, W, H, cx, cy, dx, dy, COARSE_STEP_TILES * tw, PROFILE_N, 2, buf)));
    p = Math.max(p, periodicityScore(sampleProfile(lum, W, H, cx, cy, dx, dy, FINE_STEP_TILES * tw, PROFILE_N, 1, buf)));
  }
  return p;
}

/** Tile-grid score of tile (tx, ty) from the tile means (`tileMean(col, row)`, integer indices):
 *  one horizontal profile of GRID_N_H tile centres, and GRID_N-sample profiles along the 8 directions
 *  with bilinear interpolation between tile centres (clamped at the edges, like texture sampling). */
export function gridPeriodicity(tileMean: (col: number, row: number) => number, tx: number, ty: number,
  cols = 64, rows = 36): number {
  const at = (c: number, r: number): number => tileMean(Math.min(cols - 1, Math.max(0, c)), Math.min(rows - 1, Math.max(0, r)));
  const bilinear = (x: number, y: number): number => {   // x, y in tile-centre coordinates (centres at +0.5)
    const u = x - 0.5; const v = y - 0.5;
    const i = Math.floor(u); const j = Math.floor(v);
    const fx = u - i; const fy = v - j;
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
  };
  // horizontal, GRID_N_H tile centres
  const hh = 0.5 * (GRID_N_H - 1);
  const hx = clampCentre(tx + 0.5, hh + 0.5, cols);
  const hprof = new Float64Array(GRID_N_H);
  for (let i = 0; i < GRID_N_H; i++) hprof[i] = at(Math.floor(hx + (i - hh)), ty);
  let p = periodicityScore(hprof);
  // 8 directions, GRID_N samples
  const h = 0.5 * (GRID_N - 1);
  const prof = new Float64Array(GRID_N);
  for (const [dx, dy] of DIRS) {
    const cx = clampCentre(tx + 0.5, Math.abs(dx) * h + 0.5, cols);
    const cy = clampCentre(ty + 0.5, Math.abs(dy) * h + 0.5, rows);
    for (let i = 0; i < GRID_N; i++) prof[i] = bilinear(cx + (i - h) * dx, cy + (i - h) * dy);
    p = Math.max(p, periodicityScore(prof));
  }
  return p;
}

/** 3x3 dilation of the periodic tiles (p >= threshold) on a cols x rows grid (row-major). Tiles next to a
 *  periodic tile are guarded too, so pattern borders, where the analysis window straddles the edge of
 *  the pattern, are counted and compressed. Returns the number of tiles with p >= threshold. */
export function dilatePeriodic(p: ArrayLike<number>, cols: number, rows: number, threshold: number,
  out: Uint8Array): number {
  out.fill(0);
  let raw = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (p[r * cols + c] < threshold) continue;
      raw++;
      for (let j = Math.max(0, r - 1); j <= Math.min(rows - 1, r + 1); j++) {
        for (let i = Math.max(0, c - 1); i <= Math.min(cols - 1, c + 1); i++) out[j * cols + i] = 1;
      }
    }
  }
  return raw;
}

/** Full per-tile score of the GPU pass: max of the pixel scales and the tile-mean grid scale. */
export function tilePeriodicity(lum: LumaFn, tileMean: (col: number, row: number) => number, W: number, H: number,
  tx: number, ty: number, cols = 64, rows = 36): number {
  return Math.max(pixelPeriodicity(lum, W, H, tx, ty, cols, rows), gridPeriodicity(tileMean, tx, ty, cols, rows));
}

/** Fill the holes of a tile mask: every 0-tile that cannot reach the screen border through 0-tiles
 *  (4-connected) is set to 1, in place. Used for the guard's COMPRESSION mask only: where a periodic
 *  pattern encloses tiles that the analysis missed (e.g. the converging centre of a radial sunburst,
 *  whose period changes too fast for any profile), those tiles are compressed too while the guard is on.
 *  Returns the number of tiles filled. */
export function fillEnclosed(mask: Uint8Array, cols: number, rows: number,
  scratch: Int32Array = new Int32Array(cols * rows)): number {
  const n = cols * rows;
  const seen = new Uint8Array(n);
  let head = 0; let tail = 0;
  const push = (i: number): void => { if (!mask[i] && !seen[i]) { seen[i] = 1; scratch[tail++] = i; } };
  for (let c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
  while (head < tail) {
    const i = scratch[head++]; const r = Math.floor(i / cols); const c = i - r * cols;
    if (c > 0) push(i - 1);
    if (c < cols - 1) push(i + 1);
    if (r > 0) push(i - cols);
    if (r < rows - 1) push(i + cols);
  }
  let filled = 0;
  for (let i = 0; i < n; i++) if (!mask[i] && !seen[i]) { mask[i] = 1; filled++; }
  return filled;
}

// ---------------------------------------------------------------------------------------------------
// S8b: STRIPE detection (oriented, repeated high-contrast swings) for patterns whose period is not
// constant, which the autocorrelation score above cannot see: zone plates and other chirps, FM bar
// trains, perspective floors, rings in hyperbolic (Poincare) distance, and irregular bar codes. All of
// them are, locally, stripes: the luminance swings over (almost) its full range again and again across
// one direction and hardly changes along the other. A tile is a STRIPE tile when
//   1. orientation: the gradient structure tensor summed over its 3x3-tile neighbourhood (luminance at
//      8x8 texels per tile, central differences) has coherence >= STRIPE_COHERENCE_MIN; its dominant
//      gradient direction (across the stripes) picks the nearest of the 8 profile directions, and
//   2. repetition: along that direction, the coarse profile (128 samples, 18.3 tiles) has at least
//      STRIPE_MIN_TRANSITIONS full swings (hysteresis transitions of at least STRIPE_SWING x the
//      profile's own range: >= 4 light-dark pairs), and its central STRIPE_CENTRAL_N samples (9.1 tiles)
//      at least STRIPE_CENTRAL_MIN (5 swings, i.e. periods up to ~3.6 tiles right at the tile, measured
//      against that window's range; the sub-window is centred on the tile's own position, which near the
//      screen edges is not the middle of the shifted profile).
// Large patterns (periods of 5-10 tiles) are caught on the tile-mean grid with the screen-wide rule of
// ITU-R BT.1702 / Ofcom ("more than five light-dark pairs"): the tile's 5x5-tile grid tensor is coherent,
// its central GRID_CENTRAL_N grid samples along the dominant direction swing at least GRID_CENTRAL_MIN
// times, and the full row (64 tile means) or full column (36) has >= GLOBAL_MIN_TRANSITIONS swings.
// Requiring full-range swings (not just any wiggle) and a coherent orientation keeps photos, noise,
// blooms, star fields and isolated filaments out (frontend/tests/periodicity.test.ts, NOTES.md S8b).

/** A transition is a swing of at least this fraction of the profile's range (hysteresis). */
export const STRIPE_SWING = 0.8;
/** ...and never less than this absolute luminance (flat or nearly flat profiles never swing). */
export const STRIPE_SWING_MIN = 0.01;
/** Coarse profile: minimum transitions over the whole 128-sample window (4 light-dark pairs). */
export const STRIPE_MIN_TRANSITIONS = 8;
/** Coarse profile: central sub-window length and its minimum transitions (5 swings: periods up to ~73 px
 *  at 1280 wide; 6 lost the middle rings of 30%-area zone plates, NOTES.md S8b). */
export const STRIPE_CENTRAL_N = 64;
export const STRIPE_CENTRAL_MIN = 5;
/** Structure-tensor coherence (0 = isotropic, 1 = perfectly oriented) a stripe tile needs. */
export const STRIPE_COHERENCE_MIN = 0.6;
/** Grid scale: central window (tile means) along the dominant direction, minimum transitions. */
export const GRID_CENTRAL_N = 12;
export const GRID_CENTRAL_MIN = 2;
/** Grid scale: a full row or column of tile means needs more than 5 light-dark pairs. */
export const GLOBAL_MIN_TRANSITIONS = 10;

/** Number of hysteresis transitions in profile[from, to): successive swings of at least
 *  max(STRIPE_SWING * range, STRIPE_SWING_MIN), range = max - min over the same window. Successive
 *  transitions always alternate in direction (like the flash detector's extremum tracker). */
export function countTransitions(profile: ArrayLike<number>, from = 0, to = profile.length): number {
  if (to - from < 2) return 0;
  let mn = Infinity; let mx = -Infinity;
  for (let i = from; i < to; i++) { mn = Math.min(mn, profile[i]); mx = Math.max(mx, profile[i]); }
  const h = Math.max(STRIPE_SWING * (mx - mn), STRIPE_SWING_MIN);
  let hi = profile[from]; let lo = profile[from]; let st = 0; let n = 0;
  for (let i = from + 1; i < to; i++) {
    const v = profile[i];
    hi = Math.max(hi, v); lo = Math.min(lo, v);
    const up = st <= 0 && v - lo >= h;
    const dn = st >= 0 && hi - v >= h;
    if (up || dn) { n++; st = up ? 1 : -1; hi = v; lo = v; }
  }
  return n;
}

/** Start of the `central`-sample window centred on sample position `at` (the tile centre's position in
 *  the profile, which is not the profile's middle when the window was shifted to stay on screen),
 *  clamped to the profile. */
export function centralStart(n: number, central: number, at: number): number {
  return Math.min(n - central, Math.max(0, Math.floor(at + 0.5) - Math.floor(central / 2)));
}

/** Transitions over the whole profile and over the `central` samples around position `at`
 *  (default: the profile's middle). */
export function stripeTransitions(profile: ArrayLike<number>, central: number, at = 0.5 * (profile.length - 1)):
  [number, number] {
  const n = profile.length; const c0 = centralStart(n, central, at);
  return [countTransitions(profile, 0, n), countTransitions(profile, c0, c0 + central)];
}

/** Position of the point (px, py) in a profile of n samples through (ccx, ccy) along unit (dx, dy) with
 *  `step` between samples (sample i at ccx + (i - (n-1)/2) * step * dx, ...). */
export function profilePosition(n: number, ccx: number, ccy: number, dx: number, dy: number, step: number,
  px: number, py: number): number {
  return 0.5 * (n - 1) + ((px - ccx) * dx + (py - ccy) * dy) / step;
}

/** Structure tensor [Jxx, Jyy, Jxy] -> coherence in [0, 1] and the index (0..N_DIRS-1) of the profile
 *  direction nearest to the dominant gradient direction (across the stripes). */
export function tensorOrientation(jxx: number, jyy: number, jxy: number): { coherence: number; dir: number } {
  const tr = jxx + jyy;
  const coherence = tr > 1e-9 ? Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / tr : 0;
  const phi = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
  const dir = ((Math.round(phi / (Math.PI / N_DIRS)) % N_DIRS) + N_DIRS) % N_DIRS;
  return { coherence, dir };
}

/** Gradient structure tensor of a sampled luminance grid g(i, j) (i < w, j < h, clamped central
 *  differences) summed over texels [i0, i1) x [j0, j1). Mirrors TENSOR_FRAG + the reduce pass's sums. */
export function structureTensor(g: (i: number, j: number) => number, w: number, h: number,
  i0: number, i1: number, j0: number, j1: number): [number, number, number] {
  const at = (i: number, j: number): number => g(Math.min(w - 1, Math.max(0, i)), Math.min(h - 1, Math.max(0, j)));
  let xx = 0; let yy = 0; let xy = 0;
  for (let j = Math.max(0, j0); j < Math.min(h, j1); j++) {
    for (let i = Math.max(0, i0); i < Math.min(w, i1); i++) {
      const gx = 0.5 * (at(i + 1, j) - at(i - 1, j)); const gy = 0.5 * (at(i, j + 1) - at(i, j - 1));
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
  }
  return [xx, yy, xy];
}

/** Stripe test of tile (tx, ty) at pixel scale (rule 1 + 2 of the header). `level0(i, j)` is the
 *  box-filtered luminance at 8x8 texels per tile ((cols*8) x (rows*8), j along rows like `lum`'s y). */
export function pixelStripe(lum: LumaFn, level0: (i: number, j: number) => number, W: number, H: number,
  tx: number, ty: number, cols = 64, rows = 36): boolean {
  // 3x3-tile neighbourhood, clamped to the grid (as texelFetch of mip level 3 with clamped tile indices)
  let xx = 0; let yy = 0; let xy = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const c = Math.min(cols - 1, Math.max(0, tx + di)); const r = Math.min(rows - 1, Math.max(0, ty + dj));
      const [a, b, d] = structureTensor(level0, cols * 8, rows * 8, c * 8, c * 8 + 8, r * 8, r * 8 + 8);
      xx += a; yy += b; xy += d;
    }
  }
  const { coherence, dir } = tensorOrientation(xx, yy, xy);
  if (coherence < STRIPE_COHERENCE_MIN) return false;
  const tw = W / cols;
  const [dx, dy] = DIRS[dir];
  const cx = (tx + 0.5) * tw; const cy = (ty + 0.5) * (H / rows); const step = COARSE_STEP_TILES * tw;
  const prof = sampleProfile(lum, W, H, cx, cy, dx, dy, step, PROFILE_N, 2);
  const half = 0.5 * (PROFILE_N - 1) * step;
  const at = profilePosition(PROFILE_N, clampCentre(cx, Math.abs(dx) * half, W), clampCentre(cy, Math.abs(dy) * half, H),
    dx, dy, step, cx, cy);
  const [all, mid] = stripeTransitions(prof, STRIPE_CENTRAL_N, at);
  return all >= STRIPE_MIN_TRANSITIONS && mid >= STRIPE_CENTRAL_MIN;
}

/** Stripe test of tile (tx, ty) on the tile-mean grid (the screen-wide "more than five pairs" rule). */
export function gridStripe(tileMean: (col: number, row: number) => number, tx: number, ty: number,
  cols = 64, rows = 36): boolean {
  const at = (c: number, r: number): number => tileMean(Math.min(cols - 1, Math.max(0, c)), Math.min(rows - 1, Math.max(0, r)));
  let xx = 0; let yy = 0; let xy = 0;
  for (let r = ty - 2; r <= ty + 2; r++) {
    for (let c = tx - 2; c <= tx + 2; c++) {
      const cc = Math.min(cols - 1, Math.max(0, c)); const rr = Math.min(rows - 1, Math.max(0, r));
      const gx = 0.5 * (at(cc + 1, rr) - at(cc - 1, rr)); const gy = 0.5 * (at(cc, rr + 1) - at(cc, rr - 1));
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
  }
  const { coherence, dir } = tensorOrientation(xx, yy, xy);
  if (coherence < STRIPE_COHERENCE_MIN) return false;
  const row = new Float64Array(cols); for (let c = 0; c < cols; c++) row[c] = at(c, ty);
  const col = new Float64Array(rows); for (let r = 0; r < rows; r++) col[r] = at(tx, r);
  if (Math.max(countTransitions(row), countTransitions(col)) < GLOBAL_MIN_TRANSITIONS) return false;
  const prof = gridProfile(at, tx, ty, dir, GRID_N, cols, rows);
  const [dx, dy] = DIRS[dir]; const h = 0.5 * (GRID_N - 1);
  const pos = profilePosition(GRID_N, clampCentre(tx + 0.5, Math.abs(dx) * h + 0.5, cols),
    clampCentre(ty + 0.5, Math.abs(dy) * h + 0.5, rows), dx, dy, 1, tx + 0.5, ty + 0.5);
  return stripeTransitions(prof, GRID_CENTRAL_N, pos)[1] >= GRID_CENTRAL_MIN;
}

/** GRID_N-sample tile-mean profile through tile (tx, ty) along direction `dir`, bilinear between tile
 *  centres, centre clamped so the window stays on the grid (as in gridPeriodicity / the GLSL). */
export function gridProfile(at: (c: number, r: number) => number, tx: number, ty: number, dir: number, n: number,
  cols = 64, rows = 36): Float64Array {
  const bilinear = (x: number, y: number): number => {
    const u = x - 0.5; const v = y - 0.5;
    const i = Math.floor(u); const j = Math.floor(v);
    const fx = u - i; const fy = v - j;
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
  };
  const [dx, dy] = DIRS[dir];
  const h = 0.5 * (n - 1);
  const cx = clampCentre(tx + 0.5, Math.abs(dx) * h + 0.5, cols);
  const cy = clampCentre(ty + 0.5, Math.abs(dy) * h + 0.5, rows);
  const prof = new Float64Array(n);
  for (let i = 0; i < n; i++) prof[i] = bilinear(cx + (i - h) * dx, cy + (i - h) * dy);
  return prof;
}

/** Square dilation of a 0/1 tile mask by `radius` tiles (radius 1 = 3x3, 2 = 5x5), into `out`. */
export function dilateMask(mask: ArrayLike<number>, cols: number, rows: number, radius: number, out: Uint8Array): void {
  out.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      for (let j = Math.max(0, r - radius); j <= Math.min(rows - 1, r + radius); j++) {
        for (let i = Math.max(0, c - radius); i <= Math.min(cols - 1, c + radius); i++) out[j * cols + i] = 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// S8c: LOCAL SPECTRUM test, for 2-D lattices and crossed chirps (NOTES.md S8c). Two or three crossing
// families of stripes (an egg-crate, a plaid, a hexagonal dot lattice), each chirped and warped
// (crossed zone plates, conformal z^2 and log-polar lattices), defeat both tests above: the structure
// tensor is incoherent (no single orientation) and every 1-D profile is a sum of chirps (no repeat). What
// they still have, like any pattern flashcheck flags, is a SPARSE local spectrum: almost all of the
// luminance variance of a block sits in a few sharp spectral peaks. flashcheck.py calls a block periodic
// when its strongest peak (3x3 bins, plus its mirror) holds >= 30 % of the AC energy; that alone also
// flags ~35 % of the windows of a natural photo (bookshelves, curtains, foliage), so the guard uses the
// energy of the THREE strongest peaks instead, which a lattice of up to three families concentrates
// (egg-crate, hex: >= 0.9) and a photo does not (median 0.4).
// Windows: SPECTRAL_N x SPECTRAL_N texels of the box-filtered luminance at pyramid level 0 (8 texels per
// tile: a 4-tile window, periods ~2.5-27 px at 1280 wide) and level 1 (4 texels per tile: an 8-tile
// window = flashcheck's block size, periods ~10-53 px), centred every SPECTRAL_STRIDE tiles on tile
// corners (shifted to stay on screen), so each 2x2 group of tiles has its own window at each level.
// Per window: subtract the mean, apply a separable Hann window, 2-D DFT, power P (the GPU keeps it in 32-bit
// float targets; the decision is a ratio, so no normalisation is needed). total = sum(P) - P(0); peaks greedily: the strongest bin at radius >= SPECTRAL_MIN_CYCLES not
// yet used, its 3x3 neighbourhood and the mirror's (bins of earlier peaks excluded); top3 = the energy of
// the first three peaks / total. A tile is SPECTRAL when top3 >= SPECTRAL_TOP3_MIN at either level.

/** DFT window size (texels) of the local-spectrum test. */
export const SPECTRAL_N = 32;
/** Tiles between window centres (each window owns the 2x2 tiles around its centre). */
export const SPECTRAL_STRIDE = 2;
/** Pyramid levels analysed and their texels per tile (window = SPECTRAL_N / texels tiles: 4 and 8). */
export const SPECTRAL_LEVELS: ReadonlyArray<number> = [0, 1];
/** Peaks below this radius (cycles per window) are not candidates (flashcheck's PATTERN_MIN_CYCLES). */
export const SPECTRAL_MIN_CYCLES = 3;
/** Number of peaks whose energy is summed. */
export const SPECTRAL_PEAKS = 3;
/** A window is a pattern when its SPECTRAL_PEAKS strongest peaks hold at least this fraction of its
 *  AC energy. Measured (NOTES.md S8c): every adversarial lattice / chirp / plaid >= 0.9 over its area
 *  (the noisiest, a zone plate with +-0.2 grain in 5-px cells, 0.88); the sample photo's windows 6 %
 *  above 0.75 (top crop; the guard counts 0.135 of tiles there with the S8/S8b tiles, centre crop 0.161). */
export const SPECTRAL_TOP3_MIN = 0.75;
/** Windows whose Hann-weighted rms (sqrt(sum x^2 / N^2), x = (luminance - mean) * w(x) * w(y)) is below this
 *  are flat (top3 = 0); about a luminance standard deviation of 2.7e-4. */
export const SPECTRAL_MIN_RMS = 1e-4;

/** Hann weight of sample i (0..n-1), symmetric, no zero end points. */
export function spectralHann(i: number, n = SPECTRAL_N): number {
  const s = Math.sin((Math.PI * (i + 0.5)) / n);
  return s * s;
}

/** Window origin (in tiles, along one axis of `tiles` tiles) of window index w (0 .. tiles/STRIDE-1) for a
 *  window of `wt` tiles: centred on the tile corner STRIDE*w + 1, shifted to stay on the grid. */
export function spectralOrigin(w: number, wt: number, tiles: number): number {
  return Math.min(tiles - wt, Math.max(0, SPECTRAL_STRIDE * w + 1 - wt / 2));
}

/** Local-spectrum features of an n x n luminance block (row-major, block[y * n + x]): the energy
 *  fraction of each of the `peaks` strongest peaks (greedy, see the header) and their radii (cycles per
 *  window). The GPU port (limiterShaders.ts SPEC_*_FRAG) evaluates the same sums on the half plane. */
export function spectralPeaks(block: ArrayLike<number>, n = SPECTRAL_N, peaks = SPECTRAL_PEAKS):
  { fractions: number[]; radii: number[]; total: number } {
  const N2 = n * n;
  let mean = 0;
  for (let i = 0; i < N2; i++) mean += block[i];
  mean /= N2;
  const fractions = new Array<number>(peaks).fill(0); const radii = new Array<number>(peaks).fill(0);
  // rows: x -> kx (full plane, unnormalised), then columns
  const cs = new Float64Array(n); const sn = new Float64Array(n);
  for (let i = 0; i < n; i++) { cs[i] = Math.cos((2 * Math.PI * i) / n); sn[i] = Math.sin((2 * Math.PI * i) / n); }
  const x = new Float64Array(N2);
  for (let yy = 0; yy < n; yy++) {
    for (let xx = 0; xx < n; xx++) x[yy * n + xx] = (block[yy * n + xx] - mean) * spectralHann(xx, n) * spectralHann(yy, n);
  }
  let x2 = 0;
  for (let i = 0; i < N2; i++) x2 += x[i] * x[i];
  if (Math.sqrt(x2 / N2) < SPECTRAL_MIN_RMS) return { fractions, radii, total: 0 };
  const rr = new Float64Array(N2); const ri = new Float64Array(N2);
  for (let yy = 0; yy < n; yy++) {
    for (let k = 0; k < n; k++) {
      let a = 0; let b = 0;
      for (let xx = 0; xx < n; xx++) { const ph = (k * xx) % n; a += x[yy * n + xx] * cs[ph]; b -= x[yy * n + xx] * sn[ph]; }
      rr[yy * n + k] = a; ri[yy * n + k] = b;
    }
  }
  const P = new Float64Array(N2);   // P[ky * n + kx]
  for (let kx = 0; kx < n; kx++) {
    for (let ky = 0; ky < n; ky++) {
      let a = 0; let b = 0;
      for (let yy = 0; yy < n; yy++) {
        const ph = (ky * yy) % n; const c = cs[ph]; const s = sn[ph];
        const pr = rr[yy * n + kx]; const pi = ri[yy * n + kx];
        a += pr * c + pi * s; b += pi * c - pr * s;
      }
      P[ky * n + kx] = a * a + b * b;
    }
  }
  let total = -P[0];
  for (let i = 0; i < N2; i++) total += P[i];
  if (!(total > 0)) return { fractions, radii, total: 0 };
  const sgn = (k: number): number => (k > n / 2 ? k - n : k);
  const wrapD = (a: number, b: number): number => { const d = (((a - b) % n) + n) % n; return Math.min(d, n - d); };
  const near = (ky: number, kx: number, py: number, px: number): boolean =>
    (wrapD(ky, py) <= 1 && wrapD(kx, px) <= 1) || (wrapD(ky, -py) <= 1 && wrapD(kx, -px) <= 1);
  const chosen: Array<[number, number]> = [];
  for (let q = 0; q < peaks; q++) {
    // candidates in the order of the GPU loop: ky 0..n-1 outer, kx 0..n/2 inner (half plane)
    let best = -1; let by = 0; let bx = 0;
    for (let ky = 0; ky < n; ky++) {
      for (let kx = 0; kx <= n / 2; kx++) {
        const sy = sgn(ky); const r2 = kx * kx + sy * sy;
        if (r2 < SPECTRAL_MIN_CYCLES * SPECTRAL_MIN_CYCLES) continue;
        if (chosen.some(([py, px]) => near(ky, kx, py, px))) continue;
        const p = P[ky * n + kx];
        if (p > best) { best = p; by = ky; bx = kx; }
      }
    }
    if (best < 0) break;
    let e = 0;
    for (let ky = 0; ky < n; ky++) {
      for (let kx = 0; kx < n; kx++) {
        if (!near(ky, kx, by, bx)) continue;
        if (chosen.some(([py, px]) => near(ky, kx, py, px))) continue;
        e += P[ky * n + kx];
      }
    }
    chosen.push([by, bx]);
    fractions[q] = e / total; radii[q] = Math.hypot(bx, sgn(by));
  }
  return { fractions, radii, total };
}

/** Top-SPECTRAL_PEAKS energy fraction of a block (the S8c decision value). */
export function spectralTop3(block: ArrayLike<number>, n = SPECTRAL_N): number {
  return spectralPeaks(block, n).fractions.reduce((a, b) => a + b, 0);
}
