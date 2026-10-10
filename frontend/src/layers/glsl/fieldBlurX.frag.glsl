// Pass A of one sub-step: F = f(u) and its two Gaussian blurs along x.
// out = (sum ge*F, sum gi*F, F(x, y), 0)
uniform sampler2D uU;
uniform float uGe[MAX_TAPS];
uniform float uGi[MAX_TAPS];
uniform int uRadius;
uniform float uBeta;
uniform float uBetaC;
uniform float uAlpha;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float se = 0.0, si = 0.0, f0 = 0.0;
  for (int j = -uRadius; j <= uRadius; j++) {
    float f = firing(texelFetch(uU, wrapCell(c + ivec2(j, 0)), 0).r, uBeta, uBetaC, uAlpha);
    se += uGe[j + uRadius] * f;
    si += uGi[j + uRadius] * f;
    if (j == 0) f0 = f;
  }
  outColor = vec4(se, si, f0, 0.0);
}
