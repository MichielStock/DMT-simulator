// Room layer: drifting. Texture-coordinate offsets advected by a slowly evolving curl-noise flow
// (semi-Lagrangian step, ping-pong), relaxing back to zero with time constant uTau. Offsets are in
// image uv units (xy). Aperiodic and slow (the flow field evolves at ROOM_FREQS.driftField). Requires NOISE_GLSL.
varying vec2 vUv;
uniform sampler2D uPrev;
uniform float uDt;
uniform float uTau;
uniform float uFxTime;
uniform float uDriftField;
uniform float uImgAspect;
uniform float uAmp;        // flow speed, image-height units per second
uniform float uScale;      // flow feature scale
uniform float uReset;
void main() {
  vec2 q = vec2(vUv.x * uImgAspect, vUv.y);
  vec2 v = hs_curl2(q * uScale, uFxTime * uDriftField) * uAmp;
  vec2 vuv = vec2(v.x / uImgAspect, v.y);
  vec2 prev = uReset > 0.5 ? vec2(0.0) : texture2D(uPrev, vUv - vuv * uDt).xy;
  vec2 off = (prev + vuv * uDt) * exp(-uDt / uTau);
  gl_FragColor = vec4(off, 0.0, 1.0);
}
