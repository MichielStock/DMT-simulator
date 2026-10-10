// Shared GLSL noise snippets (exported as strings). Owned by the room layer; other layers may import
// them read-only. Keep this API stable: names are prefixed `hs_` to avoid collisions, and the whole
// block is wrapped in an include guard so it can be pasted into a shader more than once.
//
//   float hs_hash12(vec2 p)            hash in [0,1)
//   vec2  hs_hash22(vec2 p)            hash in [0,1)^2
//   float hs_hash13(vec3 p)            hash in [0,1)
//   float hs_snoise2(vec2 p)           2-D simplex noise, about [-1,1]
//   float hs_snoise3(vec3 p)           3-D simplex noise, about [-1,1]
//   float hs_fbm3(vec3 p)              4-octave fBm of hs_snoise3, about [-1,1]
//   vec2  hs_curl2(vec2 p, float t)    divergence-free 2-D flow (curl of a noise potential), |v| ~ 1
//   vec3  hs_curl3(vec3 p)             divergence-free 3-D flow, |v| ~ 1
//
// Simplex noise after Ashima Arts / Stefan Gustavson (MIT licence, webgl-noise).
// Safety note: these functions are static in space; any temporal frequency comes from how the caller
// moves through them (keep it <= 0.5 Hz for full-screen modulation, BUILD.md section 4.1).

export const NOISE_HASH_GLSL = /* glsl */ `
float hs_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hs_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hs_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const NOISE_SIMPLEX_GLSL = /* glsl */ `
vec3 hs_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 hs_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 hs_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 hs_permute(vec3 x) { return hs_mod289(((x * 34.0) + 10.0) * x); }
vec4 hs_permute(vec4 x) { return hs_mod289(((x * 34.0) + 10.0) * x); }
vec4 hs_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float hs_snoise2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = hs_mod289(i);
  vec3 p = hs_permute(hs_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float hs_snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = hs_mod289(i);
  vec4 p = hs_permute(hs_permute(hs_permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = hs_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const NOISE_FBM_CURL_GLSL = /* glsl */ `
float hs_fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * hs_snoise3(p);
    p = p * 2.03 + vec3(17.1, 31.7, 9.3);
    a *= 0.5;
  }
  return s / 0.9375;
}
vec2 hs_curl2(vec2 p, float t) {
  const float e = 0.05;
  float n1 = hs_snoise3(vec3(p.x, p.y + e, t));
  float n2 = hs_snoise3(vec3(p.x, p.y - e, t));
  float n3 = hs_snoise3(vec3(p.x + e, p.y, t));
  float n4 = hs_snoise3(vec3(p.x - e, p.y, t));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e) * 0.25;
}
vec3 hs_curl3(vec3 p) {
  // potential P = (P1, P2, P3): the same noise at three offsets; curl P = (dP3/dy - dP2/dz, dP1/dz - dP3/dx, dP2/dx - dP1/dy)
  const float e = 0.05;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 o2 = vec3(31.4, 17.2, 5.9), o3 = vec3(-11.3, 43.1, 23.7);
  float dP1dy = hs_snoise3(p + dy) - hs_snoise3(p - dy);
  float dP1dz = hs_snoise3(p + dz) - hs_snoise3(p - dz);
  float dP2dx = hs_snoise3(p + o2 + dx) - hs_snoise3(p + o2 - dx);
  float dP2dz = hs_snoise3(p + o2 + dz) - hs_snoise3(p + o2 - dz);
  float dP3dx = hs_snoise3(p + o3 + dx) - hs_snoise3(p + o3 - dx);
  float dP3dy = hs_snoise3(p + o3 + dy) - hs_snoise3(p + o3 - dy);
  return vec3(dP3dy - dP2dz, dP1dz - dP3dx, dP2dx - dP1dy) / (2.0 * e) * 0.25;
}
`;

/** Everything above, include-guarded. Paste once (or more) before code that uses `hs_*`. */
export const NOISE_GLSL = `
#ifndef HS_NOISE_GLSL
#define HS_NOISE_GLSL
${NOISE_HASH_GLSL}
${NOISE_SIMPLEX_GLSL}
${NOISE_FBM_CURL_GLSL}
#endif
`;

export default NOISE_GLSL;
