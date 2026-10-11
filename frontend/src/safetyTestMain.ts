// Safety test page: renders ONE deliberately unsafe (or control) test pattern INTO the RenderPipeline, so
// it passes through the SafetyLimiter exactly like a real layer. Patterns (?pattern=):
//   bw10       full-screen black/white square wave at 10 Hz
//   red8       saturated red <-> black at 8 Hz
//   stripes    high-contrast vertical stripes reversing phase at 6 Hz
//   static     a calm static gradient (control)
// Static periodic patterns at Michelson ~0.9 (luminance 0.05 / 0.95), sizes in scene-target px:
//   rings      concentric rings, period 30 px          hex        hexagonal dot lattice, period 24 px
//   diag       45-degree stripes, period 12 px          checker    checkerboard, 16 px squares
//   bigstripes vertical stripes, period 80 px          thinlines  2-px bright lines on black every 40 px
// Static APERIODIC controls (the guard must leave them untouched):
//   photo      assets/sample/room.jpg (copied to /safety-test/room.jpg), cover-fitted: full width, top
//              aligned (flashcheck flags the 4:3 centre crop's bookshelves, NOTES.md D-I10/S8);
//              &src=<same-origin url> another image, &crop=<zoom>,<fx>,<fy> (fx, fy in 0..1 alignment)
//   blobs      dark base 0.05 with 40 soft coloured blooms and 4 bright filaments (docs/VISUAL_DIRECTION.md)
//   custom     &frag=<urlencoded GLSL>: either the BODY of `vec3 pattern(vec2 uv, float t)` (must return
//              LINEAR RGB) or a full source that defines that function (helpers allowed); uv in 0..1,
//              uniforms uRes (scene px) and uTime (s) are available.
// Any pattern: &area=<0..1> shows it only inside a centred rectangle covering that fraction of the screen
// (screen aspect), black elsewhere.
//
// Test hooks (window.__limiter): pattern, engagedCount, lastInfo, frames, engaged, webgl2, renderer, passes,
// status() (live limiter status), live (status copied every frame), history (per-frame status of the first
// 1200 frames: {frame, t, engaged, patternGuard, highContrastFraction, periodicFraction, stripeFraction,
// spectralFraction, contrastFraction, meanLuminance}),
// ready (true once the pattern's texture/shader is in use), shaderError, firstFrameMs (page time of the
// first rendered frame, includes shader compilation), periodicityMap(), stripeMap() and spectralMap() (64x36
// scores / flags, row 0 = top), timeAnalysis(iterations) (ms of the limiter's analysis passes), capturePre() and
// capturePost() (PNG data URLs of the scene BEFORE the limiter and of the screen AFTER it).
import * as THREE from 'three';
import { RenderPipeline, type Layer } from './pipeline';
import type { LimiterInfo, LimiterStatus } from './safety/safetyLimiter';

const PATTERNS = ['bw10', 'red8', 'stripes', 'static', 'rings', 'hex', 'diag', 'checker', 'bigstripes',
  'thinlines', 'photo', 'blobs', 'custom'] as const;
type Pattern = typeof PATTERNS[number];
const params = new URLSearchParams(location.search);
const raw = params.get('pattern') ?? 'static';
const pattern: Pattern = (PATTERNS as readonly string[]).includes(raw) ? (raw as Pattern) : 'static';
const areaParam = params.get('area');
const area = areaParam === null ? 1 : Math.min(1, Math.max(0, Number(areaParam) || 0));
const DEFAULT_SRC = '/safety-test/room.jpg';
const imageSrc = params.get('src') ?? DEFAULT_SRC;
const crop = (params.get('crop') ?? (imageSrc === DEFAULT_SRC ? '1,0.5,0' : '1,0.5,0.5')).split(',').map(Number);
const [cropZoom, cropFx, cropFy] = [crop[0] || 1, crop[1] ?? 0.5, crop[2] ?? 0.5];

const HEADER = /* glsl */ `
uniform float uTime;
uniform int uPattern;
uniform vec2 uRes;
uniform float uArea;
uniform sampler2D uImage;
uniform vec4 uImageRect;   // uv offset (xy) and scale (zw) into the image
varying vec2 vUv;
`;

const BUILTIN = /* glsl */ `
const float LO = 0.05;
const float HI = 0.95;
float sq(float u, float T) { return mod(u, T) < 0.5 * T ? HI : LO; }
float cw(float u, float T) { return LO + (HI - LO) * (0.5 + 0.5 * cos(6.2831853 * u / T)); }
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
vec3 blobs(vec2 px) {
  vec3 pal[4];
  pal[0] = vec3(1.0, 0.15, 0.85); pal[1] = vec3(0.1, 0.85, 1.0); pal[2] = vec3(1.0, 0.75, 0.2); pal[3] = vec3(0.55, 0.3, 1.0);
  float s = uRes.x / 1280.0;
  vec3 c = vec3(0.05);
  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    vec2 p = vec2(hash1(fi + 0.1), hash1(fi + 7.3)) * uRes;
    float r = (15.0 + 55.0 * hash1(fi + 3.7)) * s;
    float a = 0.2 + 0.5 * hash1(fi + 9.1);
    vec2 d = px - p;
    c += a * pal[i - 4 * (i / 4)] * exp(-dot(d, d) / (2.0 * r * r));
  }
  for (int i = 0; i < 4; i++) {
    float fi = float(i) + 50.0;
    vec2 p = vec2(hash1(fi + 0.1), hash1(fi + 7.3)) * uRes;
    float ang = 3.14159 * hash1(fi + 2.2);
    vec2 t = vec2(cos(ang), sin(ang)); vec2 n = vec2(-t.y, t.x);
    float u = dot(px - p, t); float v = dot(px - p, n);
    float bend = (0.0015 + 0.002 * hash1(fi + 4.4)) / s;
    float dist = abs(v - bend * u * u);
    c += 0.8 * mix(vec3(1.0), pal[i], 0.35) * exp(-pow(dist / (1.5 * s), 2.0));
  }
  return c;
}
vec3 pattern(vec2 uv, float t) {
  vec2 px = uv * uRes;
  if (uPattern == 0) return vec3(mod(floor(t * 20.0), 2.0) < 0.5 ? 1.0 : 0.0);                   // bw10
  if (uPattern == 1) return mod(floor(t * 16.0), 2.0) < 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0);   // red8
  if (uPattern == 2) {            // stripes: 24 px wide (at render scale 1), reversing at 6 Hz
    float stripe = mod(floor(px.x / 24.0), 2.0);
    float phase = mod(floor(t * 12.0), 2.0);
    return vec3(abs(stripe - phase));
  }
  if (uPattern == 3) return vec3(0.05, 0.08, 0.12) + vec3(0.25, 0.18, 0.1) * uv.y;              // static
  if (uPattern == 4) return vec3(cw(length(px - 0.5 * uRes), 30.0));                             // rings
  if (uPattern == 5) {                                                                           // hex
    float k = 6.2831853 / 24.0;
    float s = cos(k * px.x) + cos(k * dot(px, vec2(-0.5, 0.8660254))) + cos(k * dot(px, vec2(-0.5, -0.8660254)));
    return vec3(LO + (HI - LO) * (s + 1.5) / 4.5);
  }
  if (uPattern == 6) return vec3(sq((px.x + px.y) * 0.70710678, 12.0));                           // diag
  if (uPattern == 7) return vec3(mod(floor(px.x / 16.0) + floor(px.y / 16.0), 2.0) < 0.5 ? HI : LO); // checker
  if (uPattern == 8) return vec3(sq(px.x, 80.0));                                                // bigstripes
  if (uPattern == 9) return vec3(mod(px.x, 40.0) < 2.0 ? HI : LO);                               // thinlines
  if (uPattern == 10) return texture2D(uImage, uImageRect.xy + uv * uImageRect.zw).rgb;          // photo (linear)
  return blobs(px);                                                                              // blobs
}
`;

function customSource(): string {
  const src = params.get('frag') ?? 'return vec3(0.0);';
  return /\bpattern\s*\(/.test(src) ? src : `vec3 pattern(vec2 uv, float t) {\n${src}\n}`;
}

const MAIN = /* glsl */ `
void main() {
  vec3 c = pattern(vUv, uTime);
  if (uArea < 1.0) {
    vec2 h = 0.5 * vec2(sqrt(uArea));
    vec2 d = abs(vUv - 0.5);
    if (d.x > h.x || d.y > h.y) c = vec3(0.0);
  }
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);    // linear RGB into the scene target
}
`;

const info = {
  pattern, area, engagedCount: 0, lastInfo: null as LimiterInfo | null, frames: 0, engaged: false,
  ready: pattern !== 'photo', shaderError: null as string | null,
  webgl2: false, renderer: '', passes: [] as readonly string[],
  live: null as LimiterStatus | null,
  history: [] as Array<{ frame: number; t: number; engaged: boolean; patternGuard: number;
    highContrastFraction: number; periodicFraction: number; stripeFraction: number; spectralFraction: number;
    contrastFraction: number; meanLuminance: number }>,
  status: (): LimiterStatus => pipeline.limiter.status,
  periodicityMap: (): number[] => {
    // row 0 = top of the screen
    const m = pipeline.limiter.periodicityMap(); const out: number[] = [];
    for (let r = 35; r >= 0; r--) for (let c = 0; c < 64; c++) out.push(Math.round(m[r * 64 + c] * 1000) / 1000);
    return out;
  },
  stripeMap: (): number[] => {
    // row 0 = top of the screen (S8b stripe flags, 0/1)
    const m = pipeline.limiter.stripeMap(); const out: number[] = [];
    for (let r = 35; r >= 0; r--) for (let c = 0; c < 64; c++) out.push(m[r * 64 + c]);
    return out;
  },
  spectralMap: (): number[] => {
    // row 0 = top of the screen (S8c local-spectrum flags, 0/1)
    const m = pipeline.limiter.spectralMap(); const out: number[] = [];
    for (let r = 35; r >= 0; r--) for (let c = 0; c < 64; c++) out.push(m[r * 64 + c]);
    return out;
  },
  firstFrameMs: 0,
  timeAnalysis: (iterations = 200) => pipeline.limiter.timeAnalysis(sceneTexture(), iterations),
  capturePre: (): string => capturePre(),
  capturePost: (): string => pipeline.canvas.toDataURL('image/png'),
};

class TestPatternLayer implements Layer<null> {
  name = `test_${pattern}`;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private image: THREE.Texture | null = null;
  readonly mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: HEADER + (pattern === 'custom' ? customSource() : BUILTIN) + MAIN,
    uniforms: {
      uTime: { value: 0 },
      uPattern: { value: PATTERNS.indexOf(pattern) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uArea: { value: area },
      uImage: { value: null },
      uImageRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    },
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  init(): void {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    m.frustumCulled = false;
    this.scene.add(m);
    if (pattern === 'photo') {
      new THREE.TextureLoader().load(imageSrc, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;   // sampled as LINEAR (sRGB8 texture)
        this.image = tex;
        this.mat.uniforms.uImage.value = tex;
        this.fitImage();
        info.ready = true;
      }, undefined, () => { info.shaderError = `could not load ${imageSrc}`; });
    }
  }
  /** Cover-fit the image to the scene aspect, zoomed by cropZoom, aligned by (cropFx, cropFy) (0 = left/top). */
  private fitImage(): void {
    const img = this.image?.image as { width: number; height: number } | undefined;
    if (!img) return;
    const res = this.mat.uniforms.uRes.value as THREE.Vector2;
    const sa = res.x / res.y; const ia = img.width / img.height;
    let sw = 1; let sh = 1;
    if (ia > sa) sw = sa / ia; else sh = ia / sa;
    sw /= cropZoom; sh /= cropZoom;
    const ox = (1 - sw) * Math.min(1, Math.max(0, cropFx));
    const oyTop = (1 - sh) * Math.min(1, Math.max(0, cropFy));
    // texture v runs bottom-up (flipY): the top-aligned window starts at v = 1 - oyTop - sh
    (this.mat.uniforms.uImageRect.value as THREE.Vector4).set(ox, 1 - oyTop - sh, sw, sh);
  }
  resize(w: number, h: number): void { this.mat.uniforms.uRes.value.set(w, h); this.fitImage(); }
  render(renderer: THREE.WebGLRenderer, _s: null, target: THREE.WebGLRenderTarget | null): void {
    this.mat.uniforms.uTime.value = performance.now() / 1000;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
  dispose(): void { this.mat.dispose(); this.image?.dispose(); }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const tick = document.getElementById('tick') as HTMLDivElement;
const pipeline = new RenderPipeline<null>(canvas, { debug: params.get('debug') === '1' });
const layer = new TestPatternLayer();
pipeline.addLayer(layer);
pipeline.renderer.debug.onShaderError = (gl, _program, vs, fs) => {
  info.shaderError = `${gl.getShaderInfoLog(fs) ?? ''} ${gl.getShaderInfoLog(vs) ?? ''}`.trim() || 'shader error';
  console.error('test pattern shader error', info.shaderError);
};

info.webgl2 = pipeline.renderer.capabilities.isWebGL2;
info.renderer = (() => {
  const gl = pipeline.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
})();
info.passes = pipeline.passes;

function sceneTexture(): THREE.Texture {
  return (pipeline as unknown as { sceneTarget: THREE.WebGLRenderTarget }).sceneTarget.texture;
}

/** PNG of the scene target BEFORE the SafetyLimiter (same sRGB encoding as the limiter's final blit). */
let preTarget: THREE.WebGLRenderTarget | null = null;
const preScene = new THREE.Scene();
const preMat = new THREE.ShaderMaterial({
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D uSrc; varying vec2 vUv;
    void main() { vec3 c = clamp(texture2D(uSrc, vUv).rgb, 0.0, 1.0);
      gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)), 1.0); }`,
  uniforms: { uSrc: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false,
});
{ const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), preMat); m.frustumCulled = false; preScene.add(m); }
const preCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function capturePre(): string {
  const src = sceneTexture();
  const { width: w, height: h } = pipeline.sceneSize;
  if (!preTarget || preTarget.width !== w || preTarget.height !== h) {
    preTarget?.dispose();
    preTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
  }
  const r = pipeline.renderer;
  const prev = r.getRenderTarget();
  preMat.uniforms.uSrc.value = src;
  r.setRenderTarget(preTarget);
  r.render(preScene, preCam);
  const buf = new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(preTarget, 0, 0, w, h, buf);
  r.setRenderTarget(prev);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

pipeline.limiter.onEngaged((i) => { info.engagedCount++; info.lastInfo = i; });
(window as unknown as { __limiter: typeof info }).__limiter = info;
(window as unknown as { __pipeline: RenderPipeline<null> }).__pipeline = pipeline;

const t0 = performance.now();
function frame(): void {
  pipeline.render(null);
  info.frames++;
  if (info.frames === 1) info.firstFrameMs = Math.round(performance.now());
  info.engaged = pipeline.limiter.engaged;
  const s = pipeline.limiter.status;
  info.live = s;
  if (info.history.length < 1200) {
    info.history.push({ frame: info.frames, t: Math.round(performance.now() - t0), engaged: s.engaged,
      patternGuard: s.patternGuard, highContrastFraction: s.highContrastFraction,
      periodicFraction: s.periodicFraction, stripeFraction: s.stripeFraction, spectralFraction: s.spectralFraction,
      contrastFraction: s.contrastFraction, meanLuminance: s.meanLuminance });
  }
  tick.textContent = String(info.frames);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
