// Placeholder layer shader (M3 walking skeleton). One soft, low-contrast full-screen pattern per
// layer, clearly tinted, modulated by the shared pulse and the visual intensity. Safety at source
// (BUILD.md 4.1): soft edges, pattern contrast well below 0.5, motion and drift far below 2 Hz,
// mean luminance capped. Later agents replace each layer's internals.
precision highp float;
varying vec2 vUv;
uniform float uTime;       // wall seconds since the trip started
uniform float uPulse;      // 0-1 shared oscillator
uniform float uIntensity;  // visual intensity / 10
uniform float uWeight;     // this layer's weight
uniform float uEyes;       // eyes closed 0-1
uniform float uChallenge;  // difficult passage level 0-1
uniform float uEntity;     // entity presence 0-1
uniform float uAspect;
uniform vec2 uLook;        // yaw, pitch (radians)
uniform vec3 uTint;
uniform vec3 uTint2;
uniform int uMode;         // 0 room, 1 form constants, 2 chrysanthemum, 3 waiting room, 4 breakthrough
uniform sampler2D uRoom;
uniform float uHasRoom;

const float PI = 3.14159265;

vec3 defaultRoom(vec2 uv) {
  // simple procedural interior: wall, floor, a window
  vec3 wall = vec3(0.16, 0.12, 0.08);
  vec3 floorC = vec3(0.09, 0.06, 0.035);
  float horizon = 0.32;
  vec3 c = uv.y < horizon ? floorC * (0.7 + 0.3 * uv.y / horizon) : wall * (0.85 + 0.15 * uv.y);
  vec2 w = abs(uv - vec2(0.68, 0.62));
  float win = 1.0 - smoothstep(0.0, 0.01, max(w.x - 0.11, w.y - 0.14));
  c = mix(c, vec3(0.45, 0.48, 0.5), win * 0.6);
  return c;
}

void main() {
  vec2 uv = vUv + vec2(uLook.x, uLook.y) * 0.05;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) + vec2(uLook.x, uLook.y) * 0.15;
  float r = length(p) + 1e-4;
  float th = atan(p.y, p.x);
  float v = uIntensity;
  float t = uTime;
  float pulse = uPulse;
  vec3 col;
  float a = uWeight;

  if (uMode == 0) {
    // room: the photo (or default room), breathing a little with the pulse; fades to a dark
    // phosphene field as the eyes close
    vec2 q = uv + 0.004 * v * vec2(sin(uv.y * 6.0 + t * 0.4), cos(uv.x * 6.0 + t * 0.35)) * (0.5 + pulse);
    vec3 room = uHasRoom > 0.5 ? texture2D(uRoom, q).rgb : defaultRoom(q);
    float sat = 1.0 + v * 0.6;
    float lum = dot(room, vec3(0.2126, 0.7152, 0.0722));
    room = mix(vec3(lum), room, sat) * mix(vec3(1.0), uTint, 0.25 * v);
    vec3 phos = uTint * 0.05 * (0.6 + 0.4 * sin(r * 6.0 - t * 0.3)) * (0.5 + 0.5 * pulse);
    col = mix(room, phos, uEyes);
    a = 1.0;
  } else if (uMode == 1) {
    // form constants: soft log-polar stripes (tunnels/spirals), contrast <= 0.35
    float s = 0.5 + 0.5 * cos(9.0 * log(r) + 3.0 * th - t * 0.6);
    col = mix(uTint2 * 0.12, uTint * 0.3, 0.32 + 0.35 * s) * (0.85 + 0.15 * pulse);
  } else if (uMode == 2) {
    // chrysanthemum: soft radial petals
    float pet = 0.5 + 0.5 * cos(7.0 * th + 4.0 * log(r) - t * 0.4);
    col = mix(uTint2 * 0.15, uTint * 0.35, 0.3 + 0.35 * pet * smoothstep(0.0, 0.5, r)) * (0.85 + 0.15 * pulse);
  } else if (uMode == 3) {
    // waiting room: slow concentric chambers receding (constant-velocity drift)
    float ring = 0.5 + 0.5 * cos(14.0 * r * (1.0 + 0.2 * pulse) - t * 0.5);
    col = mix(uTint2 * 0.12, uTint * 0.3, 0.3 + 0.3 * ring);
  } else {
    // breakthrough: warm open dome with a soft presence when an entity is here
    float dome = smoothstep(1.2, 0.0, r);
    col = mix(uTint2 * 0.1, uTint * 0.35, dome) * (0.85 + 0.15 * pulse);
    float ent = exp(-pow(r / (0.12 + 0.02 * pulse), 2.0)) * uEntity;
    col += uTint2 * 0.25 * ent;
  }
  // difficult passage: harsher, cooler, never brighter
  col = mix(col, col.bgr * 0.8, 0.5 * uChallenge);
  col = min(col, vec3(0.6));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
