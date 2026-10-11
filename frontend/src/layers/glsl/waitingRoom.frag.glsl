// Waiting room (BUILD.md §11.6, docs/VISUAL_DIRECTION.md §3): a ray-marched, self-lit fractal interior.
//   kind 0 "kifs":      a kaleidoscopic nave: a 5-fold (10 mirror sectors) tunnel whose walls are a Menger-type
//                       kaleidoscopic IFS (abs/sort folds with turning fold planes); every ring of wall
//                       cells along the nave has its own fold angles (hash of the ring index), so the walls
//                       never repeat exactly.
//   kind 1 "mandelbox": a Mandelbox (scale −2.2 ± morph), mirrored-repeated blocks, the camera drifting
//                       down the crossing of two halls between them.
// The camera drifts at constant velocity with a stable horizon (BUILD.md §4.5; only mouse look turns it).
//
// Look (docs/VISUAL_DIRECTION.md): every block has ONE light colour X from the trip palette (its line
// ornament, its glowing panels, its raking light) and a second colour Y only in thin lines, so pure hues
// sit side by side and never mix into lilac / slate / brown. Faces are near-black in a per-block deep hue
// (the darkest palette colour leaning towards X, full chroma); recesses sink into the base colour
// (ambient occlusion); lines have a pure-hue body (never brighter than the hue itself) and a ~1-px
// white-hot crest (0.7–0.9); the far halls sink into a faint glow of the deep palette colour, brightest
// straight down a hall (a depth cue that darkens, never a veil). kifs: the walls are the fractal's own turned
// faces (no flat clipping slab towards the axis), a dark stained-glass mosaic of the two light colours' deep
// tones (one pane per sub-cube of the first two folds, equal luminance), glowing fold-plane filaments and
// panels in the wall's light colour, the second colour only where the first is absent; the nave's windows
// look out on a dark space of lanterns (glowing orbs). Bloom is a separate pass (waitingRoom.ts).
// Output LINEAR RGB, alpha = weight. uDbg > 0 shows debug masks (1: edge / lines / panels, 2: calm / ao / glow).
//
// Safety at source (BUILD.md §4.1): the bright parts are thin lines and small panels (aperiodic: each
// block / wall ring has its own hashed brightness and colour), the broad structure is dark, nothing
// periodic above ~0.3 Hz (light flow along the ornament, pulse ≤ 0.5 Hz), no near-white, mean luminance
// far below the cap. Surfaces that stream fast across the screen (the near field) keep only single-colour
// threads in a dim band (luminance ≤ 0.09): no change there can reach the 0.1 flash step.
precision highp float;
varying vec2 vUv;

uniform vec2 uRes;
uniform float uWeight;
uniform float uTime;
uniform float uPulse;
uniform float uIntensity;      // 0–1 (= visual / 10)
uniform float uChallenge;
uniform vec2 uLook;            // yaw, pitch (rad)
uniform vec3 uCam;             // camera position (constant velocity along +z)
uniform vec2 uPath;            // x,y of the drift line
uniform vec2 uGaze;            // fixed gaze of the kind (yaw, pitch), before the user's mouse look
uniform int uKind;             // 0 kifs, 1 mandelbox
uniform float uMorph;          // slow morph phase (rad)
uniform float uSteps;          // max ray-march steps (quality knob)
uniform float uFar;            // far distance
uniform vec3 uPal[5];          // LINEAR, normalised to luminance 0.2 (surface hues)
uniform vec3 uEmA;             // emissive colour A, LINEAR, luminance 1 (channels may exceed 1)
uniform vec3 uEmB;             // emissive colour B
uniform vec3 uEmC;             // a third light colour (surface tint / spill variety), LINEAR, luminance 1
uniform vec3 uSpillB;          // the light colour B throws on surfaces (A when B is a yellow/orange)
uniform vec3 uDeep;            // depth colour, LINEAR, luminance 1
uniform vec3 uGlow;            // colour of the far depth glow down the halls (third palette light), max channel 1
uniform float uSpeed;          // drift speed (units/s), for the per-pixel motion estimate
uniform float uFlow;           // light-flow phase along the ornament (cycles; rate set on the CPU, ≤ 0.3 Hz)
uniform sampler2D uField;
uniform float uHasField;
uniform float uDbg;

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// kifs nave
const float KN = 5.0;          // kaleidoscope order round the nave (10 mirror sectors: wide enough that the
                               // angular repetition is not a periodic pattern on screen, §4.1)
const float KR = 0.9;          // nave radius (inner face of the walls)
const float KH = 0.6;          // wall-cell half size

vec3 palette(float k) {
  float f = mod(k, 5.0);
  int i = int(floor(f));
  float t = smoothstep(0.0, 1.0, fract(f));
  vec3 a = uPal[0], b = uPal[1];
  if (i == 1) { a = uPal[1]; b = uPal[2]; }
  else if (i == 2) { a = uPal[2]; b = uPal[3]; }
  else if (i == 3) { a = uPal[3]; b = uPal[4]; }
  else if (i == 4) { a = uPal[4]; b = uPal[0]; }
  return mix(a, b, t);
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float hash11(float x) { return fract(sin(x * 127.1 + 11.7) * 43758.5453); }
float hash13(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

vec2 polarFold(vec2 v, float n) {
  float w = PI / n;
  float a = atan(v.y, v.x);
  a = abs(mod(a + w, 2.0 * w) - w);
  return length(v) * vec2(cos(a), sin(a));
}

// ---- kind 0: kaleidoscopic nave. trap: x, y = distances to the fold planes of the first two folds (two
// line families), z = the same one fold deeper (jewels), w = two folds deeper (finest filigree, v ≈ 9).
// The ring id and whether the fractal's own face (not the cell bound) was hit go out through globals.
float gRing = 0.0;
float gFace = 1.0;
float gFold = 0.0;     // which sub-cube of the first two folds (sign pattern + branch): mosaic colouring
float deKifs(vec3 p, out vec4 tr) {
  vec2 pk = polarFold(p.xy, KN);                              // x ≈ radius, y = arc offset from the sector axis
  // the rings are irregular: a smooth warp of z (local ring length 0.6–1.4×, period 3.7 rings) keeps the
  // wall rings from forming a regular (periodic) series down the nave
  float zw = p.z + 0.26 * sin(p.z * 1.5437);
  float ring = floor(zw / (2.0 * KH) + 0.5);
  vec3 c0 = vec3(pk.x - KR - KH, pk.y, zw - ring * 2.0 * KH) / KH;    // wall cell [-1,1]^3 (x outwards)
  float hz = hash11(ring);
  // fold-plane turns per ring: enough that the Menger lattice never lines up into a regular grid (§4.1),
  // small enough that the lace keeps its open windows
  float a1 = 0.12 + 0.22 * hz + 0.05 * sin(uMorph) + 0.12 * uChallenge;
  float a2 = 0.08 + 0.18 * fract(hz * 7.13) + 0.04 * cos(0.7 * uMorph);
  vec3 off = vec3(1.0, 1.0 - 0.2 * fract(hz * 3.7), 1.0);
  mat2 r1 = rot(a1), r2 = rot(a2);
  vec3 q = c0;
  float s = 1.0;
  tr = vec4(1e3);
  float fid = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i <= 1) fid = fid * 16.0 + step(0.0, q.x) + 2.0 * step(0.0, q.y) + 4.0 * step(0.0, q.z);
    q = abs(q);
    if (q.x < q.y) q.xy = q.yx;
    if (q.x < q.z) q.xz = q.zx;
    if (q.y < q.z) q.yz = q.zy;
    q.xz = r1 * q.xz;
    q.xy = r2 * q.xy;
    q.xy = q.xy * 3.0 - 2.0 * off.xy;
    q.z = 3.0 * q.z;
    if (q.z > off.z) { q.z -= 2.0 * off.z; if (i <= 1) fid += 8.0; }
    s *= 3.0;
    if (i <= 1) tr.xy = min(tr.xy, abs(q.yz) / s * 3.0);
    if (i == 2) tr.z = min(abs(q.y), abs(q.z)) / s * 3.0;
    if (i == 3) tr.w = min(abs(q.y), abs(q.z)) / s * 3.0;
  }
  float d = (max(abs(q.x), max(abs(q.y), abs(q.z))) - 1.0) / s;
  // keep each cell inside its own box along the nave (z) and round it (y); towards the nave axis (−x) the
  // fractal's own turned faces stand free (a flat clipping plane there read as a plain slab wall)
  float bound = max(max(-c0.x - 1.35, c0.x - 1.01), max(abs(c0.y) - 1.2, abs(c0.z) - 1.01));
  gRing = ring;
  gFold = fid;
  gFace = step(bound, d);                                      // 1 on the fractal's own faces (not the cell bound)
  d = max(d, bound) * KH * 0.71;                              // 0.71: the z warp stretches space up to 1.4×
  return d;
}

// ---- kind 1: Mandelbox. trap (world units, ≈ distance to the fold planes of the first iterations):
// x = planes z_1.x = 0 / z_1.y = 0, y = plane z_1.z = 0 (engraved lines that follow the box folds),
// z = the same planes one iteration deeper (finer ornament, shown with intensity), w = two iterations deeper.
float deMandelbox(vec3 p, out vec4 tr) {
  vec3 c = 4.0 - abs(mod(p + 4.0, 16.0) - 8.0);             // mirrored repetition (half-cell 4), continuous
  vec3 z = c;
  float dr = 1.0;
  float scale = -2.2 + 0.06 * sin(uMorph) - 0.12 * uChallenge;
  tr = vec4(1e3);
  for (int i = 0; i < 9; i++) {
    z = clamp(z, -1.0, 1.0) * 2.0 - z;                      // box fold
    float r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }                 // sphere fold (min r² 0.25, fixed r² 1)
    else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * scale + c;
    dr = dr * abs(scale) + 1.0;
    if (i == 1) { vec3 az = abs(z) / dr; tr.x = az.x; tr.y = min(az.y, az.z); }
    if (i == 2) { vec3 az = abs(z) / dr; tr.z = min(az.x, min(az.y, az.z)); }
    if (i == 3) { vec3 az = abs(z) / dr; tr.w = min(az.x, min(az.y, az.z)); }   // finest ornament (v ≈ 9)
  }
  float d = length(z) / abs(dr);
  float nave = length(p.xy - uPath) - (0.3 - 0.05 * uChallenge);
  return max(d, -nave);
}

float de(vec3 p, out vec4 tr) {
  if (uKind == 1) return deMandelbox(p, tr);
  return deKifs(p, tr);
}
float de0(vec3 p) { vec4 t; return de(p, t); }

// per-cell identity (aperiodic brightness / colour variation of the ornament)
float cellHash(vec3 p, vec4 tr) {
  if (uKind == 1) return hash13(floor((p + 4.0) / 8.0));
  return hash11(gRing * 1.37 + 5.0);
}

// ornament traps: x = trap of family A (lines), y = family B (lines), z = jewels, w = 1 on ornamentable faces
vec4 ornTraps(vec4 tr) {
  if (uKind == 1) return vec4(tr.x, tr.y, tr.z, 1.0);
  return vec4(tr.x, tr.y, tr.z, gFace);
}
// anti-aliased thin line around trap value 0 of half-width w; lines thinner than ~1.5 px fade out
// (sub-pixel ornament would sparkle as it moves)
// The line is also never wider than ~3 px on screen: where a surface runs almost inside a trap slab the
// slab would paint a blob; capping the width at the zero crossing keeps every ornament a crisp filament.
float aaLine(float v, float w) {
  float fw = max(fwidth(v), 1e-6);
  float wc = min(w, 1.8 * fw);
  float m = 1.0 - smoothstep(wc - 0.6 * fw, wc + 0.6 * fw, v);
  // where a face runs inside the trap plane itself (fwidth ≈ 0) the whole face would light up as one
  // blown-out blob: lines only exist where they cross the surface (natural width ≤ ~40 px)
  return m * clamp(w / (0.75 * fw) - 0.5, 0.0, 1.0) * smoothstep(0.015, 0.05, fw / w);
}
// the white-hot crest of a line: ~1 px at its centre
float crestOf(float v) {
  float fw = max(fwidth(v), 1e-6);
  return 1.0 - smoothstep(0.15 * fw, 0.75 * fw, v);
}
// smooth spill falloff, faded where it would be pixel noise
float spillOf(float v, float k) {
  float fw = max(fwidth(v), 1e-6);
  return exp(-v * k) * clamp(0.25 / (k * fw), 0.0, 1.0) * smoothstep(0.002, 0.01, k * fw);
}
// light of hue c (max channel 1) at luminance L: full chroma up to the hue's own ceiling, white-hot beyond
vec3 lightAt(vec3 c, float L) {
  float lc = max(dot(c, LUMA), 1e-4);
  if (L <= lc) return c * (L / lc);
  return mix(c, vec3(1.0), min(1.0, (L - lc) / max(1.0 - lc, 1e-4)));
}
// broad light of hue c: never brighter than the pure hue itself (a broad pale area would read as pastel)
vec3 hueAt(vec3 c, float L) { return c * min(L / max(dot(c, LUMA), 1e-4), 1.0); }
// glowing light of hue c: like hueAt, but a dark hue (pink, blue) may run a little hotter than its own
// ceiling (at most 12% of the way to white: still the hue, never pastel)
// (difficult passage: hot = 0, pure acid hues only)
float gHot = 0.12;
vec3 glowAt(vec3 c, float L) {
  float lc = max(dot(c, LUMA), 1e-4);
  return lightAt(c, min(L, lc + gHot * (1.0 - lc)));
}
// the deep version of a light colour: the deep palette colour leaning towards it, full chroma, luminance 1
// (dim cyan reads as sapphire / teal-blue and dim pink as amethyst, never as dull teal or maroon)
vec3 deepOf(vec3 c, float k) {
  vec3 b = mix(uDeep, c / max(dot(c, LUMA), 1e-4), k);
  b -= 0.9 * min(b.r, min(b.g, b.b));
  return b / max(dot(b, LUMA), 1e-4);
}
float haloOf(vec4 tr) {
  vec4 o = ornTraps(tr);
  if (uKind == 1) return exp(-min(o.x, o.y) * 25.0);
  return o.w * exp(-min(o.x, o.y) * 14.0);
}

// kifs: the light beyond the nave walls (a smooth field of the palette light colours)
const vec3 ACID1 = vec3(0.002, 0.859, 1.0);    // #05d9e8 (linear, max channel 1)
const vec3 ACID2 = vec3(1.0, 0.03, 0.33);      // #ff2a6d pushed a little to magenta (red share 0.74 < 0.8, §4.1)
vec3 lanternCol(vec3 pe, float fieldAct) {
  // a smooth field between the third palette light C and the deep colour (for neon: violet ↔ indigo):
  // the light the wall shell catches from outside; never the cyan/pink pair (dim, those read as teal / rust)
  float ang = atan(pe.y, pe.x);
  float u1 = 0.5 + 0.5 * sin(2.0 * ang + 0.35 * pe.z + 0.03 * uTime + 2.5 * sin(0.37 * pe.z));
  float u2 = 0.5 + 0.5 * sin(3.0 * ang - 0.23 * pe.z + 1.7 + 0.25 * fieldAct);
  vec3 dm = uDeep / max(uDeep.r, max(uDeep.g, uDeep.b));
  vec3 lc = mix(dm, uEmC, smoothstep(0.2, 0.8, u1));
  return lc * (0.55 + 0.45 * u2);
}
// kifs: what a ray sees through the lace: a dark coloured space full of lanterns (small glowing orbs in the
// two light colours, hashed and jittered: no regular grid) — stained glass with lights behind it
vec3 lanternView(vec3 pe, float vI, float chl, float calmW) {
  float ang = atan(pe.y, pe.x) / (2.0 * PI) + 0.5;
  vec3 bg = hueAt(lanternCol(pe, 0.5), 0.008 + 0.006 * vI);
  vec3 orbs = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 1.0 : 1.9;
    vec2 g = vec2(ang * 22.0 * sc, pe.z * 1.6 * sc + 5.3 * float(k));
    vec2 id = floor(g), f = fract(g) - 0.5;
    id.x = mod(id.x, 22.0 * sc);
    float h = hash12(id + 13.0 * float(k + 1));
    vec2 off = vec2(hash12(id + 7.1), hash12(id + 3.7)) - 0.5;
    float dd = length(f - off * 0.25);
    float on = step(0.5 + 0.15 * float(k), h);
    float orb = (smoothstep(0.22, 0.02, dd) + 0.35 * smoothstep(0.37, 0.0, dd)) * on;   // stays inside its cell
    vec3 oc = mix(fract(h * 7.3) > 0.5 ? uEmA : uSpillB, k == 0 ? ACID1 : ACID2, chl);
    orbs += hueAt(oc, (0.3 + 0.3 * vI) * orb * (k == 0 ? 1.0 : 0.7));
    if (k == 0 && calmW < 0.5) break;
  }
  return bg + orbs * smoothstep(0.1, 0.6, calmW);   // where the lace streams fast the orbs would alias
}

// the far depth of the halls: a faint glow of the third palette light, brightest straight down a hall (an
// axis direction, where the corridor runs to infinity), slowly varying; it darkens towards black and is
// never a veil (luminance ≤ ~0.05)
vec3 depthGlow(vec3 rd, float vI, float ch) {
  float ax = uKind == 1 ? max(abs(rd.x), max(abs(rd.y), abs(rd.z))) : max(rd.z, 0.0);
  float g = pow(ax, 32.0);
  float n = vnoise(rd * 3.0 + vec3(0.0, 0.0, 0.015 * uTime));
  float L = (0.006 + (0.022 + 0.02 * vI) * g * (uKind == 1 ? 1.0 : 0.3)) * (0.7 + 0.6 * n) * (1.0 - 0.6 * ch);
  return hueAt(mix(uGlow, ACID2, 0.5 * ch), L);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 sp = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float rho = length(sp);
  float phi = atan(sp.y, sp.x);

  // camera: forward +z turned by the kind's fixed gaze, stable horizon; only the user's mouse look turns it
  vec3 rd = normalize(vec3(sp * 0.75, 1.0));
  rd.yz = rot(uGaze.y) * rd.yz; rd.xz = rot(uGaze.x) * rd.xz;   // fixed gaze of the kind (mandelbox: oblique down the hall)
  rd.yz = rot(-uLook.y) * rd.yz;
  rd.xz = rot(-uLook.x) * rd.xz;
  vec3 ro = uCam;

  float vI = clamp((uIntensity * 10.0 - 4.0) / 5.0, 0.0, 1.0);   // v 5 → 0.2, 7.5 → 0.7, 9 → 1
  float chl = clamp(uChallenge, 0.0, 1.0);
  gHot = 0.12 * (1.0 - 0.3 * chl);                               // (difficult passage: acid bodies a touch hot, crimson ~0.33)
  // emissive luminance: line body 0.48 → 0.5 (capped at the hue's own ceiling), white-hot crest 0.7 → 0.9 (~1 px)
  float emCore = (0.47 + 0.03 * vI) * (1.0 + 1.1 * chl);
  float emCrest = 0.65 + 0.25 * vI;
  float flowW = 2.0 * PI * uFlow;

  // ray march; emissive halo accumulates where the ray passes close to glowing ornament
  float t = 0.0;
  float d = 1.0;
  vec4 tr = vec4(0.0);
  vec3 halo = vec3(0.0);
  bool hit = false;
  bool through = false;                                          // kifs: the ray left the nave through the lace
  float maxStep = uKind == 1 ? 0.6 : 0.35;
  for (int i = 0; i < 160; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * t;
    d = de(p, tr);
    float eps = 0.0010 + 0.0018 * t;
    if (d < eps) { hit = true; break; }
    float ch = cellHash(p, tr);
    vec3 ec = mix(mix(uEmA, uSpillB, step(0.5, fract(ch * 3.1))), ACID1, chl);
    float near = exp(-d * (uKind == 1 ? 18.0 : 22.0));
    halo += ec * (haloOf(tr) * near * (0.2 + 0.8 * ch) * min(d, maxStep) * exp(-t * 0.08)) * (uKind == 1 ? 0.15 : 0.12);
    if (uKind == 0 && dot(p.xy, p.xy) > (KR + 2.0 * KH + 0.03) * (KR + 2.0 * KH + 0.03) && dot(p.xy, rd.xy) > 0.0) { through = true; break; }
    t += clamp(d * 0.85, eps * 0.5, maxStep);
    if (t > uFar) break;
  }
  float ringId = gRing, foldId = gFold;                          // kifs: the hit point's ring and sub-cube

  // neural field through the retino-cortical map (coupling)
  float fieldAct = 0.5;
  if (uHasField > 0.5) {
    vec2 fuv = vec2((log(rho + 0.05) - log(0.05)) / (log(2.2) - log(0.05)), phi / (2.0 * PI) + 0.5);
    fieldAct = texture2D(uField, fuv).r;
  }

  float fogK = uKind == 1 ? 0.055 : 0.16;
  fogK *= 1.0 + 0.4 * chl * (1.0 - float(uKind));        // (mandelbox: the acid filaments carry to the far blocks)
  vec3 fogCol = depthGlow(rd, vI, chl);
  vec3 col = vec3(0.0);
  // ornament masks (outside any branch: screen-space derivatives must be defined)
  vec4 ot = ornTraps(tr);
  float wl = (uKind == 1 ? 0.0075 + 0.003 * vI : 0.018 + 0.014 * vI) * (1.0 + 0.35 * chl);   // (difficult passage: bolder acid lines)
  float lineA = aaLine(ot.x, wl);
  float lineB = aaLine(ot.y, wl * 1.1);
  float crestA = crestOf(ot.x) * lineA;
  float crestB = crestOf(ot.y) * lineB;
  float jewel = aaLine(ot.z, wl * 0.7) * smoothstep(0.4, 0.75, vI) * exp(-t * (uKind == 1 ? 0.2 : 0.4));
  // (kifs: the finest filigree only in the middle distance; on the near walls it would be dense parallel lines)
  float fine = aaLine(tr.w, wl * 0.5) * smoothstep(0.75, 1.0, vI) * (uKind == 1 ? exp(-t * 0.3) : smoothstep(0.9, 1.6, t) * exp(-t * 0.3));
  float spillA = spillOf(ot.x, uKind == 1 ? 9.0 : 10.0);
  vec3 dbgC = vec3(0.0);
  if (hit) {
    vec3 p = ro + rd * t;
    float e = 0.002 + 0.004 * t;
    vec2 k = vec2(1.0, -1.0);
    vec3 n = normalize(k.xyy * de0(p + k.xyy * e) + k.yyx * de0(p + k.yyx * e) +
                       k.yxy * de0(p + k.yxy * e) + k.xxx * de0(p + k.xxx * e));
    // a coarser normal: where the two disagree the surface turns sharply -> an emissive edge
    float e2 = 4.0 * e;
    vec3 n2 = normalize(k.xyy * de0(p + k.xyy * e2) + k.yyx * de0(p + k.yyx * e2) +
                        k.yxy * de0(p + k.yxy * e2) + k.xxx * de0(p + k.xxx * e2));
    float edge = uKind == 1 ? smoothstep(0.12, 0.45, 1.0 - dot(n, n2)) * exp(-t * 0.25)
                            : smoothstep(0.35, 0.8, 1.0 - dot(n, n2)) * exp(-t * 0.3);   // kifs: only the sharpest rims
    // ambient occlusion (4 taps along the normal), squared: recesses sink into the base colour
    float ao = 0.0;
    float sc = uKind == 1 ? 0.09 : 0.045;
    for (int j = 1; j <= 4; j++) {
      float h = sc * float(j);
      ao += max(0.0, h - de0(p + n * h) * (uKind == 1 ? 1.0 : 1.4)) / h * (1.0 / float(j));
    }
    ao = clamp(1.0 - ao * 0.75, 0.0, 1.0);
    ao *= ao;

    dbgC = vec3(edge, lineA + lineB, spillA * ot.w);
    gRing = ringId;
    float cH = cellHash(p, tr);
    // SAFETY (§4.1, flashes): how fast this surface point streams across the screen (px/s). Near, fast
    // surfaces keep their whole ornament but in a dim band (luminance ≤ 0.09, below), so no luminance
    // there can change by the 0.1 flash step however fast it moves.
    float vperp = uSpeed * sqrt(max(0.0, 1.0 - rd.z * rd.z)) / max(t, 1e-3);   // rad/s
    float pxs = vperp * (uRes.y / 1.5) * (1.0 + 0.5625 * rho * rho);
    float calm = 1.0 - smoothstep(0.6, 1.6, pxs / (uRes.y * 0.035));            // ~25 px/s at 720p: full brightness
    float orn = ot.w;
    float nz = uKind == 1 ? vnoise(p * 0.33 + 7.0) : cH;
    float nz2 = uKind == 1 ? vnoise(p * 0.21 + 31.0) : fract(cH * 5.3);
    // every block has ONE light colour X (its ornament, its spill, its rake light) and a second colour Y
    // only in thin lines: pure palette hues side by side, never mixed into lilac or brown
    float sel = step(0.5, fract(cH * 3.1));
    if (uKind == 0) {
      // kifs: each wall of each ring has its own light colour (cyan / magenta wall faces side by side)
      float wallId = mod(floor(atan(p.y, p.x) / (2.0 * PI / KN) + 0.5), KN);
      sel = step(0.5, hash11(wallId * 3.17 + 7.31 * ringId + 1.3));
    }
    vec3 X = mix(mix(uEmA, uSpillB, sel), ACID1, chl);
    vec3 Y = mix(mix(uEmB, uEmA, sel), ACID2, chl);
    vec3 Ydim = mix(mix(uSpillB, uEmA, sel), ACID2, chl);          // a yellow / orange B is only shown bright
    // regions glow their own amount (some dim, some ablaze); more of them light up with intensity
    float glowCell = 0.6 + 0.4 * smoothstep(0.4 - 0.15 * vI, 0.7 - 0.12 * vI, nz);
    // SAFETY (§4.1, patterns): the Mandelbox repeats its sub-boxes (and the mirrored blocks) regularly; a
    // second, finer smooth random gain (~1.5-unit features) lights every sub-box its own amount, so the
    // repeated panels never line up into a periodic pattern of equally bright lights
    float subGain = uKind == 1 ? 0.55 + 0.45 * smoothstep(0.2, 0.8, vnoise(p * 0.7 + 13.0)) : 1.0;
    glowCell *= subGain;
    // grazing faces (the near field seen edge-on): their ornament is stretched into long smears, so its
    // light fades there
    float graze = smoothstep(0.04, 0.25, max(dot(n, -rd), 0.0));
    float sectorGain = 1.0;
    if (uKind == 0) {
      // kifs: every mirror sector of every ring is lit its own amount (no regular pattern of lights)
      float sa = (atan(p.y, p.x) / (2.0 * PI) + 0.5) * 2.0 * KN + 0.02 * uTime;
      float s0 = floor(sa);
      float sf = smoothstep(0.0, 1.0, fract(sa));
      float h0 = hash11(mod(s0, 2.0 * KN) + 17.0 * floor(tr.w)), h1 = hash11(mod(s0 + 1.0, 2.0 * KN) + 17.0 * floor(tr.w));
      sectorGain = 0.45 + 0.55 * mix(h0, h1, sf);
      glowCell *= sectorGain;
    }
    // surfaces: near-black in the deep palette colour; a dim headlamp gives the near walls form, a raking
    // light in the block's own colour comes from far down the hall, and the ornament spills its light
    // onto the face around it (glowing panels). The broad faces stay dark (difficult passage: darker).
    float fill = max(dot(n, -rd), 0.0);
    float key = max(dot(n, normalize(vec3(-0.4, 0.8, -0.45))), 0.0);
    vec3 Ld = uKind == 1 ? normalize(vec3(0.35, 0.25, 1.0)) : normalize(vec3(uPath - p.xy, 1.5));   // kifs: from the glowing axis ahead
    float rake = max(dot(n, Ld), 0.0);
    float kb = uKind == 1 ? 1.0 : 1.2;                          // the kifs nave is seen at grazing angles: a little more light
    float faceDim = 1.0 - 0.75 * chl;
    // the block's own base hue: the deep palette colour leaning towards its light X (a cyan block is a
    // deep blue, a pink block a deep magenta-violet: never a slate mixture of violet and cyan light)
    vec3 baseHue = mix(uDeep, X / max(dot(X, LUMA), 1e-4), 0.4 * (1.0 - chl));
    baseHue -= 0.9 * min(baseHue.r, min(baseHue.g, baseHue.b));    // full chroma (no grey part)
    baseHue /= max(dot(baseHue, LUMA), 1e-4);
    vec3 surf = uKind == 1 ? baseHue * ((0.026 + 0.008 * vI) + (0.05 * fill * fill + 0.012 * key) * exp(-t * 0.1))
                           : baseHue * ((0.008 + 0.004 * vI) + (0.02 * fill * fill + 0.006 * key) * exp(-t * 0.25));
    // (kifs: the raking light is the block's own light colour: each ring of the nave is a stained-glass panel)
    surf += uKind == 1 ? hueAt(baseHue / max(max(baseHue.r, baseHue.g), baseHue.b), (0.08 + 0.04 * vI) * rake * rake * glowCell)
                       : hueAt(X, (0.07 + 0.11 * vI) * rake * rake * glowCell);
    // glowing panels round the ornament (kifs: their light grows with intensity, 0.62 → 0.9 of the hue's ceiling)
    surf += glowAt(X, (uKind == 1 ? 0.76 + 0.04 * vI : 0.6 + 0.6 * vI) * pow(spillA, 0.7) * glowCell * orn * (1.0 - 0.6 * chl) * smoothstep(0.3, 1.0, calm) * (uKind == 1 ? smoothstep(0.06, 0.3, fill) : smoothstep(0.02, 0.15, fill)));
    vec3 M = X;
    if (uKind == 0) {
      // kifs: the broad faces are a dark mosaic of the two light colours, one per sub-cube of the first
      // two folds (stained glass: cyan and magenta panes side by side at EQUAL luminance, so the mosaic is
      // pure hue contrast), lit from the glowing axis ahead and brighter with intensity
      float hf = hash11(foldId * 0.731 + ringId * 3.17 + 0.5);
      vec3 Mc = hf > 0.5 ? X : Ydim;
      // (oranges / yellows / limes lean less: dim, they read as rust or olive)
      float warmM = clamp(2.0 * (min(Mc.r, Mc.g) - Mc.b) / max(max(Mc.r, Mc.g), 1e-3), 0.0, 1.0);
      M = deepOf(Mc, mix(0.75, 0.2, warmM));
      surf += M * ((0.02 + 0.04 * vI) * (0.35 + 0.65 * rake) * mix(0.6, 1.0, fract(hf * 9.7)) * smoothstep(0.02, 0.2, fill));
    }
    surf *= faceDim * sectorGain * mix(0.9, 1.1, fieldAct);
    if (uDbg > 1.5) dbgC = vec3(calm, ao, glowCell);
    surf = mix(uDeep * 0.003, surf, ao);                         // recesses sink into the base colour

    // emissive ornament: thin lines with a white-hot crest, finer jewels with intensity, sharp edges;
    // light flows slowly along it (≤ 0.3 Hz)
    float flow = 0.8 + 0.2 * sin(flowW + 2.0 * PI * nz2 + 0.7 * p.z + 0.5 * p.x);
    float lv = mix(0.7, 1.0, glowCell * sectorGain) * flow * orn * (0.88 + 0.12 * uPulse) * mix(0.25, 1.0, graze);
    // a soft glow body round each line (its light on the surface right next to it), then the line, then its crest
    // (kifs walls run along their trap planes over wide areas: a narrow body there, or whole faces would glow)
    float bw = uKind == 1 ? 4.0 * wl : 1.2 * wl;
    // (difficult passage: crisp lines without glow bodies: where the lace crowds on grazing faces the bodies
    // merged into pale blossoms)
    float bodyA = spillOf(ot.x, 1.0 / bw) * 0.22 * (1.0 - 0.8 * chl), bodyB = spillOf(ot.y, 1.0 / bw) * 0.18 * (1.0 - 0.8 * chl);
    // (kifs: the emissive gain grows with intensity, 0.9 → 1.3)
    float emK = uKind == 1 ? 1.0 : 0.8 + 0.5 * vI;
    float LA = (bodyA + lineA * (1.0 - bodyA)) * emCore * lv * (1.0 + 0.4 * chl) * emK;
    // intensity adds ornament in steps: v 5 = bold lines + panels in the block's colour, the second colour's
    // lines at half strength; v 7.5 the second colour at full strength and the finer jewels; v 9 the finest
    // filigree and whiter crests
    float yOn = mix(mix(0.45, 1.0, smoothstep(0.15, 0.6, vI)), 1.0, chl);
    float LB = (bodyB + lineB * (1.0 - bodyB)) * emCore * 0.8 * lv * yOn * emK;
    float LJ = jewel * emCore * 0.9 * lv;
    float LF = fine * emCore * (uKind == 1 ? 0.8 : 0.45) * lv;
    // (kifs: no edge emission; on the bumpy sponge the normal test outlines blotches, not rims)
    float LE = edge * (0.2 + 0.8 * nz) * mix(0.5, 1.0, ao) * emCore * 0.8 * lv * float(uKind);
    // line bodies keep their pure hue (never brighter than the hue itself: a broad pale line reads as
    // pastel); only the ~1-px crest runs white-hot at 0.7–0.9
    vec3 Yc = mix(Ydim, Y, smoothstep(0.12, 0.3, LB + LJ));
    // (kifs: the rims of the lace (sharp edges) glow in the second colour)
    // (kifs: the dense lace keeps pure hues in its bodies, and its second colour is a little weaker, so the
    // interleaved cyan and magenta lines never add up to a pale lilac rope)
    // (difficult passage: the two acid colours never overlap: crimson only where there is no cyan, so dense
    // lace stays two pure hues and never sums to a pale lilac)
    float yEx = 1.0 - 0.9 * max(chl, 1.0 - float(uKind)) * smoothstep(0.03, 0.25, LA + LE + LF);   // (kifs: always, its lace is dense)
    // (mandelbox: the jewels always shine in the second colour itself, so a warm accent of the palette (lunar
    // gold) shows as sparse bright jewels among the cool lines)
    vec3 emis = uKind == 1 ? glowAt(X, LA + LE + LF) + (glowAt(Yc, LB) + glowAt(mix(Yc, Y, smoothstep(0.1, 0.25, LJ)), LJ)) * yEx : glowAt(X, LA + LF) + hueAt(Yc, LB + 0.6 * LJ) * yEx;
    // (difficult passage: the crests stay at full chroma, acid lines on black)
    // (kifs: the crests of the dense lace stay jewel-coloured (a little hot), or the ring of lace reads pale)
    vec3 crestCol = uKind == 1 ? lightAt(X, emCrest * lv) : glowAt(X, emCrest * lv);
    emis = mix(emis, mix(crestCol, hueAt(X, emCrest * lv), chl), crestA * 0.9);
    // the second colour stays pure (its crest is its own hue at full strength: no white-hot core, so its
    // bloom never mixes with X into a pale lilac)
    // (difficult passage: the crimson lace gets a ~1-px hot core at 0.5–0.7 (a crimson line can carry only
    // ~0.26 at full chroma); its body stays pure crimson, so the lace reads as acid light, not pink)
    // (mandelbox: the second family's ~1-px crest is the second colour itself, so a warm palette accent such
    // as lunar gold runs as thin bright threads through the cool blocks)
    vec3 Ycr = uKind == 1 ? Y : Yc;
    emis = mix(emis, mix(hueAt(Ycr, emCrest * lv), glowAt(Yc, (0.45 + 0.15 * vI) * lv), chl), crestB * (1.0 - crestA) * 0.8 * yOn);
    float kc = smoothstep(0.25, 1.0, calm);
    vec3 c0 = surf + emis;
    // the dim band for fast-streaming (near) surfaces: a dark face in the base colour with only the
    // finest single-colour threads of light (soft knee at 0.09, hue kept; no pools, no second colour)
    // (kifs: towards the frame's edges the near walls stream past as sheaves of near-parallel threads,
    // which the pattern guard would see as stripes; there they fade into the dark peripheral frame)
    float thr = uKind == 1 ? 1.0 : 1.0 - 0.85 * smoothstep(0.95, 1.45, rho);
    // (difficult passage: the fast near field is black; its dim threads aliased into a teal speckle)
    thr *= 1.0 - chl;
    // (kifs: the near walls keep their dark mosaic hue, below 0.018: never a violet plateau, never counted
    // by the pattern guard, whose range floor is 0.02)
    vec3 cn = (uKind == 1 ? uDeep * (dot(surf, LUMA) * 0.5) : M * min(0.4 * dot(surf, LUMA), 0.018)) + hueAt(X, (lineA * emCore + crestA * emCrest + fine * emCore * float(uKind)) * lv * thr);
    c0 = mix(cn, c0, kc * kc);
    float L0 = max(dot(c0, LUMA), 1e-5);
    float Lnear = 0.09 * (1.0 - exp(-L0 / 0.09));
    col = c0 * (mix(Lnear, L0, kc) / L0);
  }
  float atten = exp(-t * fogK);
  if (through) {
    // kifs: the nave is a lantern: light beyond the walls shines through the kaleidoscopic lace (stained
    // glass in a dark room). Where the lace streams fast across the screen (the periphery) it stays dim.
    float sinT = sqrt(max(1e-4, 1.0 - rd.z * rd.z));
    float tw = KR / sinT;
    float pxsW = uSpeed * sinT / tw * (uRes.y / 1.5) * (1.0 + 0.5625 * rho * rho);
    float calmW = 1.0 - smoothstep(0.6, 1.6, pxsW / (uRes.y * 0.035));
    // (seen on the exact outer cylinder, not at the ray-march exit point, whose step jitter drew ripples)
    vec3 lc = lanternView(ro + rd * ((KR + 2.0 * KH + 0.03) / sinT), vI, chl, calmW);
    vec3 lan = lc * ((0.85 + 0.15 * uPulse) * exp(-tw * 0.06));
    float Ll = max(dot(lan, LUMA), 1e-5);
    col = lan * (mix(0.09 * (1.0 - exp(-Ll / 0.09)), Ll, smoothstep(0.25, 1.0, calmW)) / Ll);
  } else {
    // distance: everything sinks into the faint coloured depth glow (a depth cue that darkens)
    col = mix(fogCol, col, hit ? atten : 0.0);
  }
  // the air glow near the ornament; capped, because a ray skimming along a surface (the near floor and
  // ceiling seen edge-on) would gather it into long bright smears
  vec3 hg = halo * (0.5 + 0.5 * vI) * (0.9 + 0.1 * uPulse);
  float hl = dot(hg, LUMA);
  col += hg * (0.08 * (1.0 - exp(-hl / 0.08)) / max(hl, 1e-5));

  // SAFETY (§4.1, patterns): toward the vanishing point of the nave the wall rings and the mirror
  // sectors shrink into a periodic pattern a few tens of pixels across. Where the ring period on screen
  // falls below ~140 px (at 720p; the rings are irregular, 0.6–1.4× that) the luminance is compressed in
  // the log domain around a smooth level (hue and chroma kept): that structure stays within Lmax ≈ 2.2·Lmin
  // and the far nave dissolves into a soft glow. (The ring period follows from the angle to the nave axis,
  // so it also holds with mouse look.)
  if (uKind == 0 && rd.z > 0.05) {
    float tanT = sqrt(max(0.0, 1.0 - rd.z * rd.z)) / rd.z;
    float rv = tanT / 0.75;
    float ringPx = 0.75 * rv * rv * (2.0 * KH) / KR * 0.5 * uRes.y;
    float lod = smoothstep(80.0, 30.0, ringPx * 720.0 / uRes.y);
    float tw = KR * sqrt(1.0 + tanT * tanT) / max(tanT, 1e-3);
    float Lt = (0.015 + 0.02 * vI) * exp(-tw * fogK) + 0.002;
    float Lc = max(dot(col, LUMA), 1e-5);
    col *= Lt * pow(Lc / Lt, 1.0 - 0.85 * lod) / Lc;
  }

  // stable peripheral frame: the screen edges sink into darkness (fixed to the screen, never moves)
  float frame = 1.0 - 0.55 * smoothstep(0.75, 2.0, length(sp * vec2(0.85, 1.0)));
  col *= frame;

  // no near-white: a luminance ceiling 0.9; out-of-gamut cores turn white-hot at the same luminance
  float L = dot(col, LUMA);
  if (L > 0.9) col *= 0.9 / L;
  float m = max(col.r, max(col.g, col.b));
  if (m > 1.0) { float l2 = dot(col, LUMA); col = mix(vec3(l2), col, (1.0 - l2) / max(m - l2, 1e-4)); }
  if (uDbg > 0.5) col = dbgC * 0.5;
  col += (hash12(gl_FragCoord.xy) - 0.5) * 0.002;              // static dither against banding
  gl_FragColor = vec4(max(col, 0.0), clamp(uWeight, 0.0, 1.0));
}
