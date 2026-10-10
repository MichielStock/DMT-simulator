// Room layer: final composite into the scene target. The room fades into a dark phosphene field as the
// eyes close (BUILD.md 11.3): the neural field in dim palette colour on near-black (mean luminance well
// below 0.25), then the layer weight (the room is replaced by the waiting room by v = 7.5).
// Requires NOISE_GLSL. Opaque: overwrites the scene target (NOTES S4: room is the first layer).
varying vec2 vUv;
uniform sampler2D uRoom;
uniform float uEyes;
uniform float uWeight;
uniform float uFade;         // fade-in once the room textures are ready
uniform sampler2D uField;
uniform float uHasField;
uniform float uFxTime;
uniform float uPhosHz;
uniform float uViewAspect;
uniform float uPhos;         // phosphene strength 0-1 (rises with v)
uniform float uPulse;
uniform vec3 uPalA;
uniform vec3 uPalB;
uniform vec3 uPalC;

const float TAU = 6.28318530718;

float fieldAt(vec2 p) {
  if (uHasField > 0.5) return texture2D(uField, fieldUV(p)).r;   // fieldSample.glsl (form-constant map)
  // before the neural field exists: slow drifting phosphene clouds
  float a = hs_fbm3(vec3(p * 1.6, uFxTime * uPhosHz));
  float b = hs_snoise3(vec3(p * 4.0 + 3.0, uFxTime * uPhosHz * 1.3));
  return clamp(0.5 + 0.55 * a + 0.12 * b, 0.0, 1.0);
}

void main() {
  vec3 room = uEyes < 0.999 ? texture2D(uRoom, vUv).rgb : vec3(0.0);
  vec3 col = room;
  if (uEyes > 0.001) {
    vec2 p = (vUv - 0.5) * vec2(uViewAspect, 1.0);
    // soft, slightly blurred activity: phosphenes are diffuse
    float a = 0.4 * fieldAt(p);
    for (int i = 0; i < 4; i++) {
      float an = float(i) * 1.5707963 + 0.4;
      a += 0.15 * fieldAt(p + 0.018 * vec2(cos(an), sin(an)));
    }
    float glow = smoothstep(0.35, 1.0, a);
    float hueSel = 0.5 + 0.5 * hs_snoise3(vec3(p * 0.7, uFxTime * uPhosHz * 0.5 + 11.0));
    vec3 pc = mix(mix(uPalA, uPalB, smoothstep(0.0, 0.6, hueSel)), uPalC, smoothstep(0.55, 1.0, hueSel));
    pc /= max(max(pc.r, max(pc.g, pc.b)), 1e-3);
    float vig = smoothstep(1.25, 0.15, length(p));
    // safety at source (BUILD.md 4.1): the field is periodic, so the phosphenes sit on a dim floor of
    // their own colour: peak / floor <= 1 + 0.55 / 0.45, Michelson contrast <= 0.38
    float amp = (0.02 + 0.10 * uPhos) * (0.9 + 0.1 * uPulse) * vig;
    vec3 eigengrau = vec3(0.008, 0.007, 0.011) * (1.0 + 0.6 * vig);
    vec3 phos = eigengrau + pc * amp * (0.45 + 0.55 * glow);
    col = mix(room, phos, smoothstep(0.0, 1.0, uEyes));
  }
  gl_FragColor = vec4(col * uWeight * uFade, 1.0);
}
