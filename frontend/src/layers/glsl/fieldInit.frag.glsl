// Initial state: small seeded noise (as FieldSim's constructor).
uniform uint uSeedH;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  uint cell = uint(c.y * FIELD_N + c.x);
  outColor = vec4(0.01 * gaussNoise(cell, 0xffffffu, uSeedH), 0.0, 0.0, 1.0);
}
