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
import bloomFrag from './glsl/fieldBloom.frag.glsl?raw';
import compositeFrag from './glsl/fieldComposite.frag.glsl?raw';

const TAPS = 2 * MAX_RADIUS + 1;
/** Log-polar window: field x = 0 at log r = X0; one full field period (2π in log r) covers
 *  r from e^X0 to e^(X0 + 2π) — the wrap lies inside the fovea (faded) and beyond the screen corners. */
const X0 = -5.0;
const R0 = 0.012;
/** Luminance plan (linear relative luminance; docs/VISUAL_DIRECTION.md 1-2; NOTES D-P-form_constants-6).
 *  CORE (an ellipse around the vanishing point, CORE_R x CORE_R / 0.9, rising with intensity): near-black
 *  ground (CORE_TROUGH), fat lit tubes (CORE_BODY) and thin crest lines (CREST_L) feeding the bloom. This
 *  is the only high-contrast periodic area; it is bounded (CORE_AREA_MAX of a 16:9 screen) and stays
 *  inside flashcheck's four central blocks (168 px tall, 151 px wide at 1280 x 720).
 *  LIT ANNULUS (everything outside the core): tubes at B0 x env over troughs at body / Ro, where env is
 *  an aperiodic illumination envelope (radial depth falloff, log-gradient ramping 0 -> K2 between
 *  ENV_R, and a side light LIGHT_A) and Ro = min(RATIO_MAX, WIN_C env / envMax) with envMax an exact
 *  upper bound of env within WIN screen heights, so any two points of a window of that extent
 *  (flashcheck's 160x180-px blocks, the limiter guard's 5x5 tiles) keep brightest body / darkest trough
 *  <= WIN_C (Michelson <= 0.44) by construction; troughs never fall below T_FLOOR there. Where env is
 *  steep, Ro falls toward 1 (RATIO_LOW) and the bands are carried by hue alone. */
const RATIO_MAX = 2.35;
const WIN = 0.33;
const WIN_C = 2.6;
const K2 = 0.8;
const ENV_R = [0.28, 0.8] as const;
const T_FLOOR = 0.02;
const RATIO_LOW = 1;                                 // where the envelope is steep the bands are hue only
const B0 = [0.105, 0.125] as const;                     // annulus centre-lines (band peak), v 4 -> 9
const CORE_TROUGH = 0.008;                           // ~ the palette's darkest colour
const CORE_BODY = [0.34, 0.45] as const;
const CORE_R_IN = [0.16, 0.18] as const;             // core fully on inside (screen heights), v 4 -> 9
const CORE_R_OUT = [0.19, 0.205] as const;           // core gone beyond
const CORE_AREA_MAX = Math.PI * CORE_R_OUT[1] ** 2 / 0.9 / (16 / 9);   // fraction of a 16:9 screen (0.087)
/** Side light across the lit annulus: lit / dark side = e^(2 LIGHT_A); its direction turns once per
 *  LIGHT_PERIOD_S (aperiodic in space, 0.017 Hz). */
const LIGHT_A = 0.25;
const LIGHT_PERIOD_S = 60;
/** Crest lines (core only): luminance and half width (px), v 4 -> 9. */
const CREST_L = [0.6, 0.9] as const;
const CREST_W = [0.5, 1.1] as const;
/** Accents (aperiodic, small area): glint peak luminance and noise threshold, central light. */
const GLINT_L = [0.45, 0.85] as const;     // spark peak, v 4 -> 9
const GLINT_TH = [0.8, 0.72] as const;      // value-noise threshold, v 4 -> 9 (lower = more sparks)
const CORE_L = [0.16, 0.3] as const;    // central star peak (Gaussian, sigma 0.014 screen heights)
/** Bloom gains (narrow, wide halo) of the crest lines + accents, v 4 -> 9. */
const BLOOM_A = [0.35, 0.7] as const;
const BLOOM_B = [0.2, 0.5] as const;
/** Drift: temporal frequency of the pattern at a fixed pixel (cycles per second). ≤ 2 Hz by a wide margin. */
const DRIFT_HZ = 0.05;          // at v <= 4; rises to DRIFT_HZ_HIGH at v = 9 (more motion)
const DRIFT_HZ_HIGH = 0.11;
const DRIFT_HZ_CHALLENGE = 0.22;
const DRIFT_HZ_MAX = 0.3;
/** Stained glass: hue cycles per unit log eccentricity; filament layer and parallax mid-ground strength, v 4 -> 9. */
const HUE_CYC = 0.45;
const FILIG = [0.45, 1] as const;
/** Aperiodic nebula dust in the annulus troughs: at most DUST_MAX x the trough (inside the window: <= Ro). */
const DUST_MAX = 1.3;
const MID = [0.6, 1] as const;
/** Render-side safety limits, exported for the unit tests. */
/** lMin / lMax: the lit pattern's window at its trough floor (troughs outside the core never go below
 *  lMin; the local body / trough ratio is between ratioLow and ratioMax); winC: max / min guaranteed
 *  over any window of radial extent win (screen heights) outside the core; coreAreaMax: the bounded
 *  high-contrast core as a fraction of a 16:9 screen. */
export const RENDER_LIMITS = Object.freeze({
  lMin: T_FLOOR, lMax: T_FLOOR * RATIO_MAX, driftHzMax: DRIFT_HZ_MAX, pulseBrightMin: 0.9,
  michelson: (RATIO_MAX - 1) / (RATIO_MAX + 1), ratioLow: RATIO_LOW, ratioMax: RATIO_MAX,
  win: WIN, winC: WIN_C, k2: K2, envR: ENV_R, b0: B0, coreAreaMax: CORE_AREA_MAX, coreROut: CORE_R_OUT,
  coreTrough: CORE_TROUGH, coreBody: CORE_BODY, crestL: CREST_L, bloomA: BLOOM_A, bloomB: BLOOM_B, lightA: LIGHT_A,
  crestW: CREST_W, glintL: GLINT_L, glintTh: GLINT_TH, filig: FILIG, mid: MID, dustMax: DUST_MAX, coreRIn: CORE_R_IN,
});
/** CPU replica of the shader's lit-annulus plan (fieldRender.frag.glsl lnEnv + the window rule), for the
 *  unit tests: tube-body and trough luminance at screen position (x, y) in screen heights from the view
 *  centre, for body level b0 and side-light direction `light` (radians). Outside the core only. */
export function annulusPlan(x: number, y: number, b0: number, light: number): { body: number; trough: number } {
  const sstep = (e0: number, e1: number, v: number) => { const s = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return s * s * (3 - 2 * s); };
  const lnEnvR = (rs: number) => {
    const xr = Math.min(1, Math.max(0, (rs - ENV_R[0]) / (ENV_R[1] - ENV_R[0])));
    return K2 * (ENV_R[1] - ENV_R[0]) * 0.5 * xr * xr + K2 * Math.max(0, rs - ENV_R[1]);
  };
  const rs = Math.hypot(x, y);
  const ca = (x * Math.cos(light) + y * Math.sin(light)) / Math.max(rs, 1e-4);
  const le = -lnEnvR(rs) - LIGHT_A * (1 - ca) * sstep(0.12, 0.45, rs);
  let leMax: number;
  if (rs <= WIN) leMax = -lnEnvR(0);
  else {
    const phi = Math.acos(Math.min(1, Math.max(-1, ca)));
    const caMax = Math.cos(Math.max(0, phi - Math.asin(WIN / rs)));
    const r0 = rs - WIN;
    leMax = -lnEnvR(r0) - LIGHT_A * (1 - caMax) * sstep(0.12, 0.45, r0);
  }
  let body = b0 * Math.exp(le);
  const ro = Math.min(RATIO_MAX, WIN_C * Math.exp(le - leMax));
  const trough = Math.max(body / ro, T_FLOOR);
  body = Math.max(body, trough);
  return { body, trough };
}

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
  private matBright!: THREE.ShaderMaterial;
  private matBlur2!: THREE.ShaderMaterial;
  private matComp!: THREE.ShaderMaterial;
  private matMod!: THREE.ShaderMaterial;
  // pattern at the scene resolution + quarter-resolution bloom chain (core crest lines + accents)
  private patRT: THREE.WebGLRenderTarget | null = null;
  private bloomRT: THREE.WebGLRenderTarget[] = [];
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
  private lightAngle = 2.2;
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
    this.lightAngle = ((this.seedH >>> 0) % 6283) / 1000;
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
      uBright: { value: 1 }, uHueShift: { value: 0 },
      uChallenge: { value: 0 }, uDepth: { value: 0 },
      uAccent: { value: new THREE.Vector3(0.1, 0.8, 1) }, uAccent2: { value: new THREE.Vector3(1, 0.2, 0.6) },
      uGlintC: { value: new THREE.Vector3(1, 0.9, 0.4) }, uDeep: { value: new THREE.Vector3(0.2, 0.05, 0.3) },
      uDrift: { value: new THREE.Vector2() }, uTime: { value: 0 }, uLattice: { value: 0 },
      uGlintL: { value: GLINT_L[0] }, uGlintTh: { value: GLINT_TH[0] }, uCoreL: { value: CORE_L[0] },
      uB0: { value: B0[0] }, uRatio: { value: RATIO_MAX }, uTFloor: { value: T_FLOOR },
      uEnvR: { value: new THREE.Vector2(ENV_R[0], ENV_R[1]) }, uK2: { value: K2 }, uLight: { value: new THREE.Vector3(0, 0, 0) }, uWin: { value: WIN }, uWinC: { value: WIN_C },
      uCoreTrough: { value: CORE_TROUGH }, uCoreBody: { value: CORE_BODY[0] },
      uCoreR: { value: new THREE.Vector2(CORE_R_IN[0], CORE_R_OUT[0]) },
      uCrestL: { value: CREST_L[0] }, uCrestW: { value: CREST_W[0] },
      uCrestC: { value: new THREE.Vector3(0.6, 0.9, 1) }, uMidC: { value: new THREE.Vector3(0.3, 0.02, 0.1) },
      uGlintC2: { value: new THREE.Vector3(0.1, 0.8, 1) }, uCyc: { value: HUE_CYC }, uFilig: { value: FILIG[0] }, uMid: { value: MID[0] }, uDustMax: { value: DUST_MAX },
    });
    const bloomU = () => ({ uSrc: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uDir: { value: new THREE.Vector2(1, 0) } });
    this.matBright = mk('#define MODE 0\n' + bloomFrag, bloomU());
    this.matBlur2 = mk('#define MODE 1\n' + bloomFrag, bloomU());
    this.matComp = mk(compositeFrag, {
      uPattern: { value: null }, uBloomA: { value: null }, uBloomB: { value: null },
      uGainA: { value: 0 }, uGainB: { value: 0 }, uAlpha: { value: 0 },
    }, true);
    // room modulation: scene x (1 + amp (clamp(L / ref, 0.3, 2) - 1)), multiplicative blending
    this.matMod = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, uniforms: { uPattern: { value: null }, uAmp: { value: 0 }, uRef: { value: 0.06 } },
      fragmentShader: `precision highp float;
in vec2 vUv; uniform sampler2D uPattern; uniform float uAmp; uniform float uRef; out vec4 outColor;
void main() {
  float l = dot(texture(uPattern, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(vec3(1.0 + uAmp * (clamp(l / uRef, 0.3, 2.0) - 1.0)), 1.0);
}`,
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    });
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
    const vv = state.intensity?.visual ?? 0;
    const lv = Math.max(0, Math.min(1, (vv - 4) / 5));   // rendering intensity 0 at v <= 4, 1 at v >= 9
    const base = DRIFT_HZ + (DRIFT_HZ_HIGH - DRIFT_HZ) * lv;
    const hz = Math.min(DRIFT_HZ_MAX, (base + (DRIFT_HZ_CHALLENGE - base) * ch) * (0.75 + 0.25 * pulse));
    const speed = hz * this.kernel.lambda * dt;   // cells this frame; temporal frequency = hz ≤ 0.3 Hz
    const dirSpiral = this.regime.diag;
    const vx = w.stripes_x + 0.7071 * w.spirals + 0.5 * w.hexagons;
    const vy = w.stripes_y + 0.7071 * w.spirals * dirSpiral + 0.5 * w.hexagons;
    const norm = Math.max(1, Math.hypot(vx, vy));
    this.drift.x = (this.drift.x + (speed * vx) / norm) % FIELD_N;
    this.drift.y = (this.drift.y + (speed * vy) / norm) % FIELD_N;
    this.driftPhase = (this.driftPhase + hz * dt) % 1;
    this.hueShift = (this.hueShift + dt / 90) % 1;   // one slow palette walk per 90 s
    this.lightAngle = (this.lightAngle + dt * 2 * Math.PI / LIGHT_PERIOD_S) % (2 * Math.PI);
    this.writeDisplay();
    state.fieldTexture = this.display.texture;

    // ---- composite into the scene target ----
    const lw = state.layerWeights as SharedState['layerWeights'] & { fieldModulation?: number };
    const wFc = Math.max(0, Math.min(1, lw.formConstants ?? 0));
    // faint field modulation of the room (after / before the form-constant layer, §11.2): multiplicative and
    // luminance-only, and off with the eyes closed (the room draws its own phosphene field then; NOTES
    // integration requests polish-room-r1 / r2)
    const eyes = Math.max(0, Math.min(1, state.eyesClosed ?? 0));
    const wMod = MODULATION_ALPHA * Math.max(0, Math.min(1, lw.fieldModulation ?? 0)) * Math.max(0, Math.min(1, lw.room ?? 0)) * (1 - eyes);
    if (Math.max(wFc, wMod) < 0.002) { renderer.setRenderTarget(target); return; }
    const u = this.matRender.uniforms;
    u.uAspect.value = this.aspect;
    u.uPxH.value = this.pxH;
    u.uLambda.value = this.kernel.lambda;
    (u.uCentre.value as THREE.Vector2).set((state.look?.yaw ?? 0) * 0.3, (state.look?.pitch ?? 0) * 0.3);
    u.uScale.value = 1 + 0.6 * ch;                 // the tunnel narrows in a difficult passage
    u.uChallenge.value = ch;
    u.uDepth.value = Math.max(0, Math.min(1, (vv - 3) / 6));
    const lerp = (r: readonly [number, number]) => r[0] + (r[1] - r[0]) * lv;
    u.uB0.value = lerp(B0) * (1 - 0.3 * ch);       // difficult passage: darker ground, lines carry it
    (u.uLight.value as THREE.Vector3).set(this.lightAngle, LIGHT_A, 0);
    u.uCoreBody.value = lerp(CORE_BODY);
    // the core tightens in a difficult passage (and a little for lattices, whose finer cells are detected as
    // a pattern around it by the limiter's guard; NOTES D-P-form_constants-12)
    const coreK = (1 - 0.2 * ch) * (1 - 0.14 * Math.max(0, Math.min(1, w.hexagons)));
    (u.uCoreR.value as THREE.Vector2).set(lerp(CORE_R_IN) * coreK, lerp(CORE_R_OUT) * coreK);
    u.uCrestL.value = lerp(CREST_L);
    u.uCrestW.value = lerp(CREST_W);
    u.uGlintL.value = lerp(GLINT_L);
    u.uGlintTh.value = lerp(GLINT_TH);
    u.uCoreL.value = lerp(CORE_L);
    u.uFilig.value = lerp(FILIG);
    u.uMid.value = lerp(MID);
    u.uLattice.value = Math.max(0, Math.min(1, w.hexagons));
    (u.uDrift.value as THREE.Vector2).copy(this.drift);
    u.uTime.value = this.time;
    u.uBright.value = 0.94 + 0.06 * pulse;         // ≤ 0.5 Hz, common factor: contrast unchanged
    u.uHueShift.value = this.hueShift;
    this.setPalette(state);
    // 1) pattern → patRT (scene resolution); 2) crest lines + accents → quarter-res bloom (narrow, then wide);
    // 3) composite into the scene target with the layer weight
    const tw = target ? target.width : Math.round(this.pxH * this.aspect);
    const th = target ? target.height : this.pxH;
    this.ensureTargets(tw, th);
    const pat = this.patRT!;
    const [b1, b2, b3] = this.bloomRT;
    this.pass(this.matRender, pat);
    const qb = this.matBright.uniforms;
    qb.uSrc.value = pat.texture; (qb.uTexel.value as THREE.Vector2).set(1 / pat.width, 1 / pat.height);
    this.pass(this.matBright, b1);
    const bl = this.matBlur2.uniforms;
    (bl.uTexel.value as THREE.Vector2).set(1 / b1.width, 1 / b1.height);
    const blur = (src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, dx: number, dy: number) => {
      bl.uSrc.value = src.texture; (bl.uDir.value as THREE.Vector2).set(dx, dy); this.pass(this.matBlur2, dst);
    };
    blur(b1, b2, 1, 0); blur(b2, b1, 0, 1);         // narrow halo (σ ≈ 2 quarter texels ≈ 8 px)
    blur(b1, b2, 3, 0); blur(b2, b3, 0, 3);         // wide halo (σ ≈ 6.5 quarter texels ≈ 26 px)
    const cu = this.matComp.uniforms;
    cu.uPattern.value = pat.texture; cu.uBloomA.value = b1.texture; cu.uBloomB.value = b3.texture;
    cu.uGainA.value = lerp(BLOOM_A); cu.uGainB.value = lerp(BLOOM_B);
    renderer.setRenderTarget(target);
    if (wMod >= 0.002) {
      const mu = this.matMod.uniforms;
      mu.uPattern.value = pat.texture; mu.uAmp.value = wMod; mu.uRef.value = 0.55 * lerp(B0);
      this.quad.material = this.matMod;
      renderer.render(this.scene, this.camera);
    }
    if (wFc >= 0.002) {
      cu.uAlpha.value = wFc;
      this.quad.material = this.matComp;
      renderer.render(this.scene, this.camera);
    }
  }

  private ensureTargets(w: number, h: number): void {
    w = Math.max(1, w); h = Math.max(1, h);
    if (this.patRT && this.patRT.width === w && this.patRT.height === h) return;
    this.patRT?.dispose();
    for (const rt of this.bloomRT) rt.dispose();
    const mk = (ww: number, hh: number) => new THREE.WebGLRenderTarget(ww, hh, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.patRT = mk(w, h);
    const qw = Math.max(1, Math.ceil(w / 4)), qh = Math.max(1, Math.ceil(h / 4));
    this.bloomRT = [mk(qw, qh), mk(qw, qh), mk(qw, qh)];
  }

  private paletteKey = '';
  private setPalette(state: SharedState): void {
    const cols = state.palette?.colours ?? [];
    const key = cols.join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    let lin = cols.map(srgbToLinear);
    if (lin.length === 0) lin = [new THREE.Vector3(0.01, 0.003, 0.03), new THREE.Vector3(1, 0.42, 0), new THREE.Vector3(0.08, 0.77, 1)];
    if (lin.length === 1) lin.push(lin[0].clone());
    const U = this.matRender.uniforms;
    const chroma = (c: THREE.Vector3) => (Math.max(c.x, c.y, c.z) - Math.min(c.x, c.y, c.z)) / Math.max(1e-4, Math.max(c.x, c.y, c.z));
    const hue = (c: THREE.Vector3) => { const k = new THREE.Color(c.x, c.y, c.z); const hsl = { h: 0, s: 0, l: 0 }; k.getHSL(hsl); return hsl.h; };
    const hueDist = (p: THREE.Vector3, q: THREE.Vector3) => { const d = Math.abs(hue(p) - hue(q)); return Math.min(d, 1 - d); };
    // deep = the palette's darkest colour (its background): the troughs and the core ground
    let di = 0;
    lin.forEach((c, i) => { if (lumOf(c) < lumOf(lin[di])) di = i; });
    const deep = lin[di];
    (U.uDeep.value as THREE.Vector3).copy(deep);
    const rest = lin.length > 2 ? lin.filter((_, i) => i !== di) : lin;
    // orange .. lime hues turn olive / brown at band luminance (~0.1): they go to the sparks instead
    const warmMuddy = (c: THREE.Vector3) => { const h = hue(c); return h > 0.075 && h < 0.25; };
    // band colours (the stained-glass cycle along the radius): hue-distinct chromatic palette colours that
    // stay luminous at band luminance (~0.1) once the shader pushes them to full chroma, i.e. blue, violet,
    // magenta, crimson hues; cyan, green and yellow turn murky teal / olive there (they go to the core,
    // the filaments and the sparks); palette order
    const glowHue = (c: THREE.Vector3) => { const h = hue(c); return h >= 0.6 || h < 0.04; };
    const pick = (minChroma: number) => rest.filter((c) => chroma(c) >= minChroma && !warmMuddy(c));
    let cand = pick(0.3).filter(glowHue);
    if (cand.length < 2) cand = [...cand, ...pick(0.3).filter((c) => !glowHue(c)).sort((p, q) => chroma(q) - chroma(p))];
    if (cand.length < 2) cand = [...rest].sort((p, q) => chroma(q) - chroma(p)).slice(0, 2);
    const bodies: THREE.Vector3[] = [];
    for (const c of cand) if (bodies.every((b) => hueDist(b, c) >= 0.05)) bodies.push(c);
    if (bodies.length < 2) bodies.push(cand.find((c) => !bodies.includes(c)) ?? bodies[0]);
    const arr = U.uCols.value as THREE.Vector3[];
    for (let i = 0; i < 6; i++) arr[i].copy(bodies[Math.min(i, bodies.length - 1)]);
    // a third jewel hue for the stained-glass cycle when the palette has only two that glow at band
    // luminance: the bluest band colour turned further toward electric blue
    if (bodies.length === 2 && bodies.filter(glowHue).length === 2) {
      const bl = [...bodies].sort((p, q) => Math.abs(hue(p) - 0.66) - Math.abs(hue(q) - 0.66))[0];
      const k = new THREE.Color(bl.x, bl.y, bl.z); const hsl = { h: 0, s: 0, l: 0 }; k.getHSL(hsl);
      k.setHSL(Math.max(0.6, hsl.h - 0.07), Math.min(1, hsl.s * 1.1), hsl.l);
      bodies.splice(1, 0, new THREE.Vector3(k.r, k.g, k.b));
      for (let i = 0; i < 6; i++) arr[i].copy(bodies[Math.min(i, bodies.length - 1)]);
    }
    U.uNCols.value = Math.min(6, bodies.length);
    // mid-ground glow in the troughs (a deeper, out-of-focus layer): the band colour closest to a cool
    // blue-violet (a warm or cyan tint reads as a wine or teal plateau at trough luminance)
    const hd = (c: THREE.Vector3) => { const d = Math.abs(hue(c) - 0.68); return Math.min(d, 1 - d); };
    const midC = [...bodies].sort((p, q) => hd(p) - hd(q))[0];
    (U.uMidC.value as THREE.Vector3).copy(midC);
    // filaments: the chromatic colours farthest in hue from the first band colour (never orange / yellow /
    // olive hues: at filament luminance they turn brown)
    const chromatic = rest.filter((c) => chroma(c) >= 0.5);
    const pool = chromatic.length >= 2 ? chromatic : rest;
    const cool = pool.filter((c) => !warmMuddy(c));
    const byDist = [...(cool.length ? cool : pool)].sort((p, q) => hueDist(q, bodies[0]) - hueDist(p, bodies[0]));
    (U.uAccent.value as THREE.Vector3).copy(byDist[0]);
    (U.uAccent2.value as THREE.Vector3).copy(byDist[Math.min(1, byDist.length - 1)]);
    // sparks: the brightest chromatic colours (gold, cyan, lime look brilliant at accent luminance)
    const bright = [...pool].sort((p, q) => lumOf(q) - lumOf(p));
    (U.uGlintC.value as THREE.Vector3).copy(bright[0]);
    const second = bright.find((c) => hueDist(c, bright[0]) >= 0.12) ?? bright[Math.min(1, bright.length - 1)];
    (U.uGlintC2.value as THREE.Vector3).copy(second);
    // crest lines: the brightest palette colour (drawn at 0.6-0.9 luminance, where only light colours exist)
    const crestC = [...rest].sort((p, q) => lumOf(q) - lumOf(p))[0];
    (U.uCrestC.value as THREE.Vector3).copy(crestC);
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
    for (const m of [this.matInit, this.matBlur, this.matStep, this.matDisplay, this.matRender, this.matBright, this.matBlur2, this.matComp, this.matMod]) m?.dispose();
    this.patRT?.dispose(); this.patRT = null;
    for (const rt of this.bloomRT) rt.dispose();
    this.bloomRT = [];
    this.quad.geometry.dispose();
    const hs = hooks();
    if (hs && hs.readField) { hs.readField = undefined; hs.fieldInfo = undefined; }
  }
}

export function createNeuralFieldLayer(): NeuralFieldLayer {
  return new NeuralFieldLayer();
}
