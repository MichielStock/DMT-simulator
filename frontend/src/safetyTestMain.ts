// Safety test page: renders ONE deliberately unsafe test pattern INTO the RenderPipeline, so it
// passes through the SafetyLimiter exactly like a real layer. Patterns (?pattern=):
//   bw10    full-screen black/white square wave at 10 Hz
//   red8    saturated red <-> black at 8 Hz
//   stripes high-contrast vertical stripes reversing phase at 6 Hz
//   static  a calm static gradient (control)
import * as THREE from 'three';
import { RenderPipeline, type Layer } from './pipeline';
import type { LimiterInfo } from './safety/safetyLimiter';

type Pattern = 'bw10' | 'red8' | 'stripes' | 'static';
const params = new URLSearchParams(location.search);
const raw = params.get('pattern') ?? 'static';
const pattern: Pattern = (['bw10', 'red8', 'stripes', 'static'] as const).includes(raw as Pattern)
  ? (raw as Pattern) : 'static';

const FRAG = /* glsl */ `
uniform float uTime;
uniform int uPattern;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  if (uPattern == 0) {            // bw10
    c = vec3(mod(floor(uTime * 20.0), 2.0) < 0.5 ? 1.0 : 0.0);
  } else if (uPattern == 1) {     // red8
    c = mod(floor(uTime * 16.0), 2.0) < 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  } else if (uPattern == 2) {     // stripes: 24 px wide (at render scale 1), reversing at 6 Hz
    float stripe = mod(floor(vUv.x * uRes.x / 24.0), 2.0);
    float phase = mod(floor(uTime * 12.0), 2.0);
    c = vec3(abs(stripe - phase));
  } else {                        // static
    c = vec3(0.05, 0.08, 0.12) + vec3(0.25, 0.18, 0.1) * vUv.y;
  }
  gl_FragColor = vec4(c, 1.0);    // linear RGB into the scene target
}
`;

class TestPatternLayer implements Layer<null> {
  name = `test_${pattern}`;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPattern: { value: ['bw10', 'red8', 'stripes', 'static'].indexOf(pattern) },
      uRes: { value: new THREE.Vector2(1, 1) },
    },
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  init(): void {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    m.frustumCulled = false;
    this.scene.add(m);
  }
  resize(w: number, h: number): void { this.mat.uniforms.uRes.value.set(w, h); }
  render(renderer: THREE.WebGLRenderer, _s: null, target: THREE.WebGLRenderTarget | null): void {
    this.mat.uniforms.uTime.value = performance.now() / 1000;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
  dispose(): void { this.mat.dispose(); }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const tick = document.getElementById('tick') as HTMLDivElement;
const pipeline = new RenderPipeline<null>(canvas, { debug: params.get('debug') === '1' });
pipeline.addLayer(new TestPatternLayer());

const info = {
  pattern, engagedCount: 0, lastInfo: null as LimiterInfo | null, frames: 0, engaged: false,
  webgl2: pipeline.renderer.capabilities.isWebGL2,
  renderer: (() => {
    const gl = pipeline.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  })(),
  passes: pipeline.passes,
  status: () => pipeline.limiter.status,
};
pipeline.limiter.onEngaged((i) => { info.engagedCount++; info.lastInfo = i; });
(window as unknown as { __limiter: typeof info }).__limiter = info;
(window as unknown as { __pipeline: RenderPipeline<null> }).__pipeline = pipeline;

function frame(): void {
  pipeline.render(null);
  info.frames++;
  info.engaged = pipeline.limiter.engaged;
  tick.textContent = String(info.frames);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
