// Room layer: surface shading of the displaced room (BUILD.md 11.3). Requires NOISE_GLSL (layers/noise.ts).
// Drifting: texture coordinates advected by a curl-noise flow (two-phase flow map, crossfaded).
// Breathing: a slow texture-space swell. Symmetrical texture repetition: wallpaper-group folding in
// texture space, masked to where the neural field (state.fieldTexture) is active. Colour: saturation
// and slight hue rotation rising with v. Writes LINEAR RGB. No luminance modulation over time.
varying vec2 vUv;
varying float vDepth;
uniform sampler2D uImage;
uniform float uImgAspect;
uniform float uFxTime;
uniform float uPulse;
uniform float uWarp;
uniform float uDrift;
uniform sampler2D uFlow;     // advected texture-coordinate offsets (roomFlow.frag.glsl), image uv units
uniform float uTile;
uniform float uTileScale;
uniform vec2 uTileOrigin;
uniform int uGroup;          // 0 pmm, 1 p4m, 2 p6m (roomGeometry.ts WALLPAPER_GROUPS)
uniform float uSat;
uniform float uHue;
uniform float uHueHz;
uniform float uPalette;
uniform vec3 uPalTint;
uniform float uChallenge;
uniform sampler2D uField;
uniform float uHasField;
uniform float uMaskHz;
uniform vec2 uResolution;
uniform float uViewAspect;
uniform float uKind;

const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;

vec2 toImg(vec2 q) { return vec2(q.x / uImgAspect, q.y); }

// Neural-field activity at a screen position (centred, units of the screen height), through the same
// retino-cortical map as the form constants (fieldSample.glsl: x = log eccentricity, y = angle).
float fieldAt(vec2 p) { return texture(uField, fieldUV(p)).r; }

// Where the field is ACTIVE: local pattern energy (mean |a - 0.5| over a small disc; the uniform,
// sub-threshold field sits at a = 0.5), times slow large-scale blobs so the repetition appears in
// patches. Before the neural field exists, the blobs alone.
float roomField(vec2 p, out float blob) {
  blob = 0.5 + 0.5 * hs_fbm3(vec3(p * 1.1, uFxTime * uMaskHz));
  float patches = smoothstep(0.3, 0.75, blob);
  if (uHasField < 0.5) return patches;
  // two rings of taps: a wide, smooth estimate of local pattern energy (no domain-wall cracks)
  float e = 0.0;
  for (int i = 0; i < 6; i++) {
    float an = float(i) * 1.0471976 + 0.3;
    e += abs(fieldAt(p + 0.06 * vec2(cos(an), sin(an))) - 0.5);
    e += abs(fieldAt(p + 0.13 * vec2(cos(an + 0.52), sin(an + 0.52))) - 0.5);
  }
  e = e / 12.0 * 2.0;
  return clamp(smoothstep(0.1, 0.5, e) * patches * 1.2, 0.0, 1.0);
}

float tri1(float x) { return abs(x - floor(x + 0.5)); }

vec2 foldWallpaper(vec2 g, out vec2 centre) {
  centre = vec2(0.0);
  if (uGroup == 2) {
    // p6m: hexagonal lattice a1 = (1,0), a2 = (1/2, sqrt3/2); D6 fold about the nearest centre
    const float RY = 1.7320508;
    vec2 a = vec2(floor(g.x + 0.5), floor(g.y / RY + 0.5) * RY);
    vec2 b = vec2(floor(g.x) + 0.5, floor((g.y - RY * 0.5) / RY + 0.5) * RY + RY * 0.5);
    centre = dot(g - a, g - a) <= dot(g - b, g - b) ? a : b;
    vec2 l = g - centre;
    float r = length(l);
    float th = atan(l.y, l.x);
    const float W = 1.04719755;
    th = th - W * floor(th / W);
    if (th > W * 0.5) th = W - th;
    return vec2(cos(th), sin(th)) * r;
  }
  vec2 f = vec2(tri1(g.x), tri1(g.y));
  if (uGroup == 1 && f.y > f.x) f = f.yx;
  return f;
}

// explicit gradients from the unfolded coordinates: folds and flow offsets must not change the mip level
vec2 gQx, gQy;
vec3 img(vec2 q) { return textureGrad(uImage, toImg(q), toImg(gQx), toImg(gQy)).rgb; }

// one repetition lattice: every cell of a 2x2-cell block repeats (by the wallpaper fold) the motif at
// the block centre; `off` shifts the block grid by whole cells
vec3 tiledAt(vec2 g, vec2 off, vec2 fold, vec2 shift) {
  vec2 block = floor((g - off) * 0.5) * 2.0 + 1.0 + off;
  return img(uTileOrigin + (block + fold) * uTileScale + shift);
}

// four block lattices offset by one cell, blended near block edges: seamless repetition
vec3 tiledSample(vec2 q, vec2 shift) {
  vec2 g = (q - uTileOrigin) / uTileScale;
  vec2 centre;
  vec2 fold = foldWallpaper(g, centre);
  vec2 fr = fract(g * 0.5);
  vec2 b0 = min(fr, 1.0 - fr);
  vec2 w0 = smoothstep(0.12, 0.3, b0);
  vec2 w1 = 1.0 - w0;
  vec3 c = vec3(0.0);
  if (w0.x * w0.y > 0.001) c += w0.x * w0.y * tiledAt(g, vec2(0.0, 0.0), fold, shift);
  if (w1.x * w0.y > 0.001) c += w1.x * w0.y * tiledAt(g, vec2(1.0, 0.0), fold, shift);
  if (w0.x * w1.y > 0.001) c += w0.x * w1.y * tiledAt(g, vec2(0.0, 1.0), fold, shift);
  if (w1.x * w1.y > 0.001) c += w1.x * w1.y * tiledAt(g, vec2(1.0, 1.0), fold, shift);
  return c;
}

// Safety at source (BUILD.md 4.1): the repetition makes the texture PERIODIC, so its contrast is
// compressed in the log domain towards the local mean (a 60:1 photo range becomes about 2.8:1,
// Michelson < 0.5).
vec3 compressContrast(vec3 c, float m, float g) {
  float y = max(dot(c, LUMW), 1e-4);
  float y2 = m * pow(max(y, 0.004) / m, g);
  return c * (y2 / y);
}

vec3 hueRotate(vec3 c, float a) {
  // rotation about the grey axis in YIQ
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c;
  float cs = cos(a), sn = sin(a);
  yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
  return toRGB * yiq;
}

void main() {
  vec2 sp = (gl_FragCoord.xy / uResolution - 0.5) * vec2(uViewAspect, 1.0);
  float blob;
  float field = roomField(sp, blob);
  float t = uFxTime;
  vec2 q = vec2(vUv.x * uImgAspect, vUv.y);
  gQx = dFdx(q);
  gQy = dFdy(q);
  float sc = uKind > 0.5 ? 2.5 : 1.0;   // panorama: features per unit of the wider texture

  // the field gently gates where things move most (coupling rule)
  float gate = 0.6 + 0.8 * field;
  // texture-space breathing swell
  vec2 w = vec2(hs_snoise3(vec3(q * 2.2 * sc, t * 0.06)), hs_snoise3(vec3(q * 2.2 * sc + 7.3, t * 0.06)));
  vec2 swell = w * uWarp * 0.011 * (0.6 + 0.4 * uPulse) * gate;
  // drifting: texture coordinates advected by the curl-noise flow (offsets from roomFlow.frag.glsl)
  vec2 off = texture(uFlow, vUv).xy;
  vec2 drift = vec2(off.x * uImgAspect, off.y) * uDrift * gate;
  vec3 col = img(q + swell - drift);

  // symmetrical texture repetition, masked to where the field is active
  float tileAmt = uTile * field;
  if (tileAmt > 0.002) {
    // patches are either repeated or not, with a soft rim: half-blended patches read as ghosting
    float m = max(dot(textureLod(uImage, toImg(q), 5.0).rgb, LUMW), 0.02);
    vec3 tiled = compressContrast(tiledSample(q + swell, -0.5 * drift), m, 0.3);
    col = mix(col, tiled, smoothstep(0.3, 0.6, tileAmt));
  }

  // colour: saturation and a slight, slowly wandering hue rotation rising with v
  float lum = dot(col, LUMW);
  col = max(mix(vec3(lum), col, uSat), 0.0);
  float hw = hs_snoise3(vec3(sp * 0.8, t * uHueHz));
  col = max(hueRotate(col, uHue * (0.35 + 0.65 * hw) + uHue * 0.5 * (field - 0.5)), 0.0);
  vec3 tint = uPalTint / max(dot(uPalTint, LUMW), 1e-3) * dot(col, LUMW);
  col = mix(col, tint, uPalette);
  // difficult passage: harsher and cooler, never brighter
  float l2 = dot(col, LUMW);
  col = mix(col, vec3(l2) * vec3(0.78, 0.92, 1.12), 0.45 * uChallenge);
  col *= 1.0 - 0.15 * uChallenge;
  gl_FragColor = vec4(min(col, vec3(0.92)), 1.0);
}
