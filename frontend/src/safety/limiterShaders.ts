// GLSL for the SafetyLimiter passes. Threshold constants come from thresholds.ts only; the periodicity
// analysis constants from periodicity.ts (its pure-TS reference).
import {
  GUARD_TARGET_CONTRAST, LUMA_WEIGHTS, RED_MIN_R, RED_SAT, TILE_GRID,
} from './thresholds';
import {
  COARSE_STEP_TILES, FINE_STEP_TILES, GLOBAL_MIN_TRANSITIONS, GRID_CENTRAL_MIN, GRID_CENTRAL_N, GRID_N, GRID_N_H,
  N_DIRS, PERIODICITY_DROP, PERIODICITY_EARLY_EXIT, PERIODICITY_MIN_RMS, PROFILE_N, STRIPE_CENTRAL_MIN,
  SPECTRAL_LEVELS, SPECTRAL_MIN_CYCLES, SPECTRAL_MIN_RMS, SPECTRAL_N, SPECTRAL_PEAKS, SPECTRAL_STRIDE,
  SPECTRAL_TOP3_MIN, STRIPE_CENTRAL_N, STRIPE_COHERENCE_MIN, STRIPE_MIN_TRANSITIONS, STRIPE_SWING, STRIPE_SWING_MIN,
  spectralHann,
} from './periodicity';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const LUMA = `
float luma(vec3 c) { return dot(c, vec3(${f(LUMA_WEIGHTS[0])}, ${f(LUMA_WEIGHTS[1])}, ${f(LUMA_WEIGHTS[2])})); }
`;

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Box-filtered luminance at 8x8 texels per tile ((64 * 8) x (36 * 8)), each texel the mean of 4x4
 *  bilinear taps over its footprint. Its mip level 3 (64 x 36) holds exact-area tile means: the guard's
 *  neighbourhood mean and the periodicity grid scale use it, because point-sampled means alias with fine
 *  periodic patterns (the guard then compressed neighbouring tiles toward different means and a 45-degree
 *  12-px stripe pattern kept a block contrast of 0.54 after compression; NOTES.md S8). */
export const LUMA_DOWN_FRAG = /* glsl */ `
uniform sampler2D uInput;
varying vec2 vUv;
${LUMA}
void main() {
  vec2 size = vec2(${f(TILE_GRID[0] * 8)}, ${f(TILE_GRID[1] * 8)});
  vec2 cell = floor(gl_FragCoord.xy);
  float s = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      s += luma(clamp(texture2D(uInput, (cell + (vec2(float(i), float(j)) + 0.5) / 4.0) / size).rgb, 0.0, 1.0));
    }
  }
  gl_FragColor = vec4(s / 16.0, 0.0, 0.0, 1.0);
}
`;

/** Tile analysis. MODE 0 writes (meanY, redFraction, probeY1, probeY2); MODE 1 writes
 *  (minY, maxY, contrastFactor, meanY). Input is LINEAR RGB; 4x4 jittered samples per tile. */
export function tileFrag(mode: 0 | 1): string {
  return /* glsl */ `
#define MODE ${mode}
uniform sampler2D uInput;
#if MODE == 1
uniform sampler2D uLum;   // LUMA_DOWN_FRAG target; mip level 3 = exact tile means
#endif
varying vec2 vUv;
${LUMA}
void main() {
  vec2 grid = vec2(${f(TILE_GRID[0])}, ${f(TILE_GRID[1])});
  vec2 tile = floor(gl_FragCoord.xy);
  float sumY = 0.0; float redN = 0.0; float mn = 1.0; float mx = 0.0; float p1 = 0.0; float p2 = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 ij = vec2(float(i), float(j));
      vec2 jit = vec2(fract(float(i * 7 + j * 3) * 0.371), fract(float(i * 5 + j * 11) * 0.537)) * 0.5 - 0.25;
      vec2 uv = (tile + (ij + 0.5 + jit) / 4.0) / grid;
      vec3 c = clamp(texture2D(uInput, uv).rgb, 0.0, 1.0);
      float y = luma(c);
      sumY += y; mn = min(mn, y); mx = max(mx, y);
      float s = c.r + c.g + c.b;
      if (s > 1e-4 && c.r / s >= ${f(RED_SAT)} && c.r > ${f(RED_MIN_R)}) redN += 1.0;
      if (i == 0 && j == 0) p1 = y;
      if (i == 3 && j == 2) p2 = y;
    }
  }
  float m = sumY / 16.0;
#if MODE == 0
  gl_FragColor = vec4(m, redN / 16.0, p1, p2);
#else
  // Pattern guard statistics over a 5x5-tile neighbourhood (min/max of 8x8 jittered samples plus the
  // tile's own 16 samples, so that periodic structure larger than one tile is still seen as contrast) and
  // the EXACT-AREA mean of those 25 tiles (uLum level 3), so adjacent tiles compress toward the same mean.
  vec2 origin = clamp(tile - 2.0, vec2(0.0), grid - 5.0);  // keep the footprint inside the screen
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      vec2 ij = vec2(float(i), float(j));
      vec2 jit = vec2(fract(float(i * 13 + j * 7) * 0.618), fract(float(i * 3 + j * 17) * 0.414)) - 0.5;
      vec2 uv = (origin + (ij + 0.5 + jit * 0.8) * (5.0 / 8.0)) / grid;
      float y = luma(clamp(texture2D(uInput, uv).rgb, 0.0, 1.0));
      mn = min(mn, y); mx = max(mx, y);
    }
  }
  float nSum = 0.0;
  for (int j = 0; j < 5; j++) {
    for (int i = 0; i < 5; i++) nSum += texelFetch(uLum, ivec2(origin) + ivec2(i, j), 3).r;
  }
  m = nSum / 25.0;
  mn = min(mn, m); mx = max(mx, m);
  // Contrast factor cf so that compressing toward the neighbourhood mean (y' = m + (y - m) * cf)
  // brings the Michelson contrast to at most GUARD_TARGET_CONTRAST.
  float T = ${f(GUARD_TARGET_CONTRAST)};
  float cf = 1.0;
  float mich = (mx - mn) / max(mx + mn, 1e-4);
  if (mich > T) {
    float den = (mx - mn) - T * (mx + mn) + 2.0 * m * T;
    if (den > 1e-5) cf = clamp(2.0 * m * T / den, 0.0, 1.0);
  }
  gl_FragColor = vec4(mn, mx, cf, m);
#endif
}
`;
}

/** GLSL for periodicityScore() of periodicity.ts on gP[0..n), FULLY UNROLLED (generated): every array
 *  index is a constant, so the profile and the lag correlations stay in registers. The loop version was
 *  latency-bound on local memory (1-2 ms for the pass); this is the same arithmetic in the same order. */
function genScore(n: number): string {
  const kmax = Math.floor(n / 4);
  const K = 2 * kmax + 1;
  const c0 = 0.5 * (n - 1);
  const L: string[] = [];
  const terms = (fn: (i: number) => string, count: number): string => {
    const t: string[] = [];
    for (let i = 0; i < count; i++) t.push(fn(i));
    return t.join(' + ');
  };
  L.push(`float score${n}() {`);
  L.push(`  float s0 = ${terms((i) => `gP[${i}]`, n)};`);
  L.push(`  float s1 = ${terms((i) => `${f(i - c0)} * gP[${i}]`, n)};`);
  L.push(`  float a = s0 / ${f(n)};`);
  L.push(`  float b = s1 / ${f((n * (n * n - 1)) / 12)};`);
  for (let i = 0; i < n; i++) L.push(`  gP[${i}] = gP[${i}] - a - b * ${f(i - c0)};`);
  L.push(`  float energy = ${terms((i) => `gP[${i}] * gP[${i}]`, n)};`);
  L.push(`  if (energy < ${f(n * PERIODICITY_MIN_RMS * PERIODICITY_MIN_RMS)}) return 0.0;`);
  L.push(`  float r[${K + 1}];`);
  L.push('  r[0] = 1.0;');
  L.push('  float head = 0.0; float tail = 0.0; float c; float e;');
  for (let k = 1; k <= K; k++) {
    L.push(`  head += gP[${k - 1}] * gP[${k - 1}]; tail += gP[${n - k}] * gP[${n - k}];`);
    L.push(`  c = ${terms((i) => `gP[${i}] * gP[${i + k}]`, n - k)};`);
    L.push(`  e = 2.0 * energy - head - tail; r[${k}] = e > 1e-12 ? 2.0 * c / e : 0.0;`);
  }
  L.push('  bool dropped = false; bool done = false; float best = 0.0;');
  for (let k = 1; k <= kmax; k++) {
    L.push(`  if (!done) { if (!dropped) { if (r[${k}] < ${f(PERIODICITY_DROP)}) dropped = true; }` +
      ` else if (r[${k}] > r[${k - 1}] && r[${k}] >= r[${k + 1}] && r[${k}] > max(best, ${f(PERIODICITY_DROP)})) {` +
      ` best = max(best, min(r[${k}], max(r[${2 * k - 1}], max(r[${2 * k}], r[${2 * k + 1}]))));` +
      ` if (best >= ${f(PERIODICITY_EARLY_EXIT)}) done = true; } }`);
  }
  L.push('  return dropped ? clamp(best, 0.0, 1.0) : 0.0;');
  L.push('}');
  return L.join('\n');
}

/** GLSL for countTransitions() of periodicity.ts on gP[0..n) (whole window) and on the `central` samples
 *  starting at c0 (dynamic, centralStart(); 0 samples = skip), FULLY UNROLLED like genScore (constant
 *  array indices, the central window by comparisons). Returns vec2(all, central). Must run on the RAW
 *  profile, i.e. before scoreN() detrends gP in place. */
function genTrans(n: number, central: number): string {
  const L: string[] = [];
  L.push(`vec2 trans_${n}_${central}(int c0) {`);
  L.push('  float mn = gP[0]; float mx = gP[0];');
  for (let i = 1; i < n; i++) L.push(`  mn = min(mn, gP[${i}]); mx = max(mx, gP[${i}]);`);
  L.push(`  float h = max(${f(STRIPE_SWING)} * (mx - mn), ${f(STRIPE_SWING_MIN)});`);
  L.push('  float v; bool up; bool dn;');
  L.push('  float hiA = gP[0]; float loA = gP[0]; float stA = 0.0; float nAll = 0.0;');
  for (let i = 1; i < n; i++) {
    L.push(`  v = gP[${i}]; hiA = max(hiA, v); loA = min(loA, v);` +
      ' up = stA <= 0.0 && v - loA >= h; dn = stA >= 0.0 && hiA - v >= h;' +
      ' if (up || dn) { nAll += 1.0; stA = up ? 1.0 : -1.0; hiA = v; loA = v; }');
  }
  if (central > 0) {
    L.push(`  int c1 = c0 + ${central};`);
    L.push('  float cmn = 1e9; float cmx = -1e9;');
    for (let i = 0; i < n; i++) L.push(`  if (${i} >= c0 && ${i} < c1) { cmn = min(cmn, gP[${i}]); cmx = max(cmx, gP[${i}]); }`);
    L.push(`  float hc = max(${f(STRIPE_SWING)} * (cmx - cmn), ${f(STRIPE_SWING_MIN)});`);
    L.push('  float hiC = 0.0; float loC = 0.0; float stC = 0.0; float nMid = 0.0;');
    for (let i = 0; i < n; i++) {
      L.push(`  if (${i} == c0) { hiC = gP[${i}]; loC = hiC; } else if (${i} > c0 && ${i} < c1) { v = gP[${i}];` +
        ' hiC = max(hiC, v); loC = min(loC, v); up = stC <= 0.0 && v - loC >= hc; dn = stC >= 0.0 && hiC - v >= hc;' +
        ' if (up || dn) { nMid += 1.0; stC = up ? 1.0 : -1.0; hiC = v; loC = v; } }');
    }
    L.push('  return vec2(nAll, nMid);');
  } else L.push('  return vec2(nAll, 0.0);');
  L.push('}');
  return L.join('\n');
}

/** Structure-tensor pass (NOTES.md S8b): per texel of the box-filtered luminance (uLum level 0, 8x8 texels
 *  per tile), clamped central differences -> (gx^2, gy^2, gx*gy). Its mip level 3 holds the per-tile mean
 *  tensor; the reduce pass sums 3x3 tiles of it (structureTensor()/pixelStripe() in periodicity.ts). */
export const TENSOR_FRAG = /* glsl */ `
uniform sampler2D uLum;
varying vec2 vUv;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(${TILE_GRID[0] * 8 - 1}, ${TILE_GRID[1] * 8 - 1});
  float l = texelFetch(uLum, clamp(p - ivec2(1, 0), ivec2(0), hi), 0).r;
  float r = texelFetch(uLum, clamp(p + ivec2(1, 0), ivec2(0), hi), 0).r;
  float d = texelFetch(uLum, clamp(p - ivec2(0, 1), ivec2(0), hi), 0).r;
  float u = texelFetch(uLum, clamp(p + ivec2(0, 1), ivec2(0), hi), 0).r;
  float gx = 0.5 * (r - l); float gy = 0.5 * (u - d);
  gl_FragColor = vec4(gx * gx, gy * gy, gx * gy, 1.0);
}
`;

// ---- S8c local spectrum (periodicity.ts spectralPeaks(); NOTES.md S8c) -----------------------------------
/** Windows per row / column of the local-spectrum analysis (one per SPECTRAL_STRIDE x SPECTRAL_STRIDE tiles). */
export const SPEC_COLS = TILE_GRID[0] / SPECTRAL_STRIDE;
export const SPEC_ROWS = TILE_GRID[1] / SPECTRAL_STRIDE;
/** Half-plane spectrum: kx = 0 .. N/2, stored as SPEC_KX2 pairs (2 kx per texel; the last pair's odd kx unused). */
export const SPEC_KX2 = SPECTRAL_N / 4 + 1;
/** ky pairs per window in the power target (2 ky per texel). */
export const SPEC_KY2 = SPECTRAL_N / 2;
const SN = SPECTRAL_N;
const glslArr = (vals: number[]): string => `float[${vals.length}](${vals.map((v) => f(Number(v.toPrecision(9)))).join(', ')})`;
const SPEC_COMMON = /* glsl */ `
const float HANN[${SN}] = ${glslArr(Array.from({ length: SN }, (_, i) => spectralHann(i)))};
const float COSN[${SN}] = ${glslArr(Array.from({ length: SN }, (_, i) => Math.cos((2 * Math.PI * i) / SN)))};
const float SINN[${SN}] = ${glslArr(Array.from({ length: SN }, (_, i) => Math.sin((2 * Math.PI * i) / SN)))};
// window origin in TILES of window (wx, wy) at pyramid level lv: spectralOrigin() of periodicity.ts per axis
ivec2 specOriginTiles(int wx, int wy, int lv) {
  int wt = ${SN} / (8 >> lv);
  return ivec2(clamp(${SPECTRAL_STRIDE} * wx + 1 - wt / 2, 0, ${TILE_GRID[0]} - wt),
               clamp(${SPECTRAL_STRIDE} * wy + 1 - wt / 2, 0, ${TILE_GRID[1]} - wt));
}
int specLevel(int i) { ${SPECTRAL_LEVELS.map((l, i) => `if (i == ${i}) return ${l};`).join(' ')} return 0; }
`;

/** Local spectrum, pass 0 (SPEC_COLS x (SPEC_ROWS * levels)): the mean of each window, from the exact-area
 *  tile means (uLum level 3; windows are tile-aligned, so this is the mean of the window's texels). */
export const SPEC_STATS_FRAG = /* glsl */ `
uniform sampler2D uLum;
varying vec2 vUv;
${SPEC_COMMON}
void main() {
  ivec2 w = ivec2(gl_FragCoord.xy);
  int li = w.y / ${SPEC_ROWS}; int lv = specLevel(li);
  int wt = ${SN} / (8 >> lv);
  ivec2 o = specOriginTiles(w.x, w.y - ${SPEC_ROWS} * li, lv);
  float s = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) { if (x < wt && y < wt) s += texelFetch(uLum, o + ivec2(x, y), 3).r; }
  }
  gl_FragColor = vec4(s / float(wt * wt), 0.0, 0.0, 1.0);
}
`;

/** Local spectrum, pass 1 ((SPEC_COLS * SPEC_KX2) x (levels * SPEC_ROWS * N)): row DFT of the mean-free,
 *  Hann-windowed window, one fragment per (window, row, kx pair): (re, im) of kx = 2p and 2p + 1 in RGBA.
 *  Unnormalised; the target is 32-bit float when the GPU can render to it (uScale = 1), else half float
 *  with uScale = 1 / N per DFT pass (the decision is a ratio, scale-free). */
export const SPEC_ROW_FRAG = /* glsl */ `
uniform sampler2D uLum;
uniform sampler2D uSpecStats;
uniform float uScale;
varying vec2 vUv;
${SPEC_COMMON}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int wx = fc.x / ${SPEC_KX2}; int kx0 = 2 * (fc.x - ${SPEC_KX2} * wx);
  int li = fc.y / ${SPEC_ROWS * SN}; int rem = fc.y - ${SPEC_ROWS * SN} * li;
  int wy = rem / ${SN}; int row = rem - ${SN} * wy;
  int lv = specLevel(li);
  float m = texelFetch(uSpecStats, ivec2(wx, ${SPEC_ROWS} * li + wy), 0).r;
  ivec2 o = specOriginTiles(wx, wy, lv) * (8 >> lv) + ivec2(0, row);
  vec4 acc = vec4(0.0);
  // twiddles e^(-2 pi i k n / N) for k = kx0, kx0 + 1 by rotation (exact table values every step would need
  // dynamically indexed constant arrays, which are slow on some GPUs)
  vec2 r0 = vec2(COSN[kx0 & ${SN - 1}], -SINN[kx0 & ${SN - 1}]); vec2 r1 = vec2(COSN[(kx0 + 1) & ${SN - 1}], -SINN[(kx0 + 1) & ${SN - 1}]);
  vec2 z0 = vec2(1.0, 0.0); vec2 z1 = vec2(1.0, 0.0);
  for (int n = 0; n < ${SN}; n++) {
    float v = (texelFetch(uLum, o + ivec2(n, 0), lv).r - m) * HANN[n];
    acc += v * vec4(z0, z1);
    z0 = vec2(z0.x * r0.x - z0.y * r0.y, z0.x * r0.y + z0.y * r0.x);
    z1 = vec2(z1.x * r1.x - z1.y * r1.y, z1.x * r1.y + z1.y * r1.x);
  }
  gl_FragColor = acc * (HANN[row] * uScale);
}
`;

/** Local spectrum, pass 2 ((SPEC_COLS * SPEC_KX2) x (levels * SPEC_ROWS * SPEC_KY2)): column DFT -> power,
 *  one fragment per (window, kx pair, ky pair): (P(2p, 2q), P(2p+1, 2q), P(2p, 2q+1), P(2p+1, 2q+1)). */
export const SPEC_COL_FRAG = /* glsl */ `
uniform sampler2D uRow;
uniform float uScale;
varying vec2 vUv;
${SPEC_COMMON}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int win = fc.y / ${SPEC_KY2}; int ky0 = 2 * (fc.y - ${SPEC_KY2} * win);
  int base = ${SN} * win;    // first row of this window (level and window row) in the row target
  vec4 a0 = vec4(0.0); vec4 a1 = vec4(0.0);   // (re, im) of kx0, kx0+1 for ky0 and ky0 + 1
  vec2 r0 = vec2(COSN[ky0 & ${SN - 1}], SINN[ky0 & ${SN - 1}]); vec2 r1 = vec2(COSN[(ky0 + 1) & ${SN - 1}], SINN[(ky0 + 1) & ${SN - 1}]);
  vec2 z0 = vec2(1.0, 0.0); vec2 z1 = vec2(1.0, 0.0);   // (cos, sin) of 2 pi ky r / N by rotation
  for (int r = 0; r < ${SN}; r++) {
    vec4 c = texelFetch(uRow, ivec2(fc.x, base + r), 0);
    float c0 = z0.x; float s0 = z0.y; float c1 = z1.x; float s1 = z1.y;
    z0 = vec2(z0.x * r0.x - z0.y * r0.y, z0.x * r0.y + z0.y * r0.x);
    z1 = vec2(z1.x * r1.x - z1.y * r1.y, z1.x * r1.y + z1.y * r1.x);
    // (a + ib)(cos - i sin) = a cos + b sin + i (b cos - a sin)
    a0 += vec4(c.x * c0 + c.y * s0, c.y * c0 - c.x * s0, c.z * c0 + c.w * s0, c.w * c0 - c.z * s0);
    a1 += vec4(c.x * c1 + c.y * s1, c.y * c1 - c.x * s1, c.z * c1 + c.w * s1, c.w * c1 - c.z * s1);
  }
  a0 *= uScale; a1 *= uScale;
  gl_FragColor = vec4(dot(a0.xy, a0.xy), dot(a0.zw, a0.zw), dot(a1.xy, a1.xy), dot(a1.zw, a1.zw));
}
`;

// Local spectrum, passes 3-8: the greedy top-SPECTRAL_PEAKS peaks of spectralPeaks() (periodicity.ts),
// exactly, but split so that no fragment runs a long serial loop (one fragment per window scanning all
// N * (N/2 + 1) bins three times took 0.6 ms of latency): for each peak q, a STRIP pass (one fragment per
// window and ky pair, SPEC_KX2 texels = 2 ky rows of the half plane) finds the strip's strongest candidate
// (radius >= SPECTRAL_MIN_CYCLES, not near an earlier peak, ties to the lowest ky * (N/2 + 1) + kx, the
// reference's scan order), then a PICK pass (one fragment per window) takes the best strip candidate as
// peak q and adds the energy of its 3x3 neighbourhood and the mirror's (bins of earlier peaks excluded).
// State between the passes (per window, 32-bit float): (total, sum, code0, code1), code = (sy + N) * N + kx
// of a chosen peak (signed ky, kx), -1 = none.
if (SPECTRAL_PEAKS !== 3) throw new Error('SPEC_PICK_FRAG keeps exactly two earlier peaks in its state');
const SPEC_PEAK_COMMON = /* glsl */ `
uniform sampler2D uPow;
uniform sampler2D uState;
uniform int uQ;
varying vec2 vUv;
ivec2 gBase;
int wrapd(int a, int b) { int d = (a - b + ${4 * SN}) & ${SN - 1}; return min(d, ${SN} - d); }
bool nearK(int ky, int kx, ivec2 k) { return wrapd(ky, k.x) <= 1 && wrapd(kx, k.y) <= 1; }
bool nearPeak(int ky, int kx, ivec2 k) { return nearK(ky, kx, k) || nearK(ky, kx, -k); }
float binAt(int ky, int kx) {   // half-plane bin (0 <= kx <= N/2, 0 <= ky < N)
  return texelFetch(uPow, gBase + ivec2(kx >> 1, ky >> 1), 0)[(kx & 1) + 2 * (ky & 1)];
}
// power of the full-plane bin (ky, kx) (any integers)
float powAt(int ky, int kx) {
  ky = (ky + ${4 * SN}) & ${SN - 1}; kx = (kx + ${4 * SN}) & ${SN - 1};
  if (kx > ${SN / 2}) { kx = ${SN} - kx; ky = (${SN} - ky) & ${SN - 1}; }
  return binAt(ky, kx);
}
ivec2 decodePeak(float code) { int c = int(code + 0.5); return ivec2(c / ${SN} - ${SN}, c - ${SN} * (c / ${SN})); }
float encodePeak(ivec2 k) { return float((k.x + ${SN}) * ${SN} + k.y); }
// true when bin (ky, kx) lies in the neighbourhood (or the mirror's) of a peak chosen before peak uQ
bool usedBefore(int ky, int kx, vec4 st) {
  if (uQ > 0 && st.z >= 0.0 && nearPeak(ky, kx, decodePeak(st.z))) return true;
  if (uQ > 1 && st.w >= 0.0 && nearPeak(ky, kx, decodePeak(st.w))) return true;
  return false;
}
`;

/** Local spectrum, strip pass (SPEC_COLS x (levels * SPEC_ROWS * SPEC_KY2)): per window and ky pair,
 *  (best candidate power or -1, its index, the strip's energy share of the full plane, 0). */
export const SPEC_STRIP_FRAG = /* glsl */ `
${SPEC_PEAK_COMMON}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int win = fc.y / ${SPEC_KY2}; int ty = fc.y - ${SPEC_KY2} * win;
  gBase = ivec2(${SPEC_KX2} * fc.x, ${SPEC_KY2} * win);
  vec4 st = texelFetch(uState, ivec2(fc.x, win), 0);
  float best = -1.0; int bIdx = 0; float energy = 0.0;
  for (int tx = 0; tx < ${SPEC_KX2}; tx++) {
    vec4 v = texelFetch(uPow, gBase + ivec2(tx, ty), 0);
    energy += tx == 0 ? v.x + 2.0 * v.y + v.z + 2.0 * v.w : (tx == ${SPEC_KX2 - 1} ? v.x + v.z : 2.0 * (v.x + v.y + v.z + v.w));
    for (int c = 0; c < 4; c++) {
      int kx = 2 * tx + (c & 1); int ky = 2 * ty + (c >> 1);
      int sy = ky > ${SN / 2} ? ky - ${SN} : ky;
      float p = v[c];
      int idx = ky * ${SN / 2 + 1} + kx;
      if (kx > ${SN / 2} || kx * kx + sy * sy < ${SPECTRAL_MIN_CYCLES * SPECTRAL_MIN_CYCLES}) continue;
      if (p < best || (p == best && idx > bIdx)) continue;
      if (usedBefore(ky, kx, st)) continue;
      best = p; bIdx = idx;
    }
  }
  gl_FragColor = vec4(best, float(bIdx), energy, 0.0);
}
`;

/** Local spectrum, pick pass (SPEC_COLS x (SPEC_ROWS * levels)): peak uQ from the strip candidates and its
 *  neighbourhood energy. Writes the state (total, sum, code0, code1) for uQ < SPECTRAL_PEAKS - 1, and for
 *  the last peak the result (top3 = sum / total, radius of the strongest peak, 0, 1). Flat windows (Hann-
 *  weighted rms below SPECTRAL_MIN_RMS, from Parseval: sum P = N^2 sum x^2) give 0. */
export const SPEC_PICK_FRAG = /* glsl */ `
uniform sampler2D uStrips;
uniform float uScale;
${SPEC_PEAK_COMMON}
void main() {
  ivec2 w = ivec2(gl_FragCoord.xy);
  gBase = ivec2(${SPEC_KX2} * w.x, ${SPEC_KY2} * w.y);
  vec4 st = uQ > 0 ? texelFetch(uState, w, 0) : vec4(0.0, 0.0, -1.0, -1.0);
  float best = -1.0; int bIdx = 0; float all_ = 0.0;
  for (int ty = 0; ty < ${SPEC_KY2}; ty++) {
    vec4 c = texelFetch(uStrips, ivec2(w.x, ${SPEC_KY2} * w.y + ty), 0);
    all_ += c.z;
    int idx = int(c.y + 0.5);
    if (c.x < 0.0 || c.x < best || (c.x == best && idx > bIdx)) continue;
    best = c.x; bIdx = idx;
  }
  if (uQ == 0) {
    st.x = all_ - powAt(0, 0);
    // Parseval: sum over the full plane of |X|^2 = N^2 sum x^2 (times uScale^4 on the half-float path)
    float rms2 = all_ / (${f(SN ** 4)} * pow(uScale, 4.0));
    if (rms2 < ${f(SPECTRAL_MIN_RMS * SPECTRAL_MIN_RMS)} || !(st.x > 0.0)) st.x = 0.0;
  }
  float code = -1.0;
  if (st.x > 0.0 && best >= 0.0) {
    int ky = bIdx / ${SN / 2 + 1}; int kx = bIdx - ${SN / 2 + 1} * ky;
    ivec2 bk = ivec2(ky > ${SN / 2} ? ky - ${SN} : ky, kx);
    float e = 0.0;
    for (int m = 0; m < 2; m++) {
      ivec2 c = m == 0 ? bk : -bk;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          int y = c.x + dy; int x = c.y + dx;
          if (m == 1 && nearK(y, x, bk)) continue;   // already counted in the first neighbourhood
          if (!usedBefore(y, x, st)) e += powAt(y, x);
        }
      }
    }
    st.y += e;
    code = encodePeak(bk);
  }
  if (uQ == 0) st.z = code; else if (uQ == 1) st.w = code;
  if (uQ < ${SPECTRAL_PEAKS - 1}) { gl_FragColor = st; return; }
  float rad0 = st.z >= 0.0 ? length(vec2(decodePeak(st.z))) : 0.0;
  gl_FragColor = vec4(st.x > 0.0 ? st.y / st.x : 0.0, rad0, 0.0, 1.0);
}
`;

/** Periodicity, pass 1 (NOTES.md S8): one fragment per (tile, direction, scale) on a
 *  (64 x N_DIRS) x (36 x 4) target, x = N_DIRS * col + direction (angle direction * 180 / N_DIRS degrees),
 *  y = 36 * scale + row (scale-major, so a GPU warp rarely mixes scales): scale 0 = coarse pixel profile
 *  (2-tap box samples), 1 = fine pixel profile, 2 = tile-mean grid along the direction (GRID_N samples,
 *  bilinear), 3 = the horizontal GRID_N_H tile-mean profile (direction 0 only). Tile means are exact-area
 *  (uLum level 3). A literal port of periodicity.ts (sampleProfile / gridPeriodicity / periodicityScore).
 *  Writes the score into R and (S8b) stripe transitions into G/B: scale 0 = (all 128, central
 *  STRIPE_CENTRAL_N), scale 2 = (all, central GRID_CENTRAL_N), scale 3 = whole row (direction 0) or
 *  whole column (direction N_DIRS/2) of tile means in G. Needs a float target (counts > 1). */
export function periodicityFrag(): string {
  const n = PROFILE_N;
  const T = TILE_GRID[1];
  const T_COLS = TILE_GRID[0];
  const rowLines: string[] = [];
  for (let i = 0; i < T_COLS; i++) rowLines.push(`      gP[${i}] = texelFetch(uLum, ivec2(${i}, int(tile.y)), 3).r;`);
  const colLines: string[] = [];
  for (let i = 0; i < T; i++) colLines.push(`      gP[${i}] = texelFetch(uLum, ivec2(int(tile.x), ${i}), 3).r;`);
  const sampleLines: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = f(i - 0.5 * (n - 1));
    sampleLines.push(`    gP[${i}] = 0.5 * (lumAt(cc + (${s} * step - o) * dir, res) + lumAt(cc + (${s} * step + o) * dir, res));`);
  }
  const gridDirLines: string[] = [];
  for (let i = 0; i < GRID_N; i++) {
    gridDirLines.push(`      gP[${i}] = textureLod(uLum, (cc + ${f(i - 0.5 * (GRID_N - 1))} * dir) / grid, 3.0).r;`);
  }
  const gridHLines: string[] = [];
  for (let i = 0; i < GRID_N_H; i++) {
    gridHLines.push(`      gP[${i}] = texelFetch(uLum, ivec2(int(floor(hx + ${f(i - 0.5 * (GRID_N_H - 1))})), int(tile.y)), 3).r;`);
  }
  return /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uLum;   // LUMA_DOWN_FRAG target; mip level 3 = exact tile means
varying vec2 vUv;
${LUMA}
float gP[${n}];
${genScore(n)}
${genScore(GRID_N_H)}
${genScore(GRID_N)}
${genTrans(n, STRIPE_CENTRAL_N)}
${genTrans(GRID_N, GRID_CENTRAL_N)}
${genTrans(T_COLS, 0)}
${genTrans(T, 0)}

float clampCentre(float c, float ext, float size) {
  float lo = ext; float hi = size - ext;
  return lo <= hi ? clamp(c, lo, hi) : 0.5 * size;
}

float lumAt(vec2 px, vec2 res) { return luma(clamp(texture2D(uInput, px / res).rgb, 0.0, 1.0)); }

void main() {
  vec2 grid = vec2(${f(TILE_GRID[0])}, ${f(T)});
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int dirIdx = fc.x - ${N_DIRS} * (fc.x / ${N_DIRS});
  int scale = fc.y / ${T};
  vec2 tile = vec2(float(fc.x / ${N_DIRS}), float(fc.y - ${T} * scale));
  float ang = float(dirIdx) * ${f(Math.PI / N_DIRS)};
  vec2 dir = vec2(cos(ang), sin(ang));
  float p = 0.0;
  vec2 tr = vec2(0.0);   // S8b stripe transitions (all, central) where this scale has them
  if (scale < 2) {
    // sampleProfile() of periodicity.ts through the tile centre; the fine scale's two taps coincide
    vec2 res = vec2(textureSize(uInput, 0));
    float tw = res.x / grid.x;
    float step = (scale == 0 ? ${f(COARSE_STEP_TILES)} : ${f(FINE_STEP_TILES)}) * tw;
    float o = scale == 0 ? 0.25 * step : 0.0;
    float half_ = ${f(0.5 * (n - 1))} * step;
    vec2 c = (tile + 0.5) * res / grid;
    vec2 cc = vec2(clampCentre(c.x, abs(dir.x) * half_, res.x), clampCentre(c.y, abs(dir.y) * half_, res.y));
${sampleLines.join('\n')}
    if (scale == 0) {
      // central window centred on the tile's own position in the (possibly shifted) profile: centralStart()
      float at = ${f(0.5 * (n - 1))} + dot(c - cc, dir) / step;
      tr = trans_${n}_${STRIPE_CENTRAL_N}(clamp(int(floor(at + 0.5)) - ${STRIPE_CENTRAL_N / 2}, 0, ${n - STRIPE_CENTRAL_N}));
    }
    p = score${n}();
  } else if (scale == 2) {
    // gridPeriodicity(), direction profiles: GRID_N samples, bilinear between tile centres
    vec2 cc = vec2(clampCentre(tile.x + 0.5, abs(dir.x) * ${f(0.5 * (GRID_N - 1))} + 0.5, grid.x),
                   clampCentre(tile.y + 0.5, abs(dir.y) * ${f(0.5 * (GRID_N - 1))} + 0.5, grid.y));
${gridDirLines.join('\n')}
    float at = ${f(0.5 * (GRID_N - 1))} + dot(tile + 0.5 - cc, dir);
    tr = trans_${GRID_N}_${GRID_CENTRAL_N}(clamp(int(floor(at + 0.5)) - ${GRID_CENTRAL_N / 2}, 0, ${GRID_N - GRID_CENTRAL_N}));
    p = score${GRID_N}();
  } else if (dirIdx == 0) {
    // gridPeriodicity(), horizontal profile: GRID_N_H tile centres
    float hx = clampCentre(tile.x + 0.5, ${f(0.5 * (GRID_N_H - 1) + 0.5)}, grid.x);
${gridHLines.join('\n')}
    p = score${GRID_N_H}();
    // S8b: transitions along the whole row of tile means (screen-wide "more than five pairs" rule)
${rowLines.join('\n')}
    tr = trans_${T_COLS}_0(0);
  } else if (dirIdx == ${N_DIRS / 2}) {
    // S8b: transitions along the whole column of tile means
${colLines.join('\n')}
    tr = trans_${T}_0(0);
  }
  gl_FragColor = vec4(p, tr.x, tr.y, 1.0);
}
`;
}

/** Periodicity, pass 2: per tile the max over its profile scores (uPer, pass 1) plus the stats pass's
 *  neighbourhood min/max (uStats), and (S8b) the stripe test: the 3x3-tile structure tensor (uTensor
 *  level 3) picks the across direction, whose coarse transitions (uPer G/B) must reach the minimums; the
 *  5x5-tile tensor of the tile means (uLum level 3) picks the grid direction for the screen-wide rule.
 *  S8c: the local-spectrum flag of the tile's window (uSpec, either pyramid level).
 *  Writes (sqrt minY, sqrt maxY, p, kinds), kinds = 0 or (128 + 64 pixel stripe + 32 spectral + 16 grid
 *  stripe) / 255; the target the CPU reads back. Mirrors pixelStripe() / gridStripe() / spectralTop3() of
 *  periodicity.ts. */
export const PERIODICITY_REDUCE_FRAG = /* glsl */ `
uniform sampler2D uPer;
uniform sampler2D uStats;
uniform sampler2D uTensor;
uniform sampler2D uLum;
uniform sampler2D uSpec;  // SPEC_PEAK_FRAG: per window and level, R = top-${SPECTRAL_PEAKS} peak energy fraction
varying vec2 vUv;
const ivec2 GMAX = ivec2(${TILE_GRID[0] - 1}, ${TILE_GRID[1] - 1});
float tmean(ivec2 q) { return texelFetch(uLum, clamp(q, ivec2(0), GMAX), 3).r; }
// coherence (x) and nearest profile direction index (y) of a structure tensor (xx, yy, xy)
vec2 orient(vec3 J) {
  float tr = J.x + J.y;
  float c = tr > 1e-9 ? sqrt((J.x - J.y) * (J.x - J.y) + 4.0 * J.z * J.z) / tr : 0.0;
  float phi = 0.5 * atan(2.0 * J.z, J.x - J.y);
  float d = mod(floor(phi / ${f(Math.PI / N_DIRS)} + 0.5), ${f(N_DIRS)});
  return vec2(c, d);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float p = 0.0;
  for (int d = 0; d < ${N_DIRS}; d++) {
    int x = ${N_DIRS} * t.x + d;
    p = max(p, max(texelFetch(uPer, ivec2(x, t.y), 0).r, texelFetch(uPer, ivec2(x, ${TILE_GRID[1]} + t.y), 0).r));
    p = max(p, max(texelFetch(uPer, ivec2(x, ${2 * TILE_GRID[1]} + t.y), 0).r,
                   texelFetch(uPer, ivec2(x, ${3 * TILE_GRID[1]} + t.y), 0).r));
  }
  // pixel scale: 3x3-tile tensor (mean tensors per tile; coherence is scale invariant)
  vec3 J = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) J += texelFetch(uTensor, clamp(t + ivec2(i, j), ivec2(0), GMAX), 3).rgb;
  }
  vec2 o = orient(J);
  vec4 a = texelFetch(uPer, ivec2(${N_DIRS} * t.x + int(o.y), t.y), 0);
  bool fine = o.x >= ${f(STRIPE_COHERENCE_MIN)} && a.g >= ${f(STRIPE_MIN_TRANSITIONS)} - 0.5 && a.b >= ${f(STRIPE_CENTRAL_MIN)} - 0.5;
  // grid scale: 5x5-tile tensor of the tile means (clamped central differences)
  vec3 G = vec3(0.0);
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      ivec2 q = clamp(t + ivec2(i, j), ivec2(0), GMAX);
      float gx = 0.5 * (tmean(q + ivec2(1, 0)) - tmean(q - ivec2(1, 0)));
      float gy = 0.5 * (tmean(q + ivec2(0, 1)) - tmean(q - ivec2(0, 1)));
      G += vec3(gx * gx, gy * gy, gx * gy);
    }
  }
  vec2 og = orient(G);
  float midG = texelFetch(uPer, ivec2(${N_DIRS} * t.x + int(og.y), ${2 * TILE_GRID[1]} + t.y), 0).b;
  float rowT = texelFetch(uPer, ivec2(${N_DIRS} * t.x, ${3 * TILE_GRID[1]} + t.y), 0).g;
  float colT = texelFetch(uPer, ivec2(${N_DIRS} * t.x + ${N_DIRS / 2}, ${3 * TILE_GRID[1]} + t.y), 0).g;
  bool grid = og.x >= ${f(STRIPE_COHERENCE_MIN)} && midG >= ${f(GRID_CENTRAL_MIN)} - 0.5 &&
    max(rowT, colT) >= ${f(GLOBAL_MIN_TRANSITIONS)} - 0.5;
  // S8c local spectrum: the window of this tile's 2x2 group at each pyramid level
  float top3 = 0.0;
  for (int l = 0; l < ${SPECTRAL_LEVELS.length}; l++) {
    top3 = max(top3, texelFetch(uSpec, ivec2(t.x / ${SPECTRAL_STRIDE}, ${SPEC_ROWS} * l + t.y / ${SPECTRAL_STRIDE}), 0).r);
  }
  bool spectral = top3 >= ${f(SPECTRAL_TOP3_MIN)};
  vec4 st = texelFetch(uStats, t, 0);
  // alpha: 0 = no pattern; else (128 + 64 stripe(pixel) + 32 spectral + 16 stripe(grid)) / 255 (>= 128: pattern)
  float a8 = (fine || grid || spectral) ? 128.0 + (fine ? 64.0 : 0.0) + (spectral ? 32.0 : 0.0) + (grid ? 16.0 : 0.0) : 0.0;
  // min / max sqrt-encoded: the 8-bit readback keeps ~0.001 resolution on dark content (S8c; a 0.0212
  // range read back as 5/255 = 0.0196 and failed the GUARD_RANGE_MIN test)
  gl_FragColor = vec4(sqrt(max(st.r, 0.0)), sqrt(max(st.g, 0.0)), p, a8 / 255.0);
}
`;

/** Guard compression factor over a flashcheck-block-sized neighbourhood (NOTES.md S8b): the stats pass's
 *  cf brings the 5x5-tile Michelson contrast to GUARD_TARGET_CONTRAST around the 5x5 mean m, but m itself
 *  varies (an amplitude envelope, a black area next to the pattern), so a 160x180-px block could still
 *  span bright compressed stripes and a dark band. Over the 9x9-tile window (clamped to the grid) the
 *  output y' = m + (y - m) * cf stays within [min m - cf * max(m - mn), max m + cf * max(mx - m)];
 *  choose cf so that this range has Michelson <= GUARD_TARGET_CONTRAST (cf = 0 when the means alone
 *  exceed it: the pattern is replaced by its smooth local mean). Output (mn, mx, min(cf, cf9), m). */
export const GUARD_CF_FRAG = /* glsl */ `
uniform sampler2D uStats;
varying vec2 vUv;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uStats, t, 0);
  ivec2 o = clamp(t - 4, ivec2(0), ivec2(${TILE_GRID[0] - 9}, ${TILE_GRID[1] - 9}));
  float mLo = 1e9; float mHi = -1e9; float dHi = 0.0; float dLo = 0.0;
  for (int j = 0; j < 9; j++) {
    for (int i = 0; i < 9; i++) {
      vec4 q = texelFetch(uStats, o + ivec2(i, j), 0);
      mLo = min(mLo, q.a); mHi = max(mHi, q.a);
      dHi = max(dHi, q.g - q.a); dLo = max(dLo, q.a - q.r);
    }
  }
  float T = ${f(GUARD_TARGET_CONTRAST)};
  float num = T * (mHi + mLo) - (mHi - mLo);
  float den = (dHi + dLo) - T * (dHi - dLo);
  float c9 = num <= 0.0 ? 0.0 : clamp(num / max(den, 1e-5), 0.0, 1.0);
  gl_FragColor = vec4(s.r, s.g, min(s.b, c9), s.a);
}
`;

/** Pass A (to the LINEAR EMA target): mean-luminance cap, large-area PERIODIC contrast guard, then the temporal
 *  low-pass ema = mix(prevEma, in, uK). With uK = 1 (not engaged) the EMA is the processed input. */
export const EMA_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uPrevEma;
uniform sampler2D uStats;
uniform float uK;
uniform float uBright;
uniform float uGuard;
uniform sampler2D uGuardMask;
varying vec2 vUv;
${LUMA}
void main() {
  vec3 c = clamp(texture2D(uInput, vUv).rgb, 0.0, 1.0) * uBright;
  vec4 st = texture2D(uStats, vUv);
  // uStats = GUARD_CF_FRAG output (envelope-aware cf). Compress only where the guard mask (pattern tiles,
  // 5x5-dilated, enclosed holes filled, 1 s per-tile release) is set.
  float cf = mix(1.0, st.b, uGuard * texture2D(uGuardMask, vUv).r);
  if (cf < 0.999) {
    float m = st.a * uBright;
    float y = luma(c);
    float y2 = m + (y - m) * cf;
    vec3 scaled = mix(vec3(y2), c * (y2 / max(y, 1e-4)), smoothstep(0.0, 0.05, y));
    // Out of gamut (a saturated colour lifted to a luminance it cannot reach, e.g. pure blue to y2 > 0.0722):
    // desaturate toward the grey of the same luminance instead of clipping, which kept the colour's own
    // luminance and so the stripes' contrast (S8c). Every mix of vec3(y2) and scaled has luminance y2, and
    // vec3(y2) itself is in gamut (0 <= y2 <= 1), so the result reaches exactly y2.
    float hiC = max(scaled.r, max(scaled.g, scaled.b));
    if (hiC > 1.0) scaled = vec3(y2) + (scaled - vec3(y2)) * ((1.0 - y2) / max(hiC - y2, 1e-6));
    c = clamp(scaled, 0.0, 1.0);
  }
  vec3 e = texture2D(uPrevEma, vUv).rgb;
  gl_FragColor = vec4(mix(e, c, uK), 1.0);
}
`;

/** Slew limit, pass 1 (64 x 36): per tile the largest |luminance| and |channel| change between the previous
 *  OUTPUT frame and the new EMA frame over every pixel of the tile. */
export const SLEW_TILE_FRAG = /* glsl */ `
uniform sampler2D uEma;
uniform sampler2D uPrev;
varying vec2 vUv;
${LUMA}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uEma, 0);
  ivec2 g = ivec2(${TILE_GRID[0]}, ${TILE_GRID[1]});
  ivec2 a = t * size / g; ivec2 b = max((t + 1) * size / g, a + 1);
  b = min(b, size);
  float my = 0.0; float mc = 0.0;
  for (int y = a.y; y < b.y; y++) {
    for (int x = a.x; x < b.x; x++) {
      vec3 d = texelFetch(uEma, ivec2(x, y), 0).rgb - texelFetch(uPrev, ivec2(x, y), 0).rgb;
      my = max(my, abs(luma(d)));
      mc = max(mc, max(abs(d.r), max(abs(d.g), abs(d.b))));
    }
  }
  gl_FragColor = vec4(my, mc, 0.0, 1.0);
}
`;

/** Slew limit, pass 2 (1 x 1): ONE step factor s for the whole frame, so that no pixel's luminance moves
 *  by more than uMaxDelta (chroma 3x). A uniform s makes every output frame a convex blend of the previous
 *  output and the EMA frame, whose Michelson contrast over any region is at most the larger of the two:
 *  the limiter's own fade can never CREATE contrast. A per-pixel clamp (S2) moved every pixel by the same
 *  absolute amount, so on a fade to black the dark stripes of a (compressed, or legal 0.33-contrast)
 *  pattern reached black first and the fading frame became a Michelson 1.0 pattern (S8c). Written slightly
 *  conservatively (half-float rounding). */
export const SLEW_GLOBAL_FRAG = /* glsl */ `
uniform sampler2D uSlewTiles;
uniform float uMaxDelta;
varying vec2 vUv;
void main() {
  float my = 0.0; float mc = 0.0;
  for (int j = 0; j < ${TILE_GRID[1]}; j++) {
    for (int i = 0; i < ${TILE_GRID[0]}; i++) {
      vec2 v = texelFetch(uSlewTiles, ivec2(i, j), 0).rg;
      my = max(my, v.r); mc = max(mc, v.g);
    }
  }
  float s = min(1.0, uMaxDelta / max(my, 1e-6));
  s = min(s, 3.0 * uMaxDelta / max(mc, 1e-6));
  gl_FragColor = vec4(s >= 1.0 ? 1.0 : s * 0.998, 0.0, 0.0, 1.0);
}
`;

/** Pass B (to the LINEAR output-history target): the output moves from the previous OUTPUT frame toward
 *  the EMA by the frame-global factor of SLEW_GLOBAL_FRAG (uSlewOn = 0: no limit, s = 1). */
export const OUTPUT_FRAG = /* glsl */ `
uniform sampler2D uEma;
uniform sampler2D uPrev;
uniform sampler2D uSlew;
uniform float uSlewOn;
varying vec2 vUv;
void main() {
  vec3 p = texture2D(uPrev, vUv).rgb;
  vec3 d = texture2D(uEma, vUv).rgb - p;
  float s = uSlewOn > 0.5 ? texelFetch(uSlew, ivec2(0), 0).r : 1.0;
  gl_FragColor = vec4(p + d * s, 1.0);
}
`;

/** Linear copy (bilinear resample) of a history / EMA target into a new-size target on resize, so a
 *  window resize keeps the limiter's temporal state instead of showing one unfiltered frame. */
export const COPY_FRAG = /* glsl */ `
uniform sampler2D uSrc;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(uSrc, vUv).rgb, 1.0); }
`;

/** Final blit of the linear history target to the screen, with sRGB encoding. */
export const BLIT_FRAG = /* glsl */ `
uniform sampler2D uSrc;
varying vec2 vUv;
void main() {
  vec3 c = clamp(texture2D(uSrc, vUv).rgb, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  gl_FragColor = vec4(mix(lo, hi, step(vec3(0.0031308), c)), 1.0);
}
`;
