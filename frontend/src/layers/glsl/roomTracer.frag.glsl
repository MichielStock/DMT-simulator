// Room layer: tracers. Temporal feedback of the previous room frame while the camera moves.
// uFeedback <= exp(-dt / 0.08 s): a trail decays to < 1 % within 0.5 s; it is a low-pass, it cannot flash.
varying vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform float uFeedback;
void main() {
  vec3 c = texture2D(uCur, vUv).rgb;
  vec3 p = texture2D(uPrev, vUv).rgb;
  gl_FragColor = vec4(mix(c, p, clamp(uFeedback, 0.0, 0.95)), 1.0);
}
