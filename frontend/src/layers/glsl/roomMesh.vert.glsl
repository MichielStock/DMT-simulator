// Room layer: depth-displaced mesh (photo plane or panorama sphere). Requires NOISE_GLSL (layers/noise.ts).
// Depth: white = near. Every vertex slides along its view ray from the rest eye (camera origin), so the
// rest view is the undistorted photo and parallax appears only when the user moves the mouse.
// The depth used for displacement is a blurred mip level, so depth edges stretch smoothly instead of tearing.
// Breathing: slow 3-D noise displacement along the surface normal, scaled by distortion and state.pulse.
varying vec2 vUv;
varying float vDepth;
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform float uDepthAmt;
uniform float uDepthPivot;
uniform float uDepthGamma;
uniform float uDepthLod;
uniform float uEdgeFade;
uniform float uKind;        // 0 plane, 1 sphere
uniform float uFxTime;      // effect time (wall seconds, slowed/sped by the challenge factor)
uniform float uBreathe;     // 0-1
uniform float uBreathScale; // world units at full breathing
uniform float uPulse;       // 0-1 shared oscillator
uniform float uBreathHz;    // speed along the noise time axis

float depthAt(vec2 uv) {
  if (uHasDepth < 0.5) return mix(0.7, 0.25, uv.y);   // no depth map: floor near, ceiling far
  return textureLod(uDepth, uv, uDepthLod).r;
}

void main() {
  vUv = uv;
  float d = depthAt(uv);
  vDepth = d;
  float e = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  float att = uEdgeFade > 0.0 ? smoothstep(0.0, uEdgeFade, e) : 1.0;
  if (uKind > 0.5) att *= smoothstep(0.0, 0.08, uv.y) * smoothstep(0.0, 0.08, 1.0 - uv.y);  // calm poles
  float disp = uDepthAmt * (pow(clamp(d, 0.0, 1.0), uDepthGamma) - uDepthPivot) * att;
  vec3 p = position * (1.0 - disp);

  // breathing along the normal (towards the eye for the rest surface), plus a little tangential swell
  vec3 toward = -normalize(p);
  vec3 np = uKind > 0.5 ? normalize(position) * 2.2 : position * 1.7;
  float t = uFxTime * uBreathHz;
  float b = hs_snoise3(np + vec3(0.0, 0.0, t));
  float amp = uBreathe * uBreathScale * (0.6 + 0.4 * uPulse) * mix(0.35, 1.0, att);
  p += toward * b * amp;
  vec3 sw = hs_curl3(np * 0.8 + vec3(t * 0.7, 0.0, 3.1));
  p += (sw - toward * dot(sw, toward)) * amp * 0.45;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
