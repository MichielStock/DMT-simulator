// Shared by the neural-field passes. Identical arithmetic to neuralFieldCpu.ts (hash32, gaussNoise,
// firing). The grid is an N x N torus (x = log eccentricity, y = angle).
precision highp float;
precision highp int;
precision highp usampler2D;
#define FIELD_N 256
#define MAX_TAPS 49

uint hash32(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float gaussNoise(uint cell, uint stepIndex, uint seedH) {
  uint h = hash32(cell + hash32(stepIndex + seedH));
  float s = 0.0;
  for (int k = 0; k < 4; k++) s += float(hash32(h + uint(k) * 0x9e3779b9u)) / 4294967296.0;
  return (s - 2.0) * 1.7320508;
}

float sigm(float x) { return 1.0 / (1.0 + exp(-x)); }

// f(u) = S(beta u) + alpha (S(betaC u) - 1/2)^2
float firing(float u, float beta, float betaC, float alpha) {
  float q = sigm(betaC * u) - 0.5;
  return sigm(beta * u) + alpha * q * q;
}

ivec2 wrapCell(ivec2 c) { return ivec2(c.x & (FIELD_N - 1), c.y & (FIELD_N - 1)); }
