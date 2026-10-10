// Chrysanthemum layer (BUILD.md §11.5): hyperbolic triangle-group tilings in the Poincaré disk by
// reflection folding, warped onto a radially symmetric flower/dome sheet, with a Kleinian (Maskit)
// limit set drawn as a ring of lace / pearl filaments. Output is LINEAR RGB, alpha = layer weight.
//
// Safety at source (BUILD.md §4.1): tile luminance stays in ~0.18–0.5 (Michelson of the periodic
// structure ≤ ~0.45 incl. edges), no near-white, soft edges, detail fades out where tiles get smaller
// than a few pixels and wherever the Möbius motion would make the pattern change faster than ~0.6 Hz
// at a pixel; group changes are crossfades (uMix, driven by the scheduler, ≥ 300 ms).
precision highp float;
varying vec2 vUv;

uniform vec2 uRes;           // scene target size in pixels
uniform float uWeight;
uniform float uTime;         // state.wallTime (s)
uniform float uPulse;
uniform float uIntensity;    // visual / 10
uniform float uChallenge;    // 0–1
uniform vec2 uLook;

// two tilings for crossfades: wedge angle π/p, mirror-2 normal, circle centre + radius
uniform vec4 uTriA;          // (wedge, n2.x, n2.y, R)
uniform vec2 uCenA;
uniform vec4 uMetaA;         // (|B| folded triangle size, polygon spacing λ (hyperbolic), p, 0)
uniform vec4 uTriB;
uniform vec2 uCenB;
uniform vec4 uMetaB;
uniform float uMix;          // 0 = A only, 1 = B only

// Möbius motion z ↦ (a z + b)/(c z + d): now and 0.25 s ahead (for the temporal-frequency guard)
uniform vec4 uMobAB;         // a.re a.im b.re b.im
uniform vec4 uMobCD;
uniform vec4 uMobAB2;
uniform vec4 uMobCD2;

uniform float uZoom;         // screen radius → hyperbolic stretch of the dome
uniform float uPetals;       // number of petals (2p of the first group)
uniform vec3 uPal[5];        // palette, LINEAR, normalised to relative luminance 0.2
uniform vec3 uMean;          // palette mean

uniform sampler2D uField;
uniform float uHasField;

uniform vec2 uKlein;         // Maskit height (Im μ), shift (−Re μ)
uniform float uLaceRot;      // slow rotation of the lace ring (rad)
uniform float uLaceN;        // repeats around the ring (integer)
uniform float uLace;         // lace opacity 0–1

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { float d = dot(b, b); return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / d; }
vec2 mob(vec4 ab, vec4 cd, vec2 z) { return cdiv(cmul(ab.xy, z) + ab.zw, cmul(cd.xy, z) + cd.zw); }
float atanh_(float x) { return 0.5 * log((1.0 + x) / (1.0 - x)); }
float hdist(vec2 z, vec2 w) {
  vec2 den = vec2(1.0, 0.0) - cmul(vec2(z.x, -z.y), w);
  return 2.0 * atanh_(min(0.999999, length(z - w) / length(den)));
}

vec3 palette(float k) {
  // smooth walk through the 5 palette colours
  float f = mod(k, 5.0);
  int i = int(floor(f));
  float t = smoothstep(0.0, 1.0, fract(f));
  vec3 a = uPal[0], b = uPal[1];
  if (i == 0) { a = uPal[0]; b = uPal[1]; }
  else if (i == 1) { a = uPal[1]; b = uPal[2]; }
  else if (i == 2) { a = uPal[2]; b = uPal[3]; }
  else if (i == 3) { a = uPal[3]; b = uPal[4]; }
  else { a = uPal[4]; b = uPal[0]; }
  return mix(a, b, t);
}

vec3 atLum(vec3 c, float L) {
  float l = max(dot(c, LUMA), 1e-4);
  c *= L / l;
  float m = max(c.r, max(c.g, c.b));
  if (m > 0.92) c = mix(vec3(L), c, (0.92 - L) / max(m - L, 1e-4));
  return c;
}

// Fold z into the fundamental triangle of one tiling. Returns folded z; out: reflections parity,
// number of circle inversions (ring depth), conformal scale factor.
vec2 foldTri(vec2 z, vec4 tri, vec2 cen, out float parity, out float depth, out float scale) {
  float wedge = tri.x;
  float R2 = tri.w * tri.w;
  parity = 0.0; depth = 0.0; scale = 1.0;
  for (int i = 0; i < 32; i++) {
    float a = atan(z.y, z.x);
    if (a < 0.0) a += 2.0 * PI;
    float k = floor(a / wedge);
    if (k > 0.0) {
      float m = length(z);
      float a2 = mod(k, 2.0) < 0.5 ? a - k * wedge : (k + 1.0) * wedge - a;
      z = m * vec2(cos(a2), sin(a2));
      parity += k;
    }
    vec2 w = z - cen;
    float l2 = dot(w, w);
    if (l2 < R2) {
      z = cen + w * (R2 / l2);
      scale *= R2 / l2;
      parity += 1.0;
      depth += 1.0;
    } else if (k < 0.5) {
      break;
    }
  }
  parity = mod(parity, 2.0);
  return z;
}

// One tiling at disk point zm. `pix` = disk units per pixel; `speed` = hyperbolic units per second
// of the Möbius flow here. Returns (chroma rgb at luminance 0.2, luminance factor) and, in `vis`,
// the detail visibility (0 where tiles are below ~8 px or would change faster than ~0.6 Hz).
vec4 tiling(vec2 zm, float pix, float speed, vec4 tri, vec2 cen, vec4 meta, out float vis) {
  float parity, depth, scale;
  vec2 z = foldTri(zm, tri, cen, parity, depth, scale);
  vec2 n2 = tri.yz;
  float R = tri.w;
  float px = pix * scale;                       // folded units per pixel
  float dCirc = length(z - cen) - R;            // polygon edge (circle mirror)
  float dL1 = z.y;                              // spokes (line mirrors)
  float dL2 = -dot(z, n2);
  float toEdge = length(z) / max(length(z) + dCirc, 1e-4);   // 0 at the polygon centre, 1 at its edge
  float hueK = depth + 0.12 * parity;
  vec3 base = palette(hueK + 0.15 * sin(uTime * 0.05));
  // luminance factor relative to the local base luminance; bounded to [0.7, 1.5] (local max/min ≤ 2.14:
  // Michelson ≤ 0.36 + base drift). Jewel cells: a glowing core, a darker band, a luminous rim.
  float F = 0.74 + 0.34 * (1.0 - toEdge * toEdge) + 0.03 * (parity - 0.5);
  float eC = 1.0 - smoothstep(0.0, 2.2, dCirc / px);
  float eS = 1.0 - smoothstep(0.0, 1.2, min(dL1, dL2) / px);
  float edgeGlow = exp(-dCirc / max(meta.x * 0.1, px * 1.5));
  F += 0.24 * edgeGlow * (0.6 + 0.4 * uPulse) + 0.42 * eC;
  F -= 0.06 * eS * (1.0 - eC);
  // a petal on every spoke: each polygon becomes a small flower
  float f = atan(z.y, z.x) / tri.x;                                // 0 on mirror 1 .. 1 on mirror 2
  float wP = 0.8 * sqrt(max(0.0, 1.0 - toEdge * toEdge * 1.1));
  float fpx = (f - wP) * tri.x * length(z) / px;                   // signed distance to the petal outline, px
  float petalIn = smoothstep(1.2, -1.2, fpx);
  float petalLine = exp(-abs(fpx) / 1.3);
  F += 0.26 * petalIn * (1.0 - toEdge) - 0.13 * petalLine * (1.0 - petalIn);
  vec3 chroma = mix(base, palette(hueK + 2.0), 0.4 * petalIn * (1.0 - toEdge));
  float ratio = px / max(meta.x, 1e-4);
  float aa = smoothstep(0.14, 0.05, ratio);
  float freq = speed / max(meta.y, 1e-3);
  vis = aa * smoothstep(1.2, 0.6, freq);
  return vec4(chroma, clamp(F, 0.7, 1.5));
}

// Jos Leys' distance estimate to the limit set of the Maskit group a(z) = μ + 1/z, b(z) = z + 2 with
// μ = −shift + i·height (as popularised in Indra's Pearls renderings). z in strip coordinates.
float kleinDE(vec2 z, float a, float b, out float its) {
  vec2 lz = z + 1.0, llz = z - 1.0;
  float df = 1.0;
  float f = b >= 0.0 ? 1.0 : -1.0;
  its = 0.0;
  for (int i = 0; i < 48; i++) {
    z.x += b / a * z.y;
    z.x = mod(z.x + 1.0, 2.0) - 1.0;
    z.x -= b / a * z.y;
    float s = z.x + b * 0.5;
    if (z.y >= a * 0.5 + f * (2.0 * a - 1.95) / 4.0 * sign(s) * (1.0 - exp(-(7.2 - (1.95 - a) * 15.0) * abs(s)))) {
      z = vec2(-b, a) - z;
    }
    float ir = 1.0 / dot(z, z);
    z *= -ir;
    z.x = -b - z.x;
    z.y = a + z.y;
    df *= ir;
    its += 1.0;
    if (dot(z - llz, z - llz) < 1e-6) break;
    llz = lz; lz = z;
  }
  float y = min(z.y, a - z.y);
  return min(y, 0.3) / max(df, 2.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0 + uLook * vec2(0.6, 0.6);
  float rho = length(p);
  float phi = atan(p.y, p.x);

  // neural field, sampled through the retino-cortical (log-polar) map
  float fieldAct = 0.5;
  if (uHasField > 0.5) {
    vec2 fuv = vec2((log(rho + 0.05) - log(0.05)) / (log(2.2) - log(0.05)), phi / (2.0 * PI) + 0.5);
    fieldAct = texture2D(uField, fuv).r;
  }

  // ---- flower / dome sheet: petals scallop the outer rings, the sheet compresses towards the rim
  float petal = cos(uPetals * phi * 0.5);
  float petalAmt = 0.07 * smoothstep(0.25, 1.1, rho) * (0.8 + 0.4 * uIntensity);
  float rhoW = rho * (1.0 + petalAmt * abs(petal) - 0.04 * (fieldAct - 0.5));
  float rd = tanh(uZoom * rhoW);
  vec2 zd = rd * vec2(cos(phi), sin(phi));

  // dome shading: the sheet bulges towards the viewer in the middle and folds inward at the rim
  float hgt = 1.0 - rd * rd;                                        // ~ height of the dome
  float valley = smoothstep(0.35, 1.0, rd) * (1.0 - abs(petal));    // petal valleys fold in
  vec2 grad = vec2(cos(phi), sin(phi)) * (-2.0 * rd) * uZoom;
  vec3 nrm = normalize(vec3(-grad * 0.35, 1.0));
  float shade = (0.93 + 0.1 * dot(nrm, normalize(vec3(-0.4, 0.5, 0.8)))) * (1.0 - 0.12 * valley);

  // ---- Möbius motion
  vec2 zm = mob(uMobAB, uMobCD, zd);
  vec2 zn = mob(uMobAB2, uMobCD2, zd);
  float speed = hdist(zm, zn) / 0.25;                               // hyperbolic units per second
  vec2 dzx = dFdx(zm), dzy = dFdy(zm);
  float pix = max(length(dzx), length(dzy)) + 1e-6;

  // ---- base luminance: slowly varying (≤ ~1.3x over 100 px), so every local contrast below is a
  // bounded factor of it (max/min ≤ ~1.9 in any neighbourhood: under the 0.45 guard / 0.5 cap)
  // dark base (docs/VISUAL_DIRECTION.md): ≈ 0.06–0.09 so saturated hues stay saturated at their luminance
  float B = 0.7 * (0.15 * exp(-0.85 * max(0.0, rho - 0.8)) - 0.046 * smoothstep(1.35, 2.0, rho)) * (0.92 + 0.16 * fieldAct) * shade;

  // where tile detail cannot be resolved (rim, fast flow) the sheet shows a smooth radial palette
  // gradient instead of the palette mean (the mean of saturated hues is grey: a veil)
  vec4 fill = vec4(palette(1.0 + 2.2 * rd + 0.4 * fieldAct + 0.02 * uTime), 0.9);
  vec4 tA = fill, tB = fill;
  float vA = 0.0, vB = 0.0;
  if (uMix < 0.999) tA = tiling(zm, pix, speed, uTriA, uCenA, uMetaA, vA);
  if (uMix > 0.001) tB = tiling(zm, pix, speed, uTriB, uCenB, uMetaB, vB);
  vec4 cA = mix(fill, tA, vA);
  vec4 cB = mix(fill, tB, vB);
  vec4 t = mix(cA, cB, uMix);
  vec3 chroma = t.rgb;
  float F = t.a;

  // ---- Kleinian lace ring (Maskit limit set wrapped around the flower by the conformal log map):
  // circle outlines as fine bright filaments, the round components of the ordinary set as pearls.
  if (uLace > 0.001) {
    float rho0 = 1.3 * (1.0 + 0.025 * uPulse);
    float k = uLaceN / PI;
    vec2 s = vec2(k * (phi + uLaceRot), -k * log(rho / rho0));     // strip coordinates, y=0 at rho0
    float a = uKlein.x;
    if (s.y > -0.6 && s.y < a + 0.6) {
      float its;
      float de = kleinDE(s, a, uKlein.y, its);
      float toPx = 1.0 / k * rho / (2.0 / uRes.y);
      float dpx = abs(de) * toPx;                                   // distance to the limit set, pixels
      float core = 1.0 - smoothstep(0.3, 1.5, dpx);
      float glow = exp(-dpx / 5.0);
      float band = smoothstep(-0.5, 0.1, s.y) * smoothstep(a + 0.5, a - 0.1, s.y);
      float amt = band * uLace;
      vec3 laceCol = mix(uPal[1], vec3(0.2), 0.2);
      float Fl;
      vec3 cl;
      if (de < 0.0) {
        float rim = exp(-dpx / 9.0);
        Fl = 0.86 + 0.2 * rim;                                      // pearl body with a soft inner rim
        cl = palette(1.0 + 0.5 * sin(its * 0.37));
      } else {
        Fl = mix(0.85, F, 0.5);                                     // interstices sink back a little
        cl = chroma;
      }
      Fl = mix(Fl, 1.5, core) + 0.3 * glow * (1.0 - core) * (0.75 + 0.25 * uPulse);
      cl = mix(cl, laceCol, max(core, 0.5 * glow));
      F = mix(F, clamp(Fl, 0.7, 1.5), amt);
      chroma = mix(chroma, cl, amt);
    }
  }
  vec3 col = atLum(chroma, B * F);

  // ---- difficult passage: harsher hue, deeper shadows (never brighter)
  if (uChallenge > 0.001) {
    float L0 = dot(col, LUMA);
    vec3 harsh = atLum(col.brg * vec3(1.0, 0.75, 1.0), L0 * (0.9 - 0.15 * uChallenge));
    col = mix(col, harsh, 0.7 * uChallenge);
  }

  // no near-white: luminance cap; static dither against banding
  float L1 = dot(col, LUMA);
  if (L1 > 0.3) col *= 0.3 / L1;
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * 0.5;
  gl_FragColor = vec4(max(col, 0.0), clamp(uWeight, 0.0, 1.0));
}
