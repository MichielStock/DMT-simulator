// Helper for layers that read state.fieldTexture (the coupling signal) through the same
// retino-cortical map as the form-constants layer. Include with:
//   import fieldSample from './glsl/fieldSample.glsl?raw';  fragmentShader: fieldSample + '\n' + myFrag
// p = screen position relative to the view centre in units of the screen height (x scaled by aspect).
// Returns the texture coordinate into fieldTexture (repeat-wrapped; R = activity 0-1 after the
// contrast cap, G = raw u, B = drift phase). Keep FIELD_X0 / FIELD_R0 in sync with neuralField.ts.
#ifndef FIELD_SAMPLE_GLSL
#define FIELD_SAMPLE_GLSL
#define FIELD_X0 -5.0
#define FIELD_R0 0.012
vec2 fieldUV(vec2 p) {
  float r = length(p) + 1e-5;
  return vec2((log(r + FIELD_R0) - FIELD_X0) / 6.2831853, atan(p.y, p.x) / 6.2831853);
}
#endif
