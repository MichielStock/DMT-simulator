// GLSL for the SafetyLimiter passes. Constants come from thresholds.ts only.
import {
  GUARD_TARGET_CONTRAST, LUMA_WEIGHTS, RED_MIN_R, RED_SAT, TILE_GRID,
} from './thresholds';

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

/** Tile analysis. MODE 0 writes (meanY, redFraction, probeY1, probeY2); MODE 1 writes
 *  (minY, maxY, contrastFactor, meanY). Input is LINEAR RGB; 4x4 jittered samples per tile. */
export function tileFrag(mode: 0 | 1): string {
  return /* glsl */ `
#define MODE ${mode}
uniform sampler2D uInput;
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
  // Pattern guard statistics over a 5x5-tile neighbourhood (8x8 jittered samples) plus the tile's own
  // 16 samples, so that periodic structure larger than one tile is still seen as contrast and adjacent
  // tiles get consistent compression.
  float nSum = 0.0;
  vec2 origin = clamp(tile - 2.0, vec2(0.0), grid - 5.0);  // keep the footprint inside the screen
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      vec2 ij = vec2(float(i), float(j));
      vec2 jit = vec2(fract(float(i * 13 + j * 7) * 0.618), fract(float(i * 3 + j * 17) * 0.414)) - 0.5;
      vec2 uv = (origin + (ij + 0.5 + jit * 0.8) * (5.0 / 8.0)) / grid;
      float y = luma(clamp(texture2D(uInput, uv).rgb, 0.0, 1.0));
      nSum += y; mn = min(mn, y); mx = max(mx, y);
    }
  }
  m = nSum / 64.0;
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

/** Pass A (to the LINEAR EMA target): mean-luminance cap, large-area contrast guard, then the temporal
 *  low-pass ema = mix(prevEma, in, uK). With uK = 1 (not engaged) the EMA is the processed input. */
export const EMA_FRAG = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uPrevEma;
uniform sampler2D uStats;
uniform float uK;
uniform float uBright;
uniform float uGuard;
varying vec2 vUv;
${LUMA}
void main() {
  vec3 c = clamp(texture2D(uInput, vUv).rgb, 0.0, 1.0) * uBright;
  vec4 st = texture2D(uStats, vUv);
  float cf = mix(1.0, st.b, uGuard);
  if (cf < 0.999) {
    float m = st.a * uBright;
    float y = luma(c);
    float y2 = m + (y - m) * cf;
    vec3 scaled = c * (y2 / max(y, 1e-4));
    c = clamp(mix(vec3(y2), scaled, smoothstep(0.0, 0.05, y)), 0.0, 1.0);
  }
  vec3 e = texture2D(uPrevEma, vUv).rgb;
  gl_FragColor = vec4(mix(e, c, uK), 1.0);
}
`;

/** Pass B (to the LINEAR output-history target): the output moves from the previous OUTPUT frame
 *  toward the EMA with its per-pixel luminance change clamped to uMaxDelta (chroma to 3x that). */
export const OUTPUT_FRAG = /* glsl */ `
uniform sampler2D uEma;
uniform sampler2D uPrev;
uniform float uMaxDelta;
varying vec2 vUv;
${LUMA}
void main() {
  vec3 p = texture2D(uPrev, vUv).rgb;
  vec3 d = texture2D(uEma, vUv).rgb - p;
  float dy = abs(luma(d));
  float dc = max(abs(d.r), max(abs(d.g), abs(d.b)));
  float s = min(1.0, uMaxDelta / max(dy, 1e-6));
  s = min(s, 3.0 * uMaxDelta / max(dc, 1e-6));
  gl_FragColor = vec4(p + d * s, 1.0);
}
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
