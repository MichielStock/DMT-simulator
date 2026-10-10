// Room layer: the built-in procedural interior (BUILD.md 8.1 "Skip"), baked once into a colour and a
// depth texture that then go through exactly the same displaced-mesh path as a photo.
// A quiet corner of a room: plank floor with a rug, two plaster walls, a window on the left wall with
// soft daylight falling across the floor, a sheer curtain and a framed picture. Ray-cast box, linear RGB.
varying vec2 vUv;
uniform float uOut;      // 0: colour (linear RGB), 1: depth (white = near)
uniform float uAspect;   // bake aspect (w / h)

const vec3 RMIN = vec3(-2.0, 0.0, -4.6);
const vec3 RMAX = vec3(2.3, 2.75, 1.6);
const vec3 CAM = vec3(1.05, 1.42, 0.55);
const float YAW = -0.42;    // turned left towards the corner
const float PITCH = -0.10;
const float TANF = 0.52;    // tan(half vertical fov)

// window on the left wall (x = RMIN.x)
const vec2 WZ = vec2(-3.55, -1.45);
const vec2 WY = vec2(0.85, 2.25);
const vec3 SUN = vec3(0.86, -0.46, -0.22);   // direction the light travels (normalised below)

float box2(vec2 p, vec2 lo, vec2 hi) {        // signed distance to an axis-aligned rectangle
  vec2 c = 0.5 * (lo + hi), h = 0.5 * (hi - lo);
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// 0..1 daylight passing through the window panes (minus the frame and the mullions) at (z, y) on the left wall
float windowPass(vec2 zy, float soft) {
  float open = 1.0 - smoothstep(-soft, soft, box2(zy, vec2(WZ.x, WY.x), vec2(WZ.y, WY.y)));
  float zc = 0.5 * (WZ.x + WZ.y), yc = 0.5 * (WY.x + WY.y) + 0.12;
  float bars = smoothstep(0.025 + soft, 0.025 - soft * 0.5, abs(zy.x - zc)) + smoothstep(0.02 + soft, 0.02 - soft * 0.5, abs(zy.y - yc));
  return open * (1.0 - 0.85 * clamp(bars, 0.0, 1.0));
}

float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 d = normalize(vec3(ndc.x * TANF * uAspect, ndc.y * TANF, -1.0));
  float cp = cos(PITCH), sp = sin(PITCH);
  d = vec3(d.x, cp * d.y - sp * d.z, sp * d.y + cp * d.z);
  float cy = cos(YAW), sy = sin(YAW);
  d = vec3(cy * d.x - sy * d.z, d.y, sy * d.x + cy * d.z);

  // ray-box exit (camera inside)
  vec3 tA = (RMIN - CAM) / d, tB = (RMAX - CAM) / d;
  vec3 tf = max(tA, tB);
  float t = min(tf.x, min(tf.y, tf.z));
  vec3 P = CAM + d * t;
  int face; // 0 floor, 1 ceiling, 2 left, 3 right, 4 back, 5 front
  if (t == tf.y) face = d.y < 0.0 ? 0 : 1;
  else if (t == tf.x) face = d.x < 0.0 ? 2 : 3;
  else face = d.z < 0.0 ? 4 : 5;

  if (uOut > 0.5) {
    float dep = clamp((1.0 / t - 1.0 / 7.5) / (1.0 / 1.2 - 1.0 / 7.5), 0.0, 1.0);
    gl_FragColor = vec4(vec3(dep), 1.0);
    return;
  }

  vec3 L = normalize(SUN);
  vec3 plaster = vec3(0.50, 0.40, 0.30);
  vec3 col;
  float sunlit = 0.0;
  // sunlight reaching P through the window
  if (face != 2) {
    float s = (P.x - RMIN.x) / L.x;              // distance back along the light to the window plane
    vec3 Q = P - L * s;
    sunlit = windowPass(Q.zy, 0.02 + 0.035 * s) * step(0.0, s);
  }
  // ambient: daylight bouncing from the window, falling off across the room, plus soft corner occlusion
  vec3 wc = vec3(RMIN.x, 0.5 * (WY.x + WY.y), 0.5 * (WZ.x + WZ.y));
  float amb = 0.30 + 0.70 * exp(-length(P - wc) / 2.6);
  float ao = 1.0;
  ao *= mix(0.55, 1.0, smoothstep(0.0, 0.7, P.y));
  ao *= mix(0.62, 1.0, smoothstep(0.0, 0.6, P.x - RMIN.x));
  ao *= mix(0.62, 1.0, smoothstep(0.0, 0.6, RMAX.x - P.x));
  ao *= mix(0.62, 1.0, smoothstep(0.0, 0.6, P.z - RMIN.z));
  ao *= mix(0.75, 1.0, smoothstep(0.0, 0.5, RMAX.y - P.y));

  if (face == 0) {
    // oak planks running into the room, a muted rug
    float pw = 0.19;
    float pid = floor((P.x + 10.0) / pw);
    float off = h1(pid) * 2.0;
    float seg = floor((P.z + off) / 1.4);
    float tint = 0.85 + 0.25 * h1(pid * 3.1 + seg * 7.7);
    float grain = 0.92 + 0.08 * sin((P.z + off) * 9.0 + sin(P.x * 40.0 + pid) * 1.5);
    float fx = fract((P.x + 10.0) / pw), fz = fract((P.z + off) / 1.4);
    float seam = smoothstep(0.0, 0.01, min(fx, 1.0 - fx) * pw);
    float seamZ = smoothstep(0.0, 0.008, min(fz, 1.0 - fz) * 1.4);
    col = vec3(0.30, 0.17, 0.085) * tint * grain * mix(0.6, 1.0, min(seam, seamZ));
    float rug = box2(P.xz, vec2(-1.15, -3.55), vec2(1.25, -1.35));
    float rugIn = 1.0 - smoothstep(-0.01, 0.01, rug);
    float border = smoothstep(-0.2, -0.17, rug) * (1.0 - smoothstep(-0.12, -0.09, rug));
    vec3 rugC = mix(vec3(0.33, 0.15, 0.11), vec3(0.42, 0.33, 0.24), border);
    rugC *= 0.92 + 0.08 * h1(floor(P.x * 60.0) + floor(P.z * 60.0) * 13.0);
    col = mix(col, rugC, rugIn);
  } else if (face == 1) {
    col = vec3(0.55, 0.48, 0.40);
  } else if (face == 2) {
    // left wall with the window
    col = plaster * vec3(0.96, 0.98, 1.0);
    float frameD = box2(P.zy, vec2(WZ.x, WY.x), vec2(WZ.y, WY.y));
    float glass = windowPass(P.zy, 0.004);
    float frame = (1.0 - smoothstep(0.05, 0.06, abs(frameD + 0.0))) * (1.0 - glass);
    vec3 sky = mix(vec3(0.70, 0.74, 0.62), vec3(0.62, 0.74, 0.88), smoothstep(WY.x, WY.y, P.y));
    // soft distant greenery in the lower panes
    float leaves = smoothstep(1.55, 1.0, P.y + 0.15 * sin(P.z * 5.0) + 0.1 * sin(P.z * 13.0 + 1.0));
    sky = mix(sky, vec3(0.30, 0.42, 0.24), 0.55 * leaves);
    col = mix(col, vec3(0.78, 0.74, 0.68), frame);
    col = mix(col, sky, glass);
    // sheer curtains either side of the window
    float cz1 = smoothstep(WZ.x - 0.42, WZ.x - 0.38, P.z) * (1.0 - smoothstep(WZ.x - 0.02, WZ.x + 0.02, P.z));
    float cz2 = smoothstep(WZ.y - 0.02, WZ.y + 0.02, P.z) * (1.0 - smoothstep(WZ.y + 0.38, WZ.y + 0.42, P.z));
    float cy = smoothstep(0.08, 0.12, P.y) * (1.0 - smoothstep(2.48, 2.52, P.y));
    float folds = 0.9 + 0.1 * sin(P.z * 55.0 + 0.6 * sin(P.y * 3.0));
    col = mix(col, vec3(0.74, 0.68, 0.58) * folds, (cz1 + cz2) * cy * 0.9);
    if (glass > 0.5) amb = 1.0;
  } else if (face == 3) {
    col = plaster * vec3(1.0, 0.97, 0.93);
  } else {
    col = plaster;
    // a framed picture on the back wall
    vec2 pc = vec2(0.35, 1.55), ph = vec2(0.5, 0.36);
    float fd = box2(P.xy, pc - ph, pc + ph);
    float canvasIn = 1.0 - smoothstep(-0.055, -0.05, fd);
    float frameIn = (1.0 - smoothstep(-0.003, 0.003, fd)) * (1.0 - canvasIn);
    vec2 q = (P.xy - pc) / ph;
    vec3 art = mix(vec3(0.55, 0.38, 0.22), vec3(0.20, 0.33, 0.36), smoothstep(-0.6, 0.6, q.x + 0.4 * sin(q.y * 2.0)));
    art = mix(art, vec3(0.62, 0.52, 0.34), smoothstep(0.35, 0.0, length(q - vec2(0.35, 0.25))));
    col = mix(col, vec3(0.12, 0.08, 0.05), frameIn);
    col = mix(col, art, canvasIn);
  }
  // skirting boards
  if (face >= 2 && face <= 4) col = mix(col, vec3(0.62, 0.58, 0.52), smoothstep(0.125, 0.115, P.y) * (face == 2 && windowPass(P.zy, 0.004) > 0.5 ? 0.0 : 1.0));

  vec3 sunC = vec3(1.0, 0.86, 0.66);
  vec3 lit = (face == 2 && windowPass(P.zy, 0.004) > 0.5) ? col : col * mix(vec3(0.82, 0.86, 1.0), vec3(1.0), 0.6) * amb * ao * 0.9 + col * sunC * 1.35 * sunlit;
  // gentle vignette of the bake itself
  float vig = 1.0 - 0.28 * dot(ndc * vec2(0.8, 1.0), ndc * vec2(0.8, 1.0));
  lit *= vig;
  lit = min(lit, vec3(0.88));
  gl_FragColor = vec4(lit, 1.0);
}
