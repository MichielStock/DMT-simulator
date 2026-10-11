// Composite of the form-constant layer into the shared scene target: the pattern plus the bloomed
// accents (two blur widths), alpha = the layer weight (NormalBlending).
uniform sampler2D uPattern;
uniform sampler2D uBloomA;     // narrow halo
uniform sampler2D uBloomB;     // wide halo
uniform float uGainA;
uniform float uGainB;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uPattern, vUv).rgb + uGainA * texture(uBloomA, vUv).rgb + uGainB * texture(uBloomB, vUv).rgb;
  outColor = vec4(c, uAlpha);
}
