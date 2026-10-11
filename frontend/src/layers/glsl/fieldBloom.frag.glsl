// Bloom of the form-constant bright pass (docs/VISUAL_DIRECTION.md 1.4): the crest lines of the core,
// the glints and the central star (alpha of the pattern pass). A quarter-resolution bright pass (MODE 0:
// 4x4 box of the render target's alpha-weighted colour) and a separable 9-tap Gaussian (MODE 1, along
// uDir in texels). The crest lines only exist inside the bounded high-contrast core, so the halo adds
// no periodic contrast to the lit annulus.
uniform sampler2D uSrc;
uniform vec2 uTexel;           // 1 / source size
uniform vec2 uDir;             // MODE 1: blur direction (texels of the source)
in vec2 vUv;
out vec4 outColor;
void main() {
#if MODE == 0
  vec3 s = vec3(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      // bilinear taps at the centres of 2x2 texel groups = a 4x4 box
      vec4 t = texture(uSrc, vUv + (vec2(float(i), float(j)) - 0.5) * 2.0 * uTexel);
      float l = max(dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
      s += t.rgb * clamp(t.a / l, 0.0, 1.0);           // the accent share of the pixel's light
    }
  }
  outColor = vec4(s * 0.25, 1.0);
#else
  const float w0 = 0.2270270, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.0540541, w4 = 0.0162162;
  vec3 s = texture(uSrc, vUv).rgb * w0;
  s += (texture(uSrc, vUv + uDir * uTexel).rgb + texture(uSrc, vUv - uDir * uTexel).rgb) * w1;
  s += (texture(uSrc, vUv + 2.0 * uDir * uTexel).rgb + texture(uSrc, vUv - 2.0 * uDir * uTexel).rgb) * w2;
  s += (texture(uSrc, vUv + 3.0 * uDir * uTexel).rgb + texture(uSrc, vUv - 3.0 * uDir * uTexel).rgb) * w3;
  s += (texture(uSrc, vUv + 4.0 * uDir * uTexel).rgb + texture(uSrc, vUv - 4.0 * uDir * uTexel).rgb) * w4;
  outColor = vec4(s, 1.0);
#endif
}
