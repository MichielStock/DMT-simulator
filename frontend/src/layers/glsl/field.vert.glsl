// Full-screen quad for the neural-field passes (GLSL3 via THREE.ShaderMaterial).
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
