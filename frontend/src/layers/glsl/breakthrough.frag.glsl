// Breakthrough (BUILD.md 11.7, docs/VISUAL_DIRECTION.md 3): "generated worlds, framed".
// One full-screen pass, LINEAR RGB out, alpha = layer weight:
//   1. world   : the session's equirect panoramas (sRGB textures, decoded to linear by the sampler) on an
//                inside sphere looked at with state.look + a slow yaw drift; luminance-derived parallax,
//                flow-warped crossfade between worlds (per-pixel melt), mip bloom, saturation lift,
//                slow chromatic breathing (<= 0.07 Hz), neural-field shimmer on the world's edges.
//                Procedural fallback: an emissive icosahedral lattice dome with drifting lights.
//   2. entity  : sprite billboard (variants A/B, flow-warped morph), luminous rim from the alpha's mip
//                halo, n-fold kaleidoscopic echoes (two rings, fading), behaviour visuals (object, sparks).
//   3. message : 2-4 rotating rings of procedural glyphs (atlas) streaming from the entity.
//   4. frame   : a rotating polygonal mandala at the periphery (stained-glass panels within a 1:2.4
//                luminance band, thin glowing edges), opening as the veil lifts and v rises.
// Safety at source (4.1): broad periodic structure (frame panels) within lMin..lMin*2.4; thin edges only
// may reach 0.9; rotations capped so edges pass a pixel at <= 0.35 Hz (<= 1.6 Hz difficult); breathing
// <= 0.07 Hz; crossfades >= 1 s per pixel; luminance ceiling 0.9; no near-white areas.
precision highp float;
varying vec2 vUv;

uniform vec2 uRes;
uniform float uWeight;
uniform float uTime;
uniform float uVI;          // visual intensity 0-1
uniform float uVeil;        // 0 at latch -> 1 after VEIL_S
uniform float uAperture;    // in half-heights
uniform float uDim;         // world brightness (descent)
uniform vec2 uLook;         // yaw, pitch (rad) incl. drift
uniform vec3 uCamOff;       // parallax camera offset

uniform sampler2D uWorldA;
uniform sampler2D uWorldB;
uniform float uMix;
uniform float uHasWorld;    // 1 = images, 0 = procedural interior
uniform vec2 uWorldLod;     // max lod of A, B

uniform vec3 uPal[5];       // jewel hues (max channel 1)
uniform vec3 uDeep;         // deep base hue (max channel 1)
uniform vec3 uAccA;
uniform vec3 uAccB;
uniform sampler2D uField;
uniform float uHasField;
uniform float uChallenge;
uniform float uRelief;

uniform float uFold;        // frame n-fold
uniform vec4 uBandRot;      // rotation angles (rad) of band families 0..3
uniform vec4 uBandRot2;     // 4..7
uniform float uFrameDensity;
uniform vec2 uMem;          // membrane flow phase (cells), rotation (rad): integrated on the CPU
uniform vec3 uFrameLum;     // lMin, lMax, edge
uniform float uSeed;

uniform float uEnt;         // entity presence * intensity
uniform vec2 uEntPos;       // centre, half-height units
uniform float uEntSize;     // half-size, half-heights
uniform sampler2D uEntA;
uniform sampler2D uEntB;
uniform float uEntMix;
uniform float uEntEcho;     // n
uniform float uEntSway;     // rad
uniform float uEntPulse;    // 0-1 response to interaction
uniform float uEntStern;    // challenge disposition
uniform float uObj;         // present object 0-1
uniform float uSparks;
uniform vec3 uEntGlow;

uniform float uMsg;         // message intensity 0-1
uniform float uMsgT;        // seconds since shown
uniform float uRings;       // 2-4
uniform vec4 uRingRot;      // per ring angle (rad)
uniform sampler2D uAtlas;
uniform float uGlyphCount;
uniform float uGlyphSeed;
uniform float uKeyPulse;
uniform float uLookVel;

const float PI = 3.14159265;
const float TAU = 6.28318531;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float lum(vec3 c) { return dot(c, LUMA); }
float hash1(float n) { return fract(sin(n * 127.1 + uSeed * 0.0137) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 0.0137) * 43758.5453); }
vec3 atLum(vec3 hue, float L) {
  vec3 c = hue * (L / max(1e-4, lum(hue)));
  float m = max(c.r, max(c.g, c.b));
  return m > 1.0 ? c / m : c;     // out of gamut: darker, never paler
}
// sine-free lattice hash (stable at large coordinates: no blocky precision artefacts in the fbm octaves)
float hashL(vec3 p) {
  p = fract(p * 0.1031 + uSeed * 0.0071);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  const vec2 o = vec2(0.0, 1.0);
  float a = mix(mix(hashL(i), hashL(i + o.yxx), f.x), mix(hashL(i + o.xyx), hashL(i + o.yyx), f.x), f.y);
  float b = mix(mix(hashL(i + o.xxy), hashL(i + o.yxy), f.x), mix(hashL(i + o.xyy), hashL(i + o.yyy), f.x), f.y);
  return mix(a, b, f.z);
}
vec3 hueRot(vec3 c, float a) {
  // rotation about the grey axis (luminance roughly kept)
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec3 palAt(float x) {
  x = fract(x) * 5.0;
  int i = int(floor(x));
  float f = smoothstep(0.75, 1.0, fract(x));   // mostly pure palette hues (mixing complementaries greys them)
  vec3 a = uPal[0], b = uPal[1];
  if (i == 0) { a = uPal[0]; b = uPal[1]; }
  else if (i == 1) { a = uPal[1]; b = uPal[2]; }
  else if (i == 2) { a = uPal[2]; b = uPal[3]; }
  else if (i == 3) { a = uPal[3]; b = uPal[4]; }
  else { a = uPal[4]; b = uPal[0]; }
  return mix(a, b, f);
}
// difficult passage: two acidic complementary colours on black (luminance kept)
const vec3 HARSH_A = vec3(0.30, 1.0, 0.12);   // acid green
const vec3 HARSH_B = vec3(0.52, 0.10, 1.0);   // electric violet
const vec3 WARM = vec3(1.0, 0.58, 0.22);      // relief gold
const vec3 HARSH_M = vec3(1.0, 0.12, 0.78);   // acid magenta (red share 0.53)
vec3 harshen(vec3 c, float k) {
  float L = lum(c);
  vec3 h = mix(atLum(HARSH_B, L), atLum(HARSH_A, L), smoothstep(0.1, 0.14, L));   // a hard switch: no grey mid-mix
  return mix(c, h, k);
}

// ---------------------------------------------------------------- world
vec2 equirect(vec3 d) {
  return vec2(atan(d.x, -d.z) / TAU + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
}
vec3 sampleImg(sampler2D t, vec3 d, float lod) {
  return textureLod(t, equirect(d), lod).rgb;
}

// procedural interior: emissive icosahedral lattice dome + drifting lights (palette, dark base)
vec3 icoFold(vec3 p) {
  const vec3 n = vec3(-0.5, -0.809017, 0.309017);
  for (int i = 0; i < 3; i++) {
    p = abs(p);
    p -= 2.0 * min(0.0, dot(p, n)) * n;
  }
  return p;
}
float latticeLines(vec3 d, float w) {
  const vec3 n = vec3(-0.5, -0.809017, 0.309017);
  vec3 p = icoFold(d);
  float e = min(min(abs(p.x), abs(p.y)), abs(dot(p, n)));
  return e;
}
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }

float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.03 + 3.1; a *= 0.5; }
  return s / 0.9375;
}
// procedural interior ("a starfield folded into a vast spiralling lattice, galaxies like jewels"):
// deep palette base, two luminous nebula layers in palette hues, a log-spiral lattice of light (two
// counter-wound arm families, broken up by noise: aperiodic), jewel galaxies with bloom, a starfield,
// and the emissive icosahedral lattice dome as the near shell.
vec3 proceduralWorld(vec3 d) {
  float t = uTime;
  vec3 c = atLum(uDeep, 0.012 + 0.01 * exp(-abs(d.y) * 3.0));
  // nebulae (slow drift)
  vec3 dn = rotY(t * 0.006) * d;
  float n1 = fbm3(dn * 1.5 + 2.0);
  float n2 = fbm3(dn * 3.1 + 9.0);
  float neb1 = pow(smoothstep(0.46, 0.8, n1), 1.6);
  float neb2 = pow(smoothstep(0.55, 0.85, n2), 1.3) * (0.4 + 0.6 * smoothstep(0.35, 0.6, n1));
  c += atLum(palAt(n2 * 0.9 + 0.1), 0.42 * neb1);
  c += atLum(palAt(n1 * 0.7 + 0.55), 0.2 * neb2);
  // spiral lattice around the forward axis: two log-spiral arm families wound opposite ways
  vec3 ds = rotX(-0.25) * d;
  float psi = acos(clamp(-ds.z, -1.0, 1.0)) + 0.02;   // angle from the forward pole
  float phi = atan(ds.y, ds.x);
  float L = log(psi);
  float armA = pow(0.5 + 0.5 * cos(5.0 * phi - 7.0 * L + t * 0.05), 6.0);
  float armB = pow(0.5 + 0.5 * cos(8.0 * phi + 9.0 * L - t * 0.035), 8.0);
  float brk = smoothstep(0.35, 0.7, fbm3(ds * 4.0 + 1.0));      // breaks the arms into knots
  float spiral = (armA * 0.7 + armB * 0.5) * brk * smoothstep(1.9, 0.3, psi);
  c += atLum(palAt(L * 0.3 + 0.2 + 0.3 * armB), 0.34 * spiral);
  float knot = armA * armB * brk;
  c += atLum(uAccA, 0.75) * smoothstep(0.35, 0.8, knot);
  // starfield (cells on the sphere)
  vec3 sp = d * 90.0;
  vec3 ci = floor(sp);
  float hs = hashL(ci);
  vec3 so = ci + 0.5 + 0.35 * (vec3(hashL(ci + 11.0), hashL(ci + 23.0), hashL(ci + 37.0)) - 0.5);
  float sd = length(sp - so);
  c += atLum(palAt(hs * 3.0), 0.7) * exp(-sd * sd / 0.012) * step(0.86, hs);
  // jewel galaxies: small bright cores with a coloured disc and bloom
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float az = hash1(fi * 7.1) * TAU + t * 0.004 * (mod(fi, 2.0) * 2.0 - 1.0);
    float el = (hash1(fi * 3.3) - 0.5) * 1.3;
    vec3 gd = normalize(vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el)));
    float a = max(0.0, 1.0 - dot(d, gd));
    float sz = 0.6 + 0.8 * hash1(fi * 1.9);
    vec3 gc = uPal[i - 5 * (i / 5)];
    // tiny spiral disc
    vec3 tA = normalize(cross(gd, vec3(0.0, 1.0, 0.0)));
    vec3 tB = cross(gd, tA);
    vec2 q = vec2(dot(d, tA), dot(d, tB)) / (0.05 * sz);
    float qr = length(q);
    float disc = exp(-qr * 1.6) * (0.55 + 0.45 * cos(2.0 * atan(q.y, q.x) - 4.0 * log(qr + 0.05) + t * 0.1));
    c += atLum(gc, 0.85) * exp(-a / (0.00003 * sz)) + atLum(gc, 0.3) * disc * step(qr, 4.0)
       + atLum(gc, 0.07) * exp(-a / (0.006 * sz));
  }
  // near shell: emissive icosahedral lattice filaments, light running along them
  vec3 d1 = rotY(t * 0.017) * d;
  float e1 = latticeLines(d1, 0.0);
  float line = exp(-e1 * e1 / 0.000005);
  vec3 lh = palAt(noise3(d1 * 1.7) * 0.8 + 0.5);
  float run = 0.5 + 0.5 * sin(dot(d1, vec3(7.0, 5.0, 3.0)) - t * 0.6);
  c += (atLum(lh, 0.55) * line + atLum(lh, 0.04) * exp(-e1 / 0.012)) * run * (0.5 + 0.5 * smoothstep(0.3, 0.7, n1));
  return c;
}

uniform vec2 uWorldGain;     // exposure of A, B (dark worlds lifted: mean luminance toward 0.11)
vec3 gradeImg(vec3 c, vec3 blur1, vec3 blur2, vec3 sharpBase, float gain) {
  c *= gain; blur1 *= gain; blur2 *= gain; sharpBase *= gain;
  c = max(vec3(0.0), c + (c - sharpBase) * 0.45);     // unsharp: crisper detail on the upscaled panorama
  float L = lum(c);
  // saturation lift around luminance (linear), never paler
  c = max(vec3(0.0), vec3(L) + (c - vec3(L)) * (1.28 + 0.15 * uVI));
  // gentle S-curve toward a darker base and luminous highlights (luminous, not foggy)
  float L2 = lum(c);
  float Lt = L2 * L2 * 1.15 / (L2 + 0.22) + 0.003;
  c *= Lt / max(1e-4, L2);
  // mip bloom on the bright parts
  c += max(blur1 - vec3(0.32), vec3(0.0)) * 0.45 + max(blur2 - vec3(0.22), vec3(0.0)) * 0.3;
  return c;
}

vec3 worldColour(vec3 d, vec2 sp, out float edgeOut) {
  edgeOut = 0.0;
  if (uHasWorld < 0.5) return proceduralWorld(d);
  // parallax: a low-mip luminance as depth (bright/large = near), the camera offset moves near parts more
  float dl = lum(sampleImg(uWorldA, d, uWorldLod.x - 3.0));
  vec3 dp = normalize(d - uCamOff * (0.6 + 1.6 * dl));
  // crossfade: flow-warped per-pixel melt (span 0.4 of the mix range)
  float n = noise3(dp * 2.3 + 11.0);
  float m = smoothstep(n * 0.6, n * 0.6 + 0.4, uMix);
  float warp = sin(PI * uMix) * 0.09;
  vec3 flow = vec3(noise3(dp * 1.7) - 0.5, noise3(dp * 1.7 + 5.0) - 0.5, noise3(dp * 1.7 + 9.0) - 0.5);
  vec3 dA = normalize(dp + flow * warp * m);
  vec3 dB = normalize(dp - flow * warp * (1.0 - m));
  vec3 c = vec3(0.0);
  float e = 0.0;
  if (m < 0.999) {
    vec3 a0 = sampleImg(uWorldA, dA, 0.0);
    vec3 a1 = sampleImg(uWorldA, dA, 4.5);
    vec3 a2 = sampleImg(uWorldA, dA, 6.5);
    vec3 a3 = sampleImg(uWorldA, dA, 2.0);
    e += abs(lum(a0) - lum(a3)) * (1.0 - m);
    c += gradeImg(a0, a1, a2, a3, uWorldGain.x) * (1.0 - m);
  }
  if (m > 0.001) {
    vec3 b0 = sampleImg(uWorldB, dB, 0.0);
    vec3 b1 = sampleImg(uWorldB, dB, 4.5);
    vec3 b2 = sampleImg(uWorldB, dB, 6.5);
    vec3 b3 = sampleImg(uWorldB, dB, 2.0);
    e += abs(lum(b0) - lum(b3)) * m;
    c += gradeImg(b0, b1, b2, b3, uWorldGain.y) * m;
    // a seam of light rides the melt front
    c += atLum(uAccA, 0.05) * exp(-pow((m - 0.5) * 6.0, 2.0)) * sin(PI * uMix);
  }
  edgeOut = e;
  return c;
}

// ---------------------------------------------------------------- frame
// polygonal radius of p for an n-gon rotated by a
float polyR(vec2 p, float n, float a) {
  float th = atan(p.y, p.x) + a;
  float s = TAU / n;
  float x = mod(th, s) - 0.5 * s;
  return length(p) * cos(x) / cos(0.5 * s);
}
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p + uSeed * 0.031) * 43758.5453);
}
// palette hue for emissive filaments: never a dim yellow/lime (reads olive/brown/sand)
vec3 filHue(float x) {
  vec3 h = palAt(x);
  if (h.r > 0.45 && h.g > 0.45 && h.b < 0.45) h = mix(uAccA, uAccB, step(0.5, fract(x * 3.7)));
  return h;
}
// jittered-grid Voronoi in (x, y) with the y index wrapping at M cells (a closed ring of cells).
// returns (F1, F2 - F1 edge measure, hash of cell 1, symmetric hash of the edge between cells 1 and 2)
vec4 voroWrap(vec2 x, float M) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  vec2 i1 = vec2(0.0), i2 = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 id = n + g;
      id.y = mod(id.y, M);
      vec2 o = 0.12 + 0.76 * hash22(id);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = id; }
      else if (d < d2) { d2 = d; i2 = id; }
    }
  }
  float a = hash22(i1).x;
  float b = hash22(i2).x;
  return vec4(sqrt(d1), sqrt(d2) - sqrt(d1), a, fract((min(a, b) * 17.31 + max(a, b) * 5.13)));
}

// The frame: (1) the aperture rim, a bright thin gold/cyan double filament polygon (+ scalloped lips),
// (2) two further thin filament polygons just outside it, rotating their own ways, and (3) the
// MEMBRANE beyond: near-black stained-glass cells in palette colour 0 (L 0.02-0.045) laid out in
// log-polar coordinates (they shrink toward the aperture: tunnel-as-depth, and flow slowly outward),
// the world glowing faintly through, with thin emissive accent filaments (L 0.35-0.6, bloom halo) on a
// seeded subset of the cell edges; filament hue drifts along the radius. Jittered cells: aperiodic, so
// no periodic high-contrast pattern for 4.1 / the limiter's guard; the polygon lines are <= 3 thin lines.
// returns rgb, alpha (coverage of the frame over the world)
vec4 frame(vec2 p, vec3 behind, out vec3 add) {
  add = vec3(0.0);
  float N = uFold;
  float ch = uChallenge;
  float Ra = uAperture;
  float rp = polyR(p, N, uBandRot.x);
  float s = rp - Ra;                         // distance outside the aperture
  float px = 2.0 / uRes.y;                   // one pixel in half-height units
  float lEdge = uFrameLum.z;
  float cover = smoothstep(-1.5 * px, 1.5 * px, s);
  // inner rim: the brightest, thinnest line (the threshold of the world), coloured halo inward and outward
  float rimW = mix(1.6, 1.1, ch) * px;
  float rim = exp(-s * s / (rimW * rimW));
  vec3 rimHue = mix(uAccA, uAccB, 0.5 + 0.5 * sin(atan(p.y, p.x) * 2.0 + uTime * 0.05));
  rimHue = mix(rimHue, HARSH_A, 0.85 * ch);
  vec3 rimC = atLum(rimHue, lEdge) * rim + atLum(rimHue, 0.12 * (1.0 - 0.4 * ch)) * exp(-abs(s) / (0.03 * (1.0 - 0.5 * ch)));
  // mandala lip: N-fold scalloped petals just inside the aperture (thin lines + coloured halo)
  float thL = atan(p.y, p.x) + uBandRot.x;
  float scal = Ra * (1.0 - (0.035 + 0.015 * uFrameDensity) * pow(abs(cos(0.5 * N * thL)), 0.6));
  float sl = rp - scal;
  float lip = exp(-sl * sl / (rimW * rimW * 0.8)) * step(s, 0.0);
  vec3 lipHue = mix(uAccB, HARSH_M, 0.85 * ch);
  rimC += atLum(lipHue, 0.55 * lEdge) * lip + atLum(lipHue, 0.05) * exp(-abs(sl) / 0.012) * step(s, 0.0);
  // two outer filament polygons (own rotations; uneven spacing: not a periodic ring stack)
  float rp2 = polyR(p, N, uBandRot.z);
  float rp3 = polyR(p, N, -uBandRot.w);
  float o2 = rp2 - Ra * mix(1.075, 1.05, ch);
  float o3 = rp3 - Ra * mix(1.19, 1.12, ch);
  float ow = mix(1.3, 1.0, ch) * px;
  vec3 o2h = mix(uAccB, HARSH_M, 0.85 * ch), o3h = mix(uAccA, HARSH_A, 0.85 * ch);
  vec3 polyC = atLum(o2h, 0.55 * lEdge) * exp(-o2 * o2 / (ow * ow)) + atLum(o2h, 0.05) * exp(-abs(o2) / 0.02)
             + atLum(o3h, 0.45 * lEdge * (0.5 + 0.5 * uFrameDensity)) * exp(-o3 * o3 / (ow * ow)) + atLum(o3h, 0.04) * exp(-abs(o3) / 0.025);
  add = rimC + polyC * step(0.0, s);
  if (s <= 0.0) return vec4(0.0);

  // ---- membrane: log-polar stained glass ----
  float M = 26.0;                                                         // cells around (MEMBRANE_CELLS)
  float lr = log(max(rp, 0.02));
  float th = atan(p.y, p.x) + uMem.y + 0.35 * lr;                         // slow rotation + log-spiral twist
  vec2 X = vec2(lr * M / TAU - uMem.x, (th / TAU + 0.5) * M);
  vec4 V = voroWrap(X, M);
  float cellPx = rp * TAU / M / px;                                       // one cell unit in pixels
  float e = V.y * 0.5 * cellPx;                                           // distance to the edge, px
  // near-black cells in palette colour 0, full chroma; slightly varied; the world glows through faintly
  float Lc = mix(0.006, 0.014, V.z) * mix(1.0, 0.7, ch);
  vec3 cellC = atLum(uDeep, Lc);
  float bl = lum(behind);
  cellC += atLum(behind + 1e-4, min(0.012, bl * 0.06)) * (0.5 + 0.5 * uVeil) * (1.0 - 0.7 * ch);
  // emissive filaments on a seeded subset of edges (density rises with v); hue drifts along the radius
  float lit = step(V.w, mix(0.45, 0.8, uFrameDensity) + 0.15 * ch);
  float hx = lr * 0.9 + V.w * 0.3 - uTime * 0.006;
  vec3 fh = filHue(hx);
  fh = mix(fh, mix(HARSH_A, HARSH_M, step(0.5, V.w)), 0.9 * ch);
  float fw = mix(0.9, 0.7, ch);
  float line = exp(-e * e / (fw * fw)) * lit;
  float lF = mix(0.38, 0.6, uFrameDensity) * mix(1.0, 0.95, ch);
  // depth: deeper (near the aperture) filaments are a touch brighter, the outer ones sink a little
  float depthK = mix(1.0, 0.75, smoothstep(0.0, 1.4, s));
  vec3 col = cellC;
  col += atLum(fh, 0.04) * exp(-e / 5.0) * lit * depthK;                // bloom halo inside the glass
  col = mix(col, atLum(fh, lF * depthK), line);
  // unlit edges: a faint dark-jewel seam (structure without light)
  col = mix(col, atLum(filHue(hx + 0.5), 0.06), exp(-e * e / 0.8) * (1.0 - lit) * 0.6);
  // a dark gap just outside the rim so the threshold reads
  col *= mix(0.35, 1.0, smoothstep(0.0, 0.06, s));
  return vec4(col, cover);
}

// ---------------------------------------------------------------- entity
vec4 spriteAt(vec2 uv, float lod) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 a = textureLod(uEntA, uv, lod);
  vec4 b = textureLod(uEntB, uv, lod);
  return mix(a, b, uEntMix);
}
vec4 spriteMorph(vec2 uv, float lod) {
  // flow-warped crossfade: warp each variant along a field-like flow while they swap
  float w = sin(PI * uEntMix) * 0.035;
  vec2 fl = vec2(noise3(vec3(uv * 4.0, uTime * 0.1)) - 0.5, noise3(vec3(uv * 4.0 + 7.0, uTime * 0.1)) - 0.5);
  vec2 ua = uv + fl * w * uEntMix;
  vec2 ub = uv - fl * w * (1.0 - uEntMix);
  vec4 a = vec4(0.0), b = vec4(0.0);
  if (ua.x >= 0.0 && ua.y >= 0.0 && ua.x <= 1.0 && ua.y <= 1.0) a = textureLod(uEntA, ua, lod);
  if (ub.x >= 0.0 && ub.y >= 0.0 && ub.x <= 1.0 && ub.y <= 1.0) b = textureLod(uEntB, ub, lod);
  return mix(a, b, uEntMix);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// composite one sprite (straight alpha) at local coords q (half-height units, centred) with half-size h
vec3 drawSprite(vec3 c, vec2 q, float h, float alphaGain, vec3 tint, float tintK, float field, bool full) {
  vec2 uv = q / (2.0 * h) + 0.5;
  if (uv.x < -0.1 || uv.y < -0.1 || uv.x > 1.1 || uv.y > 1.1) return c;
  vec4 s = full ? spriteMorph(uv, 0.0) : spriteAt(uv, 1.0);
  // soft fade at the quad's border: a sprite cut off at its edge never shows a hard box / staircase
  s *= smoothstep(0.0, 0.08, uv.x) * smoothstep(1.0, 0.92, uv.x) * smoothstep(0.0, 0.16, uv.y) * smoothstep(1.0, 0.92, uv.y);
  float haloA = 0.6 * spriteAt(uv, 3.0).a + 0.4 * spriteAt(uv, 4.5).a;
  vec3 body = s.rgb;
  // accent hue around the being: alternating palette accents (and a third palette hue) by angle
  float ang = atan(q.y, q.x);
  // (near-hard switches between hues: a linear mix of complementary accents would grey them)
  vec3 acc = mix(uAccA, uAccB, smoothstep(-0.25, 0.25, sin(ang * 3.0 + uTime * 0.15)));
  acc = mix(acc, palAt(0.62), smoothstep(0.55, 0.85, sin(ang * 2.0 - uTime * 0.1)));
  acc = mix(acc, mix(HARSH_A, HARSH_M, 0.5 + 0.5 * sin(ang * 2.0)), 0.85 * uChallenge);
  // self-luminous: lift the body and push chroma; pale / silver parts take the accent hue (no grey ghost)
  float L = lum(body);
  float mx = max(body.r, max(body.g, body.b)), mn = min(body.r, min(body.g, body.b));
  float sat = (mx - mn) / max(mx, 1e-3);
  body = max(vec3(0.0), vec3(L) + (body - vec3(L)) * 1.45);
  body = mix(body, atLum(acc, L), (1.0 - smoothstep(0.15, 0.55, sat)) * 0.7);
  body *= (1.15 + 0.5 * uEntPulse) * (1.0 - 0.35 * uEntStern);
  body = mix(body, atLum(tint, max(L, 0.12) * 1.3), tintK);
  float outline = clamp((haloA - s.a) * 2.2, 0.0, 1.0);
  vec3 rimHue = mix(acc, tint, tintK);
  vec3 rimC = atLum(rimHue, 0.55) * outline * (0.7 + 0.5 * field) * (1.0 - 0.4 * uEntStern);
  vec3 halo = atLum(rimHue, 0.08 + 0.06 * uEntPulse) * haloA * (1.0 - 0.5 * uEntStern);
  c = mix(c, body, s.a * alphaGain);
  c += (rimC + halo) * alphaGain;
  return c;
}

vec3 entity(vec3 c, vec2 p, float field) {
  if (uEnt < 0.004) return c;
  float h = uEntSize;
  vec2 q0 = p - uEntPos;
  float r = length(q0);
  // kaleidoscopic echoes (behind): n-fold mirror fold about the entity, two rings, fading outward
  if (r < h * 4.2 && r > h * 0.55) {
    float n = uEntEcho;
    float sector = TAU / n;
    float a = atan(q0.x, q0.y) + uTime * 0.02;
    float af = mod(a + 0.5 * sector, sector) - 0.5 * sector;
    af = abs(af);                                  // mirror: kaleidoscope
    vec2 qf = r * vec2(sin(af), cos(af));
    float ring = floor(a / sector + 0.5);
    vec3 tint = palAt(ring / n + 0.1);
    float d1 = h * 1.55, h1 = h * 0.5;
    c = drawSprite(c, qf - vec2(0.0, d1), h1, 0.62 * uEnt, tint, 0.8, field, false);
    float d2 = h * 2.75, h2 = h * 0.32;
    c = drawSprite(c, qf - vec2(0.0, d2), h2, 0.4 * uEnt, palAt(ring / n + 0.45), 0.85, field, false);
  }
  // glyph sparks (teach / work on): small bright motes streaming outward from the entity
  if (uSparks > 0.01) {
    float a = atan(q0.y, q0.x);
    float nS = 28.0;
    float id = floor((a / TAU + 0.5) * nS);
    float ph = fract(uTime * 0.12 + hash1(id * 3.1));
    float rr = h * (0.4 + 3.2 * ph);
    float aa = (id + 0.5) / nS * TAU - PI;
    vec2 sp = uEntPos + rr * vec2(cos(aa), sin(aa));
    float dd = length(p - sp);
    float k = exp(-dd * dd / 0.00012) * sin(PI * ph) * uSparks * uEnt;
    c += atLum(palAt(id * 0.13), 0.7) * k;
  }
  // halo ring: a thin bright coloured filament circle around the being (+ soft bloom)
  {
    float hr = r - h * 1.08;
    float hw = 1.4 * 2.0 / uRes.y;
    vec3 hh = mix(uAccA, uAccB, smoothstep(-0.3, 0.3, sin(atan(q0.y, q0.x) * 2.0 + uTime * 0.2)));
    hh = mix(hh, HARSH_A, 0.85 * uChallenge);
    c += (atLum(hh, 0.6) * exp(-hr * hr / (hw * hw)) + atLum(hh, 0.06) * exp(-abs(hr) / 0.02))
         * uEnt * (1.0 - 0.4 * uEntStern);
  }
  // the being itself, swaying
  vec2 qs = rot2(uEntSway) * q0;
  c = drawSprite(c, qs, h, uEnt, uEntGlow, 0.0, field, true);
  // presented object: a rotating nested star polygon between the being and the viewer
  if (uObj > 0.01) {
    vec2 op = uEntPos + vec2(0.0, -0.32 * h);
    vec2 oq = p - op;
    float orad = 0.22 * h;
    float pr1 = polyR(oq, 5.0, uTime * 0.15);
    float pr2 = polyR(oq, 3.0, -uTime * 0.11);
    float pr3 = polyR(oq, 7.0, uTime * 0.07);
    float px = 2.0 / uRes.y;
    float l1 = exp(-pow((pr1 - orad) / (1.4 * px), 2.0));
    float l2 = exp(-pow((pr2 - orad * 0.62) / (1.4 * px), 2.0));
    float l3 = exp(-pow((pr3 - orad * 1.25) / (1.2 * px), 2.0));
    float core = exp(-dot(oq, oq) / (orad * orad * 0.12));
    vec3 oc = atLum(uAccB, 0.75) * l1 + atLum(uAccA, 0.7) * l2 + atLum(palAt(0.6), 0.55) * l3
            + atLum(uAccA, 0.25) * core + atLum(uAccB, 0.05) * exp(-length(oq) / (orad * 0.8));
    c = mix(c, c * 0.6, smoothstep(orad * 1.3, orad * 0.9, pr1) * uObj * 0.5);
    c += oc * uObj * uEnt;
  }
  return c;
}

// ---------------------------------------------------------------- message rings
vec3 rings(vec3 c, vec2 p) {
  if (uMsg < 0.004) return c;
  vec2 q = p - uEntPos;
  float r = length(q);
  float h = uEntSize;
  float gh = 0.085 + 0.02 * h;                    // glyph height
  for (int j = 0; j < 4; j++) {
    float fj = float(j);
    if (fj >= uRings) break;
    float R = h * 0.95 + gh * 1.25 * (fj + 0.6) * (1.0 + 0.25 * uKeyPulse);
    // stream in: ring j appears 0.8 s after ring j-1
    float appear = smoothstep(fj * 0.8, fj * 0.8 + 1.2, uMsgT);
    if (appear <= 0.0) continue;
    float cells = floor(TAU * R / (gh * 1.05));
    float rot = j == 0 ? uRingRot.x : j == 1 ? uRingRot.y : j == 2 ? uRingRot.z : uRingRot.w;
    float th = atan(q.y, q.x);
    float ca = (th + rot) / TAU * cells;
    float cell = floor(ca);
    float cid = mod(cell, cells);
    // interaction: key pulse scatters glyphs radially, mouse speed jitters them along the ring
    float jitter = (hash2(vec2(cid, fj + 5.0)) - 0.5) * (0.06 * uKeyPulse + 0.03 * uLookVel);
    float rr = r - R - jitter;
    if (abs(rr) > gh * 0.75) continue;
    float lx = fract(ca) - 0.5 + (hash2(vec2(cid, fj)) - 0.5) * 0.25 * uLookVel;
    vec2 guv = vec2(lx * 1.05 + 0.5, 0.5 - rr / gh);     // y down in the atlas cell (glyphs upright, facing out)
    if (guv.x < 0.0 || guv.x > 1.0 || guv.y < 0.0 || guv.y > 1.0) continue;
    float gid = floor(hash2(vec2(cid + fj * 31.0, uGlyphSeed)) * uGlyphCount);
    // a few blank cells: word gaps
    if (hash2(vec2(cid * 0.7, fj + uGlyphSeed)) < 0.14) continue;
    vec2 cellOrg = vec2(mod(gid, 8.0), floor(gid / 8.0));
    vec2 auv = (cellOrg + vec2(guv.x, guv.y)) / vec2(8.0, 4.0);
    auv.y = 1.0 - auv.y;                           // canvas row 0 at the top, texture flipY
    float g = textureLod(uAtlas, auv, 0.0).a;
    float gb = textureLod(uAtlas, auv, 3.0).a;
    // two alternating accent hues ring by ring; a key press shifts the hue of some glyphs
    vec3 hue = mod(fj, 2.0) < 0.5 ? uAccA : uAccB;
    hue = hueRot(hue, 1.2 * uKeyPulse * hash2(vec2(cid, 3.0)));
    hue = mix(hue, mod(fj, 2.0) < 0.5 ? HARSH_A : HARSH_M, 0.85 * uChallenge);
    // bright strokes (L 0.5-0.8) over a faint dark backing halo (they read on bright nebula too), bloom
    float L = mix(0.5, 0.8, uMsg) * appear;
    c *= 1.0 - 0.55 * gb * uMsg * appear;
    c = mix(c, atLum(hue, L), g * uMsg);
    c += atLum(hue, 0.07) * gb * uMsg * appear;
  }
  return c;
}

void main() {
  vec2 frag = vUv * uRes;
  vec2 p = (frag - 0.5 * uRes) / (0.5 * uRes.y);     // half-height units, y up
  // view ray: vertical fov ~ 80 deg, look + drift
  float tf = tan(radians(40.0));
  vec3 d = normalize(vec3(p.x * tf, p.y * tf, -1.0));
  d = rotX(-uLook.y) * d;
  d = rotY(uLook.x) * d;
  float edge;
  vec3 w = worldColour(d, p, edge);
  // field shimmer on the world's edges (coupling rule 11.1)
  float field = 0.0;
  if (uHasField > 0.5) {
    float rr = length(p);
    vec2 fuv = vec2(clamp(log(rr * 6.0 + 1.0) / log(13.0), 0.0, 1.0), atan(p.y, p.x) / TAU + 0.5);
    field = texture2D(uField, fuv).r;
  }
  w += atLum(uAccB, 0.25) * smoothstep(0.03, 0.15, edge) * field * 0.5;
  // chromatic breathing (<= 0.07 Hz)
  w = hueRot(w, 0.09 * sin(uTime * TAU * 0.045) + 0.05 * sin(uTime * TAU * 0.017 + 1.0));
  // difficult passage: colder, two-colour, darker, sharper; relief floods warm light back
  w = harshen(w, 0.85 * uChallenge) * (1.0 - 0.35 * uChallenge);
  // sharp acid filaments on the world's own edges (colder, sharper, not greyer)
  w += atLum(mix(HARSH_A, HARSH_M, step(0.5, noise3(d * 3.0))), 0.5) * smoothstep(0.05, 0.16, edge) * uChallenge;
  w = mix(w, w * WARM * 1.45, 0.4 * uRelief) + atLum(WARM, 0.03) * uRelief;
  w *= uDim;
  // depth vignette inside the aperture (darkens, never a veil)
  w *= 1.0 - 0.35 * smoothstep(0.6, 1.6, length(p) / max(0.3, uAperture));

  vec3 c = w;
  c = entity(c, p, field);
  c = rings(c, p);
  vec3 frAdd;
  vec4 fr = frame(p, w, frAdd);
  c = mix(c, fr.rgb, fr.a) + frAdd;
  // luminance ceiling (thin accents only reach it)
  float L = lum(c);
  if (L > 0.9) c *= 0.9 / L;
  gl_FragColor = vec4(max(c, vec3(0.0)), uWeight);
}
