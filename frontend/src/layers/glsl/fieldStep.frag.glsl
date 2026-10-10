// Pass B of one sub-step: finish the separable difference of Gaussians along y, add the
// anisotropic line kernels (x, y, diagonal), the pinning template, the spiral seed and noise,
// and advance u by one Euler-Maruyama step: u += dt/tau (-u + A w*f(u) + I) + sigma sqrt(dt/tau) xi.
uniform sampler2D uU;
uniform sampler2D uH;          // (He, Hi, F) from pass A
uniform float uGe[MAX_TAPS];
uniform float uGi[MAX_TAPS];
uniform float uGde[MAX_TAPS];
uniform float uGdi[MAX_TAPS];
uniform int uRadius;
uniform vec4 uEps;             // epsX, epsY, epsD, diag (+1 / -1)
uniform float uA;              // kernel amplitude
uniform float uDtTau;          // dt / tau
uniform float uNoise;          // sigma * sqrt(dt / tau)
uniform uint uStep;
uniform uint uSeedH;
uniform vec4 uPin[6];          // kx, ky (rad/cell), amp, phase
uniform int uPinCount;
uniform float uPinAmp;         // PIN_AMP * gate
uniform vec4 uSpiral;          // cx, cy, dir, env
uniform vec2 uSpiralP;         // field time t, k*
uniform vec4 uSpiralC;         // amp, radius, hz, unused
out vec4 outColor;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float conv = 0.0;
  for (int j = -uRadius; j <= uRadius; j++) {
    vec4 h = texelFetch(uH, wrapCell(c + ivec2(0, j)), 0);
    conv += uGe[j + uRadius] * h.r - uGi[j + uRadius] * h.g;
  }
  if (uEps.x > 0.0 || uEps.y > 0.0 || uEps.z > 0.0) {
    float lx = 0.0, ly = 0.0, ld = 0.0;
    int dg = int(uEps.w);
    for (int j = -uRadius; j <= uRadius; j++) {
      float wa = uGe[j + uRadius] - uGi[j + uRadius];
      float wd = uGde[j + uRadius] - uGdi[j + uRadius];
      lx += wa * texelFetch(uH, wrapCell(c + ivec2(j, 0)), 0).b;
      ly += wa * texelFetch(uH, wrapCell(c + ivec2(0, j)), 0).b;
      ld += wd * texelFetch(uH, wrapCell(c + ivec2(j, dg * j)), 0).b;
    }
    conv += uEps.x * lx + uEps.y * ly + uEps.z * ld;
  }
  float inp = uA * conv;
  vec2 xy = vec2(c);
  if (uPinAmp > 0.0) {
    float s = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= uPinCount) break;
      s += uPin[i].z * cos(uPin[i].x * xy.x + uPin[i].y * xy.y + uPin[i].w);
    }
    inp += uPinAmp * s;
  }
  if (uSpiral.w > 0.0) {
    vec2 d = xy - uSpiral.xy;
    d -= float(FIELD_N) * floor(d / float(FIELD_N) + 0.5);
    float r = length(d);
    float phi = atan(d.y, d.x);
    float R = uSpiralC.y;
    inp += uSpiralC.x * uSpiral.w * exp(-(r * r) / (2.0 * R * R)) * tanh(r / 3.0)
      * cos(phi - uSpiral.z * 6.2831853 * uSpiralC.z * uSpiralP.x + uSpiralP.y * r);
  }
  float u = texelFetch(uU, c, 0).r;
  uint cell = uint(c.y * FIELD_N + c.x);
  float un = u + uDtTau * (-u + inp) + uNoise * gaussNoise(cell, uStep, uSeedH);
  outColor = vec4(un, 0.0, 0.0, 1.0);
}
