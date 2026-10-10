// Form constants: the Ermentrout–Cowan / Bressloff neural field (BUILD.md §11.4, M5).
//
// A 256 × 256 field u in cortical coordinates (x = log eccentricity, y = angle; torus) is integrated
// on the GPU with float ping-pong targets, at a fixed Δt of wall time (frame-rate independent, at most
// MAX_STEPS_PER_FRAME sub-steps per frame). The equations, constants, kernels, noise hash and the
// trip-script → regime mapping live in neuralFieldCpu.ts (the CPU reference used by the tests);
// this file only drives the shaders in glsl/field*.glsl.
//
// Coupling signal: `state.fieldTexture` (THREE.Texture, 256 × 256, half float, linear, repeat-wrapped):
// R = activity 0–1 after the contrast cap, G = raw u, B = slow drift phase. Set from init() on and
// updated every frame; the field keeps running underneath every higher layer.
//
// Test / scrub hooks (CONTRACTS.md test hooks; NOTES.md D-NF5):
//  * window.__hyperspace.readField() → Float32Array (256², raw u, row-major y·256 + x) of the GPU field;
//  * window.__hyperspace.fieldInfo() → { ratio, targetRatio, betaC, lambda, regime, time, steps };
//  * window.__hyperspace.fieldOverride = { mode?: 'stripes_x'|'stripes_y'|'spirals'|'hexagons'|
//    'stripes'|'mixed', wavelength?: number (trip units 0.6–1.3), spiral_bias?: number } replaces the
//    trip script's layers.form_constants; the URL parameter &fcmode=<mode> sets it at start-up.
//  * `layer.ready` is true once the gain has reached its target and the pattern has had 4 s to settle.

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import {
  DT, FIELD_N, KERNEL_A, MAX_RADIUS, MAX_STEPS_PER_FRAME, NOISE_SIGMA, PIN_AMP, SPIRAL, TAU, U_REF, K_SIGMA_E,
  activeSpiral, approachRatio, classWeights, criticalGain, gainRatio, makeKernel, pinGate, pinTerms, predictWavenumber, regimeAt,
  seedHash, wavelengthCells, type FormConstantsSpec, type Kernel, type Regime,
} from './neuralFieldCpu';
import vert from './glsl/field.vert.glsl?raw';
import common from './glsl/fieldCommon.glsl?raw';
import initFrag from './glsl/fieldInit.frag.glsl?raw';
import blurXFrag from './glsl/fieldBlurX.frag.glsl?raw';
import stepFrag from './glsl/fieldStep.frag.glsl?raw';
import displayFrag from './glsl/fieldDisplay.frag.glsl?raw';
import renderFrag from './glsl/fieldRender.frag.glsl?raw';

const TAPS = 2 * MAX_RADIUS + 1;
/** Log-polar window: field x = 0 at log r = X0; one full field period (2π in log r) covers
 *  r from e^X0 to e^(X0 + 2π) — the wrap lies inside the fovea (faded) and beyond the screen corners. */
const X0 = -5.0;
const R0 = 0.012;
/** Luminance range of the rendered pattern (linear): Lmax / Lmin = 2.2 → Michelson ≤ 0.375 (the radial glow adds a little per block; measured max 0.47 with 2.4, so 2.2 keeps margin). */
// dark base, luminous ridges (docs/VISUAL_DIRECTION.md §2): troughs ≈ 0.086, ridges ≈ 0.21 linear
// (Michelson 0.42 by construction; the radial glow adds ≈ 0.03 in captures, still < 0.5)
const L_MAX = 0.21;
const L_MIN = L_MAX / 2.45;
/** Drift: temporal frequency of the pattern at a fixed pixel (cycles per second). ≤ 2 Hz by a wide margin. */
const DRIFT_HZ = 0.07;
const DRIFT_HZ_CHALLENGE = 0.22;
const DRIFT_HZ_MAX = 0.3;
/** Render-side safety limits, exported for the unit tests. */
export const RENDER_LIMITS = Object.freeze({
  lMin: L_MIN, lMax: L_MAX, driftHzMax: DRIFT_HZ_MAX, pulseBrightMin: 0.9,
  michelson: (L_MAX - L_MIN) / (L_MAX + L_MIN),
});
/** Weight of the faint field modulation of the room after the form-constant layer has faded (§11.2). */
const MODULATION_ALPHA = 0.12;

export type FieldOverride = FormConstantsSpec & { mode?: string };

interface Hooks {
  fieldOverride?: FieldOverride | null;
  readField?: () => Float32Array | null;
  fieldInfo?: () => unknown;
  [k: string]: unknown;
}

function hooks(): Hooks | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __hyperspace?: Hooks };
  w.__hyperspace = w.__hyperspace ?? {};
  return w.__hyperspace;
}

function srgbToLinear(hex: string): THREE.Vector3 {
  const c = new THREE.Color();
  try { c.setStyle(hex, THREE.SRGBColorSpace); } catch { c.setRGB(1, 0.69, 0); }
  // THREE.Color stores linear components when the working colour space is linear (default)
  return new THREE.Vector3(c.r, c.g, c.b);
}

const lumOf = (v: THREE.Vector3): number => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;

function fieldTarget(type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(FIELD_N, FIELD_N, {
    type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
  });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.wrapT = THREE.RepeatWrapping;
  return rt;
}

export class NeuralFieldLayer implements Layer<SharedState> {
  readonly name = 'form_constants';
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private scene = new THREE.Scene();
  private quad: THREE.Mesh;
  private uA!: THREE.WebGLRenderTarget;
  private uB!: THREE.WebGLRenderTarget;
  private hRT!: THREE.WebGLRenderTarget;
  private display!: THREE.WebGLRenderTarget;
  private matInit!: THREE.ShaderMaterial;
  private matBlur!: THREE.ShaderMaterial;
  private matStep!: THREE.ShaderMaterial;
  private matDisplay!: THREE.ShaderMaterial;
  private matRender!: THREE.ShaderMaterial;
  private aspect = 16 / 9;
  private pxH = 720;

  // model state (all in field time = sum of sub-steps × DT, i.e. wall seconds)
  private seed = 1;
  private seedH = 0;
  private steps = 0;
  private accum = 0;
  private lastWall: number | null = null;
  private ratio = 0;
  private targetRatio = 0;
  private settledFor = 0;
  private kernel: Kernel = makeKernel(12);
  private lambdaTarget = 12;
  private regime: Regime = regimeAt(null, 1, 0);
  private betaC = criticalGain(12);
  private betaCKey = '';
  private drift = new THREE.Vector2();
  private driftPhase = 0;
  private hueShift = 0;
  private initialised = false;

  constructor() {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get time(): number { return this.steps * DT; }

  /** True once the gain has reached its target and the field has had 4 s to settle there. */
  get ready(): boolean { return this.initialised && this.settledFor >= 4; }

  init(renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.renderer = renderer;
    this.seed = Number.isFinite(state.seed) ? state.seed : 1;
    this.seedH = seedHash(this.seed);
    this.uA = fieldTarget(THREE.FloatType, THREE.NearestFilter);
    this.uB = fieldTarget(THREE.FloatType, THREE.NearestFilter);
    this.hRT = fieldTarget(THREE.FloatType, THREE.NearestFilter);
    this.display = fieldTarget(THREE.HalfFloatType, THREE.LinearFilter);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>, blend = false) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: common + '\n' + frag, uniforms,
      depthTest: false, depthWrite: false, transparent: blend, blending: blend ? THREE.NormalBlending : THREE.NoBlending,
    });
    const taps = () => ({ value: new Float32Array(TAPS) });
    this.matInit = mk(initFrag, { uSeedH: { value: this.seedH } });
    this.matBlur = mk(blurXFrag, {
      uU: { value: null }, uGe: taps(), uGi: taps(), uRadius: { value: 1 },
      uBeta: { value: 1 }, uBetaC: { value: 1 }, uAlpha: { value: 0 },
    });
    this.matStep = mk(stepFrag, {
      uU: { value: null }, uH: { value: null }, uGe: taps(), uGi: taps(), uGde: taps(), uGdi: taps(),
      uRadius: { value: 1 }, uEps: { value: new THREE.Vector4() }, uA: { value: KERNEL_A },
      uDtTau: { value: DT / TAU }, uNoise: { value: NOISE_SIGMA * Math.sqrt(DT / TAU) },
      uStep: { value: 0 }, uSeedH: { value: this.seedH },
      uPin: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uPinCount: { value: 0 }, uPinAmp: { value: 0 },
      uSpiral: { value: new THREE.Vector4() }, uSpiralP: { value: new THREE.Vector2() },
      uSpiralC: { value: new THREE.Vector4(SPIRAL.amp, SPIRAL.radius, SPIRAL.hz, 0) },
    });
    this.matDisplay = mk(displayFrag, {
      uU: { value: null }, uDrift: { value: new THREE.Vector2() }, uDriftPhase: { value: 0 }, uURef: { value: U_REF },
    });
    this.matRender = mk(renderFrag, {
      uField: { value: this.display.texture }, uAspect: { value: this.aspect }, uCentre: { value: new THREE.Vector2() },
      uR0: { value: R0 }, uX0: { value: X0 }, uScale: { value: 1 }, uPxH: { value: this.pxH }, uLambda: { value: 12 },
      uCols: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0.5, 0)) }, uNCols: { value: 2 },
      uLmin: { value: L_MIN }, uLmax: { value: L_MAX }, uBright: { value: 1 }, uHueShift: { value: 0 },
      uChallenge: { value: 0 }, uAlpha: { value: 0 }, uDepth: { value: 0 },
      uAccent: { value: new THREE.Vector3(0.1, 0.8, 1) }, uDeep: { value: new THREE.Vector3(0.2, 0.05, 0.3) },
    }, true);
    this.setKernel(this.lambdaFor(state, 0));
    // initial state: small seeded noise, then one display pass so fieldTexture is valid immediately
    this.pass(this.matInit, this.uA);
    this.writeDisplay();
    state.fieldTexture = this.display.texture;
    this.initialised = true;

    const hs = hooks();
    if (hs) {
      if (typeof location !== 'undefined') {
        const q = new URLSearchParams(location.search);
        const m = q.get('fcmode');
        if (m) hs.fieldOverride = { ...(hs.fieldOverride ?? {}), mode: m };
        const wl = Number(q.get('fcwavelength'));
        if (q.get('fcwavelength') && Number.isFinite(wl)) hs.fieldOverride = { ...(hs.fieldOverride ?? {}), wavelength: wl };
      }
      hs.readField = () => this.readField();
      hs.fieldInfo = () => this.info();
    }
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
    this.pxH = Math.max(1, h);
  }

  /** The trip script's form_constants, with the test/scrub override applied. */
  private spec(state: SharedState): FormConstantsSpec | null {
    const layers = state.tripScript?.layers as Record<string, unknown> | undefined;
    const fc = (layers?.form_constants ?? null) as FormConstantsSpec | null;
    const ov = hooks()?.fieldOverride;
    if (!ov) return fc;
    return { ...(fc ?? {}), ...ov };
  }

  private lambdaFor(state: SharedState, _t: number): number {
    return wavelengthCells(this.spec(state)?.wavelength ?? null);
  }

  private setKernel(lambda: number): void {
    if (Math.abs(lambda - this.kernel.lambda) < 1e-6 && this.betaCKey) return;
    this.kernel = makeKernel(lambda);
    const k = this.kernel;
    const put = (dst: Float32Array, src: Float32Array) => { dst.fill(0); dst.set(src); };
    put(this.matBlur.uniforms.uGe.value, k.ge); put(this.matBlur.uniforms.uGi.value, k.gi);
    put(this.matStep.uniforms.uGe.value, k.ge); put(this.matStep.uniforms.uGi.value, k.gi);
    put(this.matStep.uniforms.uGde.value, k.gde); put(this.matStep.uniforms.uGdi.value, k.gdi);
    this.matBlur.uniforms.uRadius.value = k.radius;
    this.matStep.uniforms.uRadius.value = k.radius;
    this.betaCKey = '';
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    const r = this.renderer!;
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.scene, this.camera);
  }

  /** One Euler–Maruyama sub-step (two passes). */
  private stepOnce(state: SharedState, spec: FormConstantsSpec | null): void {
    const t = this.time;
    this.ratio = approachRatio(this.ratio, this.targetRatio, DT);
    this.regime = regimeAt(spec, this.seed, t);
    const reg = this.regime;
    const key = `${this.kernel.lambda.toFixed(4)}|${reg.epsX.toFixed(3)}|${reg.epsY.toFixed(3)}|${reg.epsD.toFixed(3)}|${reg.diag}`;
    if (key !== this.betaCKey) { this.betaC = criticalGain(this.kernel.lambda, reg); this.betaCKey = key; }
    const beta = this.ratio * this.betaC;

    const b = this.matBlur.uniforms;
    b.uU.value = this.uA.texture; b.uBeta.value = beta; b.uBetaC.value = this.betaC; b.uAlpha.value = reg.alpha;
    this.pass(this.matBlur, this.hRT);

    const s = this.matStep.uniforms;
    s.uU.value = this.uA.texture; s.uH.value = this.hRT.texture;
    (s.uEps.value as THREE.Vector4).set(reg.epsX, reg.epsY, reg.epsD, reg.diag);
    s.uStep.value = this.steps >>> 0;
    const pins = pinTerms(this.kernel.lambda, classWeights(spec, this.seed, t), reg.diag, this.seed);
    const pv = s.uPin.value as THREE.Vector4[];
    for (let i = 0; i < 6; i++) { const p = pins[i]; if (p) pv[i].set(p.kx, p.ky, p.amp, p.phase); else pv[i].set(0, 0, 0, 0); }
    s.uPinCount.value = Math.min(6, pins.length);
    s.uPinAmp.value = PIN_AMP * pinGate(this.ratio);
    const sp = activeSpiral(this.seed, t);
    if (sp) {
      (s.uSpiral.value as THREE.Vector4).set(sp.ev.cx, sp.ev.cy, sp.ev.dir, sp.env);
      (s.uSpiralP.value as THREE.Vector2).set(t, K_SIGMA_E / this.kernel.sigmaE);
    } else (s.uSpiral.value as THREE.Vector4).set(0, 0, 1, 0);
    this.pass(this.matStep, this.uB);
    [this.uA, this.uB] = [this.uB, this.uA];
    this.steps++;
    void state;
  }

  private writeDisplay(): void {
    const d = this.matDisplay.uniforms;
    d.uU.value = this.uA.texture;
    (d.uDrift.value as THREE.Vector2).copy(this.drift);
    d.uDriftPhase.value = this.driftPhase;
    this.pass(this.matDisplay, this.display);
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    if (!this.initialised) this.init(renderer, state);
    this.renderer = renderer;
    const wall = Number.isFinite(state.wallTime) ? state.wallTime : 0;
    const dt = this.lastWall === null ? 0 : Math.min(0.25, Math.max(0, wall - this.lastWall));
    this.lastWall = wall;

    // ---- dynamics: fixed Δt sub-steps, capped per frame ----
    const spec = this.spec(state);
    this.lambdaTarget = this.lambdaFor(state, this.time);
    this.setKernel(this.lambdaTarget);
    this.targetRatio = gainRatio(state.intensity?.visual ?? 0, state.absorptionGain ?? 1);
    this.accum += dt;
    let n = Math.floor(this.accum / DT);
    if (n > MAX_STEPS_PER_FRAME) { n = MAX_STEPS_PER_FRAME; this.accum = 0; } else this.accum -= n * DT;
    for (let i = 0; i < n; i++) this.stepOnce(state, spec);
    if (Math.abs(this.ratio - this.targetRatio) < 0.02) this.settledFor += n * DT; else this.settledFor = 0;

    // ---- slow drift (baked into fieldTexture): rings expand, funnels rotate, spirals do both ----
    const w = classWeights(spec, this.seed, this.time);
    const ch = Math.max(0, Math.min(1, state.challenge?.active ? Math.max(0.6, state.challenge.level) : state.challenge?.level ?? 0));
    const pulse = Math.max(0, Math.min(1, state.pulse ?? 0));
    const hz = Math.min(DRIFT_HZ_MAX, (DRIFT_HZ + (DRIFT_HZ_CHALLENGE - DRIFT_HZ) * ch) * (0.75 + 0.25 * pulse));
    const speed = hz * this.kernel.lambda * dt;   // cells this frame; temporal frequency = hz ≤ 0.3 Hz
    const dirSpiral = this.regime.diag;
    const vx = w.stripes_x + 0.7071 * w.spirals + 0.5 * w.hexagons;
    const vy = w.stripes_y + 0.7071 * w.spirals * dirSpiral + 0.5 * w.hexagons;
    const norm = Math.max(1, Math.hypot(vx, vy));
    this.drift.x = (this.drift.x + (speed * vx) / norm) % FIELD_N;
    this.drift.y = (this.drift.y + (speed * vy) / norm) % FIELD_N;
    this.driftPhase = (this.driftPhase + hz * dt) % 1;
    this.hueShift = (this.hueShift + dt / 90) % 1;   // one slow palette walk per 90 s
    this.writeDisplay();
    state.fieldTexture = this.display.texture;

    // ---- composite into the scene target ----
    const lw = state.layerWeights as SharedState['layerWeights'] & { fieldModulation?: number };
    const wFc = Math.max(0, Math.min(1, lw.formConstants ?? 0));
    const wMod = MODULATION_ALPHA * Math.max(0, Math.min(1, lw.fieldModulation ?? 0)) * Math.max(0, Math.min(1, lw.room ?? 0));
    const alpha = Math.max(wFc, wMod);
    if (alpha < 0.002) { renderer.setRenderTarget(target); return; }
    const u = this.matRender.uniforms;
    u.uAspect.value = this.aspect;
    u.uPxH.value = this.pxH;
    u.uLambda.value = this.kernel.lambda;
    (u.uCentre.value as THREE.Vector2).set((state.look?.yaw ?? 0) * 0.3, (state.look?.pitch ?? 0) * 0.3);
    u.uScale.value = 1 + 0.6 * ch;                 // the tunnel narrows in a difficult passage
    u.uChallenge.value = ch;
    const vv = state.intensity?.visual ?? 0;
    u.uDepth.value = Math.max(0, Math.min(1, (vv - 3) / 6));
    u.uBright.value = 0.9 + 0.1 * pulse;           // ≤ 0.5 Hz, common factor: contrast unchanged
    u.uHueShift.value = this.hueShift;
    u.uAlpha.value = alpha;
    this.setPalette(state);
    this.quad.material = this.matRender;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  private paletteKey = '';
  private setPalette(state: SharedState): void {
    const cols = state.palette?.colours ?? [];
    const key = cols.join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    let lin = cols.map(srgbToLinear);
    // drop the darkest colour (the palette's background) when there are enough others
    if (lin.length > 2) {
      let di = 0;
      lin.forEach((c, i) => { if (lumOf(c) < lumOf(lin[di])) di = i; });
      lin = lin.filter((_, i) => i !== di);
    }
    if (lin.length === 0) lin = [new THREE.Vector3(1, 0.42, 0), new THREE.Vector3(0.08, 0.77, 1)];
    if (lin.length === 1) lin.push(lin[0].clone());
    lin = lin.slice(0, 6);
    // accent = most chromatic colour; deep = the darkest remaining colour (gradient keeps the rest)
    const chroma = (c: THREE.Vector3) => (Math.max(c.x, c.y, c.z) - Math.min(c.x, c.y, c.z)) / Math.max(1e-4, Math.max(c.x, c.y, c.z));
    let ai = 0, di = 0;
    lin.forEach((c, i) => { if (chroma(c) > chroma(lin[ai])) ai = i; if (lumOf(c) < lumOf(lin[di])) di = i; });
    (this.matRender.uniforms.uAccent.value as THREE.Vector3).copy(lin[ai]);
    (this.matRender.uniforms.uDeep.value as THREE.Vector3).copy(lin[di]);
    // the active phase walks through the clearly chromatic colours other than the deep one (pale,
    // near-white entries turn grey at the band luminance; dark ones wash out when scaled up)
    if (lin.length > 2) {
      const rest = lin.filter((_, i) => i !== di);
      const vivid = rest.filter((c) => chroma(c) >= 0.6);
      lin = vivid.length >= 2 ? vivid : rest.sort((p, q) => chroma(q) - chroma(p)).slice(0, Math.max(2, Math.min(3, rest.length)));
    }
    const arr = this.matRender.uniforms.uCols.value as THREE.Vector3[];
    for (let i = 0; i < 6; i++) arr[i].copy(lin[Math.min(i, lin.length - 1)]);
    this.matRender.uniforms.uNCols.value = lin.length;
  }

  /** Raw u of the GPU field (256², row-major y·256 + x), or null before init. */
  readField(): Float32Array | null {
    if (!this.renderer || !this.initialised) return null;
    const buf = new Float32Array(FIELD_N * FIELD_N * 4);
    this.renderer.readRenderTargetPixels(this.uA, 0, 0, FIELD_N, FIELD_N, buf);
    const out = new Float32Array(FIELD_N * FIELD_N);
    for (let i = 0; i < out.length; i++) out[i] = buf[i * 4];
    return out;
  }

  info(): Record<string, unknown> {
    return {
      ratio: this.ratio, targetRatio: this.targetRatio, betaC: this.betaC, lambda: this.kernel.lambda,
      regime: { ...this.regime }, time: this.time, steps: this.steps, ready: this.ready,
      predictedK: predictWavenumber(this.kernel.lambda, this.regime).k,
    };
  }

  dispose(): void {
    for (const rt of [this.uA, this.uB, this.hRT, this.display]) rt?.dispose();
    for (const m of [this.matInit, this.matBlur, this.matStep, this.matDisplay, this.matRender]) m?.dispose();
    this.quad.geometry.dispose();
    const hs = hooks();
    if (hs && hs.readField) { hs.readField = undefined; hs.fieldInfo = undefined; }
  }
}

export function createNeuralFieldLayer(): NeuralFieldLayer {
  return new NeuralFieldLayer();
}
