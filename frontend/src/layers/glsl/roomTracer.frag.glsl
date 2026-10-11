// Room layer: tracers. Temporal feedback of the previous room frame while the camera moves.
// uFeedback <= exp(-dt / 0.08 s): a trail decays to < 1 % within 0.5 s; it is a low-pass, it cannot flash.
// Alpha carries the glow emission (roomMesh.frag.glsl) to the bloom in roomFinal.frag.glsl.
varying vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform float uFeedback;
void main() {
  vec4 c = texture2D(uCur, vUv);
  vec4 p = texture2D(uPrev, vUv);
  gl_FragColor = mix(c, p, clamp(uFeedback, 0.0, 0.95));
}
