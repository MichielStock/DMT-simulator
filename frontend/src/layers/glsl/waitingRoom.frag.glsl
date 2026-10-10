// Waiting room (BUILD.md §11.6): a ray-marched kaleidoscopic fractal interior — a kaleidoscopic IFS
// (Menger-type folds with slowly turning fold planes, kind 0) or a Mandelbox (kind 1) — repeated through
// space with a corridor carved along +z, through which the camera drifts at constant velocity with a
// stable horizon (BUILD.md §4.5; only mouse look rotates the view). Output LINEAR RGB, alpha = weight.
//
// Safety at source (BUILD.md §4.1): luminance is a bounded factor of a slowly varying base, so local
// Michelson contrast stays ≈ ≤ 0.4; no near-white; pulse glow ≤ ~10 % of luminance, ≤ 0.5 Hz; the drift
// passes one repetition cell every ~15 s, far below 2 Hz.
precision highp float;
varying vec2 vUv;

uniform vec2 uRes;
uniform float uWeight;
uniform float uTime;
uniform float uPulse;
uniform float uIntensity;
uniform float uChallenge;
uniform vec2 uLook;            // yaw, pitch (rad)
uniform vec3 uCam;             // camera position (constant velocity along +z)
uniform vec2 uPath;            // x,y of the drift line (the nave is carved around it)
uniform int uKind;             // 0 kifs, 1 mandelbox
uniform float uMorph;          // slow morph phase (rad)
uniform float uSteps;          // max ray-march steps (quality knob)
uniform float uFar;            // far distance
uniform vec3 uPal[5];          // LINEAR, normalised to luminance 0.2
uniform vec3 uFog;             // fog chroma (luminance 0.2)
uniform sampler2D uField;
uniform float uHasField;

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 atLum(vec3 c, float L) {
  float l = max(dot(c, LUMA), 1e-4);
  c *= L / l;
  float m = max(c.r, max(c.g, c.b));
  if (m > 0.92) c = mix(vec3(L), c, (0.92 - L) / max(m - L, 1e-4));
  return c;
}

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

float sdBox2(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

// ---- kind 0: kaleidoscopic IFS (Menger folds with turning fold planes). Cell = [-1,1]^3.
vec2 polarFold(vec2 v, float n) {
  // mirror-fold the plane into a wedge of angle π/n (kaleidoscope around the drift axis)
  float w = PI / n;
  float a = atan(v.y, v.x);
  a = abs(mod(a + w, 2.0 * w) - w);
  return length(v) * vec2(cos(a), sin(a));
}

float deKifs(vec3 p, out float trap) {
  vec3 pk = vec3(polarFold(p.xy, 8.0), p.z);
  vec3 q = mod(pk + 1.0, 2.0) - 1.0;
  float d = max(max(abs(q.x), abs(q.y)), abs(q.z)) - 1.0;
  float s = 1.0;
  trap = 0.0;
  float tw = 0.3 * sin(uMorph) + 0.3 * uChallenge;
  for (int m = 0; m < 4; m++) {
    vec3 a = mod(q * s, 2.0) - 1.0;
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float da = max(r.x, r.y), db = max(r.y, r.z), dc = max(r.z, r.x);
    float c = (min(da, min(db, dc)) - 1.0) / s;
    if (c > d) { d = c; trap = float(m) + 0.25 * clamp(dot(a, a), 0.0, 1.0); }   // which level made this wall
    q.xy = rot(tw * (float(m) + 1.0) * 0.35) * q.xy;               // kaleidoscopic twist per level
  }
  // the nave: a corridor carved along z through the cell centres (the camera's path)
  float nave = length(p.xy - uPath) - (0.16 - 0.03 * uChallenge);
  return max(d, -nave);
}

// ---- kind 1: Mandelbox (scale −2.2 ± morph), mirrored-repeated cells of half-size 4.
float deMandelbox(vec3 p, out float trap) {
  vec3 c = 4.0 - abs(mod(p + 4.0, 16.0) - 8.0);          // mirrored repetition (half-cell 4), continuous
  vec3 z = c;
  float dr = 1.0;
  float scale = -2.2 + 0.06 * sin(uMorph) - 0.12 * uChallenge;
  trap = 1e3;
  for (int i = 0; i < 9; i++) {
    z = clamp(z, -1.0, 1.0) * 2.0 - z;                    // box fold
    float r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }               // sphere fold (min r² 0.25, fixed r² 1)
    else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * scale + c;
    dr = dr * abs(scale) + 1.0;
    trap = min(trap, r2);
  }
  float d = length(z) / abs(dr);
  float nave = length(p.xy - uPath) - (0.3 - 0.05 * uChallenge);
  return max(d, -nave);
}

float de(vec3 p, out float trap) {
  if (uKind == 1) return deMandelbox(p, trap);
  return deKifs(p, trap);
}
float de0(vec3 p) { float t; return de(p, t); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 sp = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float rho = length(sp);
  float phi = atan(sp.y, sp.x);

  // camera: forward +z, stable horizon; only the user's mouse look turns it
  vec3 rd = normalize(vec3(sp * 0.75, 1.0));
  // mandelbox: a fixed oblique gaze (constant, no roll) so block faces are seen in perspective
  // instead of head-on; the drift stays along +z at constant velocity
  if (uKind == 1) { rd.yz = rot(0.16) * rd.yz; rd.xz = rot(0.42) * rd.xz; }
  rd.yz = rot(-uLook.y) * rd.yz;
  rd.xz = rot(-uLook.x) * rd.xz;
  vec3 ro = uCam;

  // ray march with a clamped, slightly under-relaxed step; glow accumulates near surfaces
  float t = 0.0;
  float d = 1.0;
  float trap = 0.0;
  float glow = 0.0;
  float steps = 0.0;
  bool hit = false;
  for (int i = 0; i < 160; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * t;
    d = de(p, trap);
    float eps = 0.0012 + 0.0025 * t;               // ~ one pixel cone
    if (d < eps) { hit = true; break; }
    glow += exp(-d * 30.0) * 0.012;
    t += clamp(d * 0.85, eps * 0.5, 0.6);
    steps += 1.0;
    if (t > uFar) break;
  }

  // neural field through the retino-cortical map (coupling)
  float fieldAct = 0.5;
  if (uHasField > 0.5) {
    vec2 fuv = vec2((log(rho + 0.05) - log(0.05)) / (log(2.2) - log(0.05)), phi / (2.0 * PI) + 0.5);
    fieldAct = texture2D(uField, fuv).r;
  }

  // intensity 7.5 -> 10 opens the room up: brighter emissive edges, more glow (v below 7 is only seen
  // when the layer is forced)
  float vI = smoothstep(0.5, 1.0, uIntensity);
  float fogAmt = 1.0 - exp(-t * (uKind == 1 ? 0.07 : 0.2) * (1.0 + 0.5 * uChallenge));
  vec3 chroma = uFog;
  float F = 0.7;
  float emis = 0.0;
  if (hit) {
    vec3 p = ro + rd * t;
    // soft normals: tetrahedral gradient with an epsilon growing with distance
    float e = 0.003 + 0.005 * t;
    vec2 k = vec2(1.0, -1.0);
    vec3 n = normalize(k.xyy * de0(p + k.xyy * e) + k.yyx * de0(p + k.yyx * e) +
                       k.yxy * de0(p + k.yxy * e) + k.xxx * de0(p + k.xxx * e));
    // a coarser normal: where the two disagree the surface turns sharply -> an emissive edge
    float e2 = 4.0 * e;
    vec3 n2 = normalize(k.xyy * de0(p + k.xyy * e2) + k.yyx * de0(p + k.yyx * e2) +
                        k.yxy * de0(p + k.yxy * e2) + k.xxx * de0(p + k.xxx * e2));
    float edge = smoothstep(0.02, 0.25, 1.0 - dot(n, n2)) * exp(-t * 0.1);
    // ambient occlusion (3 taps along the normal)
    float ao = 0.0;
    float sc = uKind == 1 ? 0.1 : 0.025;
    for (int j = 1; j <= 3; j++) {
      float h = sc * float(j);
      ao += max(0.0, h - de0(p + n * h)) / h;
    }
    ao = clamp(1.0 - ao / 3.0, 0.0, 1.0);
    // key light from above-left behind the viewer, a headlamp fill, ambient
    float key = max(dot(n, normalize(vec3(-0.45, 0.75, -0.5))), 0.0);
    float fill = max(dot(n, -rd), 0.0);
    float s = (0.5 * key + 0.35 * fill + 0.15) * (0.25 + 0.75 * ao);
    float hue = uKind == 1 ? 0.9 * sqrt(trap) + 0.6 * n.y + 0.3 * n.x + 0.1 * p.z : trap * 1.5 + 0.45 * (n.x + n.z) + 0.05 * p.z;
    hue += 0.12 * fieldAct + uTime * 0.008;
    chroma = palette(hue);
    F = 0.62 + 0.8 * s;                            // ~0.62 .. 1.42: dark recesses, lit faces
    F *= 0.95 + 0.1 * fieldAct;                    // the neural field breathes on the walls
    emis = edge * (0.35 + 0.65 * vI) * (0.85 + 0.15 * uPulse);
    chroma = mix(chroma, palette(hue + 2.0), 0.8 * emis);   // edges glow in a complementary palette colour
    F += 0.55 * emis;
  }
  // atmospheric depth: towards a dark, saturated fog colour (never a grey veil)
  // hue fog thinner than the luminance fade, so the near and middle distance keep their own colours
  chroma = mix(chroma, uFog, (1.0 - exp(-t * (uKind == 1 ? 0.04 : 0.12))) * 0.75);
  F = mix(F, 0.7, fogAmt * 0.8);
  float depthL = 0.42 + 0.58 * exp(-t * (uKind == 1 ? 0.07 : 0.24));
  // pulse-driven glow near surfaces (follows the <= 0.5 Hz pulse), stronger at high intensity
  float g = clamp(glow, 0.0, 1.0);
  F += g * (0.08 + 0.1 * uPulse) * (0.6 + 0.4 * vI);
  chroma = mix(chroma, palette(1.0), g * 0.4);

  // base luminance: dark (saturated hues stay saturated), slow radial falloff (a soft peripheral
  // frame), so local contrast stays bounded: F in [0.66, 1.45] -> Michelson <= 0.37 + base drift
  float B = 0.12 * (0.9 + 0.2 * vI) * depthL * (1.0 - 0.25 * smoothstep(0.6, 2.0, rho));
  float L = B * clamp(F, 0.66, 1.45);
  vec3 col = atLum(chroma, L);

  // difficult passage: harsher hue, slightly darker (never brighter)
  if (uChallenge > 0.001) {
    vec3 harsh = atLum(col.brg * vec3(1.0, 0.8, 1.0), L * (0.9 - 0.15 * uChallenge));
    col = mix(col, harsh, 0.65 * uChallenge);
  }
  // static dither against banding in the fog gradients
  col += (hash12(gl_FragCoord.xy) - 0.5) * 0.0025;
  gl_FragColor = vec4(max(col, 0.0), clamp(uWeight, 0.0, 1.0));
}
