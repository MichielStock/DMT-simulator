// Retino-cortical rendering of the neural field (BUILD.md 11.4): every screen pixel at (r, theta)
// from the view centre samples the cortical field at (log(r + r0), theta). Stripes along x -> rings
// and tunnels, along y -> radial funnels, oblique -> spirals, hexagons -> lattices.
// SAFETY AT SOURCE (BUILD.md 4.1):
//  * soft edges: the field is a Gaussian-smoothed variable (edge width > 2 cells), sampled bilinearly;
//  * anti-aliasing: where a wavelength covers fewer than ~4 screen pixels (the fovea) the pattern
//    fades to its mean, so no moire or shimmer;
//  * contrast cap: activity a is in [0, 1] by construction and is mapped to a luminance in
//    [uLmin, uLmax] with uLmax / uLmin = 2.2 -> Michelson contrast <= 0.375 < 0.5 for any field state,
//    any palette (luminance is normalised per pixel, out-of-gamut colours are desaturated at
//    constant luminance) and any pulse (a common multiplicative factor does not change contrast);
//  * drift: applied in the field texture at <= 0.3 cycles/s (TS side), far below 2 Hz.
in vec2 vUv;
uniform sampler2D uField;
uniform float uAspect;
uniform vec2 uCentre;          // view centre offset (mouse look), screen units
uniform float uR0;
uniform float uX0;             // log r at field x = 0
uniform float uScale;          // radial scale (challenge: tunnel narrows)
uniform float uPxH;            // scene height in pixels
uniform float uLambda;         // wavelength (cells)
uniform vec3 uCols[6];         // linear palette colours (gradient order)
uniform int uNCols;
uniform float uLmin;
uniform float uLmax;
uniform float uBright;         // pulse factor (multiplicative)
uniform float uHueShift;       // slow palette walk (0-1)
uniform float uChallenge;
uniform float uDepth;          // 0-1 from visual intensity (3 -> 9): detail and filament glow
uniform vec3 uAccent;          // most chromatic palette colour (edge filaments)
uniform vec3 uDeep;            // deep colour of the low-activity phase
uniform float uAlpha;
out vec4 outColor;

const float TAU_ = 6.2831853;

vec3 gradient(float s) {
  // s in [0, 1] -> piecewise-linear walk through the palette colours (no wrap: no hard edges)
  float x = clamp(s, 0.0, 1.0) * float(uNCols - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNCols - 1);
  vec3 a = uCols[0], b = uCols[0];
  for (int k = 0; k < 6; k++) { if (k == i) a = uCols[k]; if (k == j) b = uCols[k]; }
  return mix(a, b, smoothstep(0.0, 1.0, x - float(i)));
}

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) - uCentre;
  p *= uScale;
  float r = length(p) + 1e-5;
  float th = atan(p.y, p.x);
  float lx = log(r + uR0);
  vec2 fc = vec2((lx - uX0) / TAU_, th / TAU_);
  vec4 fld = texture(uField, fc);
  float a = fld.r;
  // footprint of one screen pixel in cells (conformal map: same along x and y)
  float cellsPerPx = float(FIELD_N) / TAU_ * uScale / (uPxH * (r + uR0));
  float resolve = 1.0 - smoothstep(uLambda / 6.0, uLambda / 3.0, cellsPerPx);
  a = mix(0.5, a, resolve);
  // colour: hue from eccentricity and a slow walk for the active phase, a deep palette colour for
  // the quiet phase, luminous filaments of the accent colour along the band edges (chroma only:
  // luminance below comes from activity alone, so the filaments add no luminance contrast)
  float tri = abs(fract(0.3 * lx + uHueShift) * 2.0 - 1.0);
  vec3 hi = gradient(tri);
  // self-similar detail: the same field at 3x the cortical frequency tints the active bands
  // (chroma only, faded where it cannot be resolved)
  float a3 = texture(uField, fc * 3.0 + vec2(0.37, 0.11)).r;
  float res3 = 1.0 - smoothstep(uLambda / 18.0, uLambda / 9.0, cellsPerPx);
  hi = mix(hi, gradient(abs(fract(0.5 * tri + 0.6) * 2.0 - 1.0)), (0.15 + 0.35 * uDepth) * res3 * smoothstep(0.3, 0.9, a3));
  float sa = smoothstep(0.15, 0.85, a);
  // troughs: the deep colour, half-way to neutral, so the dark phase reads as dark (a saturated
  // violet at the same luminance reads as a bright fill) and the ridges carry the colour
  vec3 deep = mix(uDeep, vec3(lum(uDeep)), 0.55);
  vec3 c = mix(deep, hi, sa);
  float edge = exp(-pow((a - 0.36) / 0.12, 2.0)) * resolve;
  c = mix(c, uAccent, (0.25 + 0.3 * uDepth) * edge);
  c = mix(c, c.bgr * vec3(0.9, 0.8, 1.0), 0.45 * uChallenge);   // harsher, colder; never brighter
  // log-domain ridge profile: dark troughs, ridges that read as light (glowing crests), same
  // [uLmin, uLmax] window, so the Michelson bound above is unchanged
  // ridge "depth": the mean activity on a ring of a quarter wavelength around the sample is high only
  // near the middle of an active band, so a * depth peaks along the crest (a glowing tube) and falls
  // off smoothly towards the band edges
  float rr = 0.25 * uLambda / float(FIELD_N);
  float ring = 0.0;
  for (int k = 0; k < 6; k++) {
    float an = float(k) * 1.0471976 + 0.3;
    ring += texture(uField, fc + rr * vec2(cos(an), sin(an))).r;
  }
  ring = mix(0.5, ring / 6.0, resolve);
  float prof = smoothstep(0.0, 1.0, a) * mix(0.35, 1.0, smoothstep(0.25, 0.95, ring));
  float L = uLmin * pow(uLmax / uLmin, pow(prof, 1.2));
  // the light at the end of the tunnel: a smooth, non-periodic radial falloff (common factor
  // per region, so the local pattern contrast is unchanged)
  float glow = mix(1.15, 0.72, smoothstep(0.02, 1.0, r / uScale));
  float lc = max(lum(c), 1e-4);
  vec3 col = c * (L / lc);
  float m = max(col.r, max(col.g, col.b));
  if (m > 1.0) col = mix(col, vec3(L), (m - 1.0) / max(m - L, 1e-4));   // desaturate at constant L
  col *= uBright * glow;
  outColor = vec4(col, uAlpha);
}
