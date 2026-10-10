// state.fieldTexture: R = activity 0-1 (0.5 + 0.5 tanh(u / U_REF), the contrast-capped display
// variable), G = raw u, B = slow drift phase (0-1). The slow advective drift (cells, fractional)
// is baked in here so every reader sees the same moving pattern. Bilinear on the torus.
uniform sampler2D uU;
uniform vec2 uDrift;           // cells
uniform float uDriftPhase;     // 0-1
uniform float uURef;
out vec4 outColor;
float fetchU(ivec2 c) { return texelFetch(uU, wrapCell(c), 0).r; }
void main() {
  vec2 p = gl_FragCoord.xy - 0.5 - uDrift;
  vec2 f = floor(p);
  vec2 t = p - f;
  ivec2 c = ivec2(f);
  float u = mix(mix(fetchU(c), fetchU(c + ivec2(1, 0)), t.x),
                mix(fetchU(c + ivec2(0, 1)), fetchU(c + ivec2(1, 1)), t.x), t.y);
  float a = 0.5 + 0.5 * tanh(u / uURef);
  outColor = vec4(a, u, uDriftPhase, 1.0);
}
