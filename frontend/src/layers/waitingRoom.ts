// Waiting room (BUILD.md §11.6, docs/VISUAL_DIRECTION.md §3): a ray-marched, self-lit fractal interior
// (glsl/waitingRoom.frag.glsl): kind "kifs" = a kaleidoscopic nave whose walls are a Menger-type
// kaleidoscopic IFS, "mandelbox" = a hall between Mandelbox blocks (tripScript.layers.waiting_room.kind).
// Near-black ambient, emissive ornament in two palette colours (waitingRoomLights) with coloured spill on
// the surfaces, ambient occlusion, distance fading to a deep palette colour near black, a stable dark
// peripheral frame, constant-velocity drift with a stable horizon (§4.5), and a bloom pass (bright pass at
// 1/4 and 1/8 resolution, separable Gaussian, added back) so the ornament reads as light.
// Quality knob: `quality` (0.5–1) scales the ray-march step budget and the internal resolution.

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { deriveSeed } from '../rng';
import { preparePalette } from './hyperbolic';
import vert from './glsl/hyperbolic.vert.glsl?raw';
import frag from './glsl/waitingRoom.frag.glsl?raw';

// bright pass + 2x2 box downsample (4 bilinear taps)
const BRIGHT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uLo;
uniform float uHi;
void main() {
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uLo, uHi, l), 1.0);
}
`;
// separable 9-tap Gaussian (linear-sampled: 5 fetches)
const BLUR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;
  c += (texture2D(uTex, vUv + uDir * 1.3846153846).rgb + texture2D(uTex, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture2D(uTex, vUv + uDir * 3.2307692308).rgb + texture2D(uTex, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;
// scene + bloom, alpha = layer weight (blended over the scene target)
const COMPOSITE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform vec2 uGain;
void main() {
  vec4 b = texture2D(uTex, vUv);
  // less bloom towards the frame's edges (a calm, darker peripheral frame; the near walls there would
  // otherwise bloom into broad smears)
  vec2 q = (vUv - 0.5) * 2.0;
  float edge = 1.0 - 0.6 * smoothstep(0.45, 1.1, length(q));
  vec3 c = b.rgb + (texture2D(uB1, vUv).rgb * uGain.x + texture2D(uB2, vUv).rgb * uGain.y) * edge;
  // no near-white after the bloom either (luminance ceiling 0.9, hue kept)
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l > 0.9) c *= 0.9 / l;
  gl_FragColor = vec4(c, b.a);
}
`;

/** Per-kind drift: units per second along +z (wall rings are 1.1 units (kifs) / blocks 16 units (mandelbox) long). */
const KINDS = {
  kifs: { id: 0, speed: 0.05, far: 16, path: [0, 0], gaze: [0, 0] },     // down the axis of the kaleidoscopic nave (rings 1.1 units)
  mandelbox: { id: 1, speed: 0.15, far: 40, path: [3.85, 4.1], gaze: [0.05, 0.03] },   // down the crossing of two halls (near walls at the frame's edges, the glowing depth in the centre)
} as const;

export class WaitingRoomLayer implements Layer<SharedState> {
  readonly name = 'waiting_room';
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private fx = new THREE.Scene();
  private fxQuad: THREE.Mesh;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private rtScene: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget[] = [];   // 1/4 res ping-pong
  private rtC: THREE.WebGLRenderTarget[] = [];   // 1/8 res ping-pong
  /** Bloom gains (1/4 res, 1/8 res) at full intensity; scaled by 0.95–1 with intensity. */
  bloom: [number, number] = [1.25, 1.0];
  private w = 1;
  private h = 1;
  private kind: keyof typeof KINDS = 'kifs';
  zOffset = 0;
  private scriptKey: unknown = undefined;
  private paletteKey = '';
  /** 0.5–1: ray-march steps 64 + 64·q; internal resolution q (rendered at the pipeline scale × q). */
  quality = 1;
  private flow = 0;
  private lastWall = 0;
  /** Debug/tuning: override the drift line (x, y) and the start offset along it. */
  pathOverride: [number, number] | null = null;
  /** Debug/tuning: override the fixed gaze (yaw, pitch in rad) of the kind. */
  gazeOverride: [number, number] | null = null;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uWeight: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 0 },
        uIntensity: { value: 0 }, uChallenge: { value: 0 }, uLook: { value: new THREE.Vector2() },
        uCam: { value: new THREE.Vector3() }, uPath: { value: new THREE.Vector2() }, uKind: { value: 0 }, uMorph: { value: 0 }, uSteps: { value: 128 },
        uFar: { value: 14 }, uPal: { value: preparePalette(undefined) },
        uEmA: { value: new THREE.Color(1, 1, 1) }, uEmB: { value: new THREE.Color(1, 1, 1) }, uDeep: { value: new THREE.Color(1, 1, 1) }, uGlow: { value: new THREE.Color(1, 1, 1) },
        uGaze: { value: new THREE.Vector2() }, uFlow: { value: 0 }, uSpeed: { value: 0 }, uSpillB: { value: new THREE.Color(1, 1, 1) }, uEmC: { value: new THREE.Color(1, 1, 1) }, uField: { value: null }, uHasField: { value: 0 }, uDbg: { value: 0 },
      },
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    q.frustumCulled = false;
    this.scene.add(q);
    const fxMat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blend = false) => new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader, depthTest: false, depthWrite: false, uniforms,
      transparent: blend, blending: blend ? THREE.CustomBlending : THREE.NoBlending,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.brightMat = fxMat(BRIGHT_FRAG, { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uLo: { value: 0.07 }, uHi: { value: 0.45 } });
    this.blurMat = fxMat(BLUR_FRAG, { uTex: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.compMat = fxMat(COMPOSITE_FRAG, { uTex: { value: null }, uB1: { value: null }, uB2: { value: null }, uGain: { value: new THREE.Vector2() } }, true);
    this.fxQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat);
    this.fxQuad.frustumCulled = false;
    this.fx.add(this.fxQuad);
  }

  init(_renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.configure(state);
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  private configure(state: SharedState): void {
    const k = (state.tripScript?.layers as Record<string, any> | undefined)?.waiting_room?.kind;
    const kind = k === 'mandelbox' ? 'mandelbox' : 'kifs';
    if (this.scriptKey === state.tripScript && this.scriptKey !== undefined && kind === this.kind) return;
    this.scriptKey = state.tripScript;
    this.kind = kind;
    const seed = deriveSeed(state.seed >>> 0, 'waiting_room');
    const cell = this.kind === 'mandelbox' ? 16 : 2;
    this.zOffset = ((seed % 10007) / 10007) * cell * 7;   // seeded starting point along the nave
  }

  private setPalette(state: SharedState): void {
    const key = (state.palette?.colours ?? []).join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const pal = preparePalette(state.palette?.colours);
    this.material.uniforms.uPal.value = pal;
    const { a, b, c, deep, spillB } = waitingRoomLights(state.palette?.colours, pal);
    (this.material.uniforms.uEmC.value as THREE.Color).copy(c);
    (this.material.uniforms.uGlow.value as THREE.Color).copy(deep);
    (this.material.uniforms.uSpillB.value as THREE.Color).copy(spillB);
    (this.material.uniforms.uEmA.value as THREE.Color).copy(a);
    (this.material.uniforms.uEmB.value as THREE.Color).copy(b);
    (this.material.uniforms.uDeep.value as THREE.Color).copy(deep);
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    this.configure(state);
    const wgt = state.layerWeights.waitingRoom;
    if (wgt < 0.002) return;
    this.setPalette(state);
    const u = this.material.uniforms;
    const spec = KINDS[this.kind];
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    const q = Math.max(0.5, Math.min(1, this.quality));
    u.uWeight.value = wgt;
    u.uTime.value = state.wallTime;
    u.uPulse.value = state.pulse;
    u.uIntensity.value = Math.max(0, Math.min(1, state.intensity.visual / 10));
    u.uChallenge.value = ch;
    (u.uLook.value as THREE.Vector2).set(state.look.yaw, state.look.pitch);
    // constant-velocity drift (no acceleration): position is linear in wall time
    const path = this.pathOverride ?? spec.path;
    (u.uPath.value as THREE.Vector2).set(path[0], path[1]);
    (u.uCam.value as THREE.Vector3).set(path[0], path[1], this.zOffset + spec.speed * state.wallTime);
    u.uKind.value = spec.id;
    const gz = this.gazeOverride ?? spec.gaze;
    (u.uGaze.value as THREE.Vector2).set(gz[0], gz[1]);
    u.uSpeed.value = spec.speed;
    u.uFar.value = spec.far;
    u.uSteps.value = Math.round(64 + 64 * q);
    // slow morph of the fold geometry (period ≈ 52 s)
    u.uMorph.value = (2 * Math.PI * state.wallTime) / 52;
    // light flowing along the ornament: faster with intensity (0.06 → 0.22 cycles/s, ≤ 0.3 Hz with the
    // challenge), integrated so a change of intensity never jumps the phase
    const dt = Math.max(0, Math.min(0.25, state.wallTime - this.lastWall));
    this.lastWall = state.wallTime;
    const vI = Math.max(0, Math.min(1, (state.intensity.visual - 4) / 5));
    this.flow = (this.flow + dt * flowRate(vI, ch)) % 1000;
    u.uFlow.value = this.flow;
    const tex = state.fieldTexture;
    if (tex && (tex as THREE.Texture).isTexture) { u.uField.value = tex; u.uHasField.value = 1; }
    else { u.uField.value = null; u.uHasField.value = 0; }

    // ray-march (opaque) at the internal resolution, then bloom, then blend over the scene target
    const rw = Math.max(4, Math.round(this.w * q));
    const rh = Math.max(4, Math.round(this.h * q));
    this.ensureTargets(rw, rh);
    (u.uRes.value as THREE.Vector2).set(rw, rh);
    this.material.transparent = false;
    this.material.blending = THREE.NoBlending;
    renderer.setRenderTarget(this.rtScene);
    renderer.render(this.scene, this.camera);

    const pass = (mat: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
      this.fxQuad.material = mat;
      renderer.setRenderTarget(to);
      renderer.render(this.fx, this.camera);
    };
    const [b0, b1] = this.rtB;
    const [c0, c1] = this.rtC;
    const bu = this.brightMat.uniforms;
    bu.uTex.value = this.rtScene!.texture;
    (bu.uTexel.value as THREE.Vector2).set(1 / rw, 1 / rh);
    pass(this.brightMat, b0);                                   // 1/2 → effectively a 4x4 box into 1/4 res
    const blur = (src: THREE.WebGLRenderTarget, tmp: THREE.WebGLRenderTarget) => {
      const lu = this.blurMat.uniforms;
      lu.uTex.value = src.texture; (lu.uDir.value as THREE.Vector2).set(1 / src.width, 0); pass(this.blurMat, tmp);
      lu.uTex.value = tmp.texture; (lu.uDir.value as THREE.Vector2).set(0, 1 / src.height); pass(this.blurMat, src);
    };
    blur(b0, b1);
    bu.uTex.value = b0.texture;
    (bu.uTexel.value as THREE.Vector2).set(0.5 / b0.width, 0.5 / b0.height);
    bu.uLo.value = 0; bu.uHi.value = 1e-4;                     // plain downsample for the wide level
    pass(this.brightMat, c0);
    bu.uLo.value = 0.07; bu.uHi.value = 0.45;
    blur(c0, c1);
    const cu = this.compMat.uniforms;
    cu.uTex.value = this.rtScene!.texture;
    cu.uB1.value = b0.texture;
    cu.uB2.value = c0.texture;
    const bg = bloomGain(vI, ch);
    (cu.uGain.value as THREE.Vector2).set(this.bloom[0] * bg, this.bloom[1] * bg);
    pass(this.compMat, target);
  }

  private ensureTargets(rw: number, rh: number): void {
    if (this.rtScene && this.rtScene.width === rw && this.rtScene.height === rh) return;
    this.disposeTargets();
    const mk = (w: number, h: number) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.rtScene = mk(rw, rh);
    const bw = Math.ceil(rw / 4), bh = Math.ceil(rh / 4);
    this.rtB = [mk(bw, bh), mk(bw, bh)];
    this.rtC = [mk(Math.ceil(bw / 2), Math.ceil(bh / 2)), mk(Math.ceil(bw / 2), Math.ceil(bh / 2))];
  }

  private disposeTargets(): void {
    this.rtScene?.dispose();
    for (const r of [...this.rtB, ...this.rtC]) r.dispose();
    this.rtScene = null;
    this.rtB = [];
    this.rtC = [];
  }

  dispose(): void {
    this.material.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.disposeTargets();
  }
}

export function createWaitingRoomLayer(): WaitingRoomLayer {
  return new WaitingRoomLayer();
}

/** Light-flow rate along the waiting-room ornament (cycles per second), ≤ 0.3 Hz (BUILD.md §4.1: ≤ 2 Hz). */
export function flowRate(vI: number, challenge: number): number {
  const v = Math.max(0, Math.min(1, vI));
  const c = Math.max(0, Math.min(1, challenge));
  return (0.06 + 0.16 * v) * (1 + 0.35 * c);
}

/** Bloom gain factor: 0.95–1 with intensity, × up to 1.4 in a difficult passage (more glow on the thin acid
 *  filaments on black; the composite still caps luminance at 0.9). */
export function bloomGain(vI: number, challenge: number): number {
  const v = Math.max(0, Math.min(1, vI));
  const c = Math.max(0, Math.min(1, challenge));
  return (0.95 + 0.05 * v) * (1 + 0.4 * c);
}

const LUM = [0.2126, 0.7152, 0.0722];
const lumOf = (c: THREE.Color) => c.r * LUM[0] + c.g * LUM[1] + c.b * LUM[2];
function hueChroma(c: THREE.Color): { h: number; s: number } {
  // hue and saturation of the (linear) colour itself; channels may exceed 1 (preparePalette), so no getHSL
  const r = Math.max(0, c.r), g = Math.max(0, c.g), b = Math.max(0, c.b);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h / 6, s: mx > 1e-6 ? d / mx : 0 };
}
/**
 * Push a colour towards full saturation at the same luminance (subtract most of its grey part), but keep
 * the red share R/(R+G+B) ≤ 0.72 (the saturated-red flash rule starts at 0.8, §4.1).
 */
export function jewelise(c: THREE.Color, k = 0.85): THREE.Color {
  for (let kk = k; kk > 0; kk -= 0.05) {
    const m = Math.min(c.r, c.g, c.b) * kk;
    const r = c.r - m, g = c.g - m, b = c.b - m;
    if (r / Math.max(1e-6, r + g + b) <= 0.72) return atLum(new THREE.Color(r, g, b), lumOf(c));
  }
  return capRed(c);
}

/** Pull a colour towards its own grey (same luminance) until red holds no more than `max` of R+G+B
 *  (margin to the saturated-red flash rule, R/(R+G+B) ≥ 0.8, §4.1; other hues are left saturated). */
function capRed(c: THREE.Color, max = 0.72): THREE.Color {
  const l = lumOf(c);
  let r = c.r, g = c.g, b = c.b;
  for (let k = 0; k < 60 && r / Math.max(1e-6, r + g + b) > max; k++) {
    r = l + (r - l) * 0.92; g = l + (g - l) * 0.92; b = l + (b - l) * 0.92;
  }
  return new THREE.Color(r, g, b);
}
const atMax = (c: THREE.Color) => c.clone().multiplyScalar(1 / Math.max(1e-6, c.r, c.g, c.b));
const atLum = (c: THREE.Color, l: number) => c.clone().multiplyScalar(l / Math.max(1e-6, lumOf(c)));

/**
 * The waiting room's light: two emissive colours from the trip palette (the most saturated colour, and
 * the most saturated colour far from it in hue) and a deep colour for the distance (the palette's darkest
 * colour, saturated), plus C (a third colour for variety) and spillB (the colour B's light throws on
 * surfaces). All LINEAR; the light colours are normalised to max channel 1, deep to luminance 1.
 */
export function waitingRoomLights(hex: string[] | undefined, prepared?: THREE.Color[]): { a: THREE.Color; b: THREE.Color; c: THREE.Color; deep: THREE.Color; spillB: THREE.Color } {
  // the light colours are the palette's own hues at full chroma (the raw trip-palette colours, linear), so
  // a neon palette glows hot pink and cyan rather than the softened surface hues of preparePalette; the
  // prepared palette is only the fallback when there is no usable trip palette
  const raw: THREE.Color[] = [];
  for (const h of hex ?? []) { try { raw.push(new THREE.Color().set(h)); } catch { /* skip */ } }
  const pal = raw.length >= 3 ? raw.map((c) => capRedHue(c)) : (prepared ?? preparePalette(hex));
  // near-black palette entries (the base colour) are never a light
  const hc = pal.map((c) => { const x = hueChroma(c); return { h: x.h, s: x.s * (lumOf(c) < 0.004 ? 0.1 : 1) }; });
  // yellows, oranges and limes turn brown / olive wherever their light is dim (spill, halo, bloom), so they are only
  // chosen when the palette offers nothing else as saturated
  const warm = (h: number) => (h > 0.035 && h < 0.27 ? 0.45 : 1);   // linear-light hue: oranges sit at 0.04–0.08
  let ia = 0;
  hc.forEach((x, i) => { if (x.s * warm(x.h) > hc[ia].s * warm(hc[ia].h)) ia = i; });
  const hueDist = (h1: number, h2: number) => { const d = Math.abs(h1 - h2) % 1; return Math.min(d, 1 - d) * 2; };
  let ib = ia === 0 ? 1 : 0;
  let best = -1;
  hc.forEach((x, i) => {
    if (i === ia) return;
    const sc = x.s * (0.15 + hueDist(x.h, hc[ia].h)) * warm(x.h);
    if (sc > best) { best = sc; ib = i; }
  });
  const a = atLum(pal[ia], 1);
  const b = atLum(pal[ib], 1);
  // C: a third, cool-leaning colour for surface tint and spill variety (most saturated of the rest,
  // preferring a hue away from A; falls back to A)
  let ic = ia;
  best = -1;
  hc.forEach((x, i) => {
    if (i === ia || i === ib) return;
    const sc = Math.sqrt(x.s) * (0.1 + hueDist(x.h, hc[ia].h)) * warm(x.h) * warm(x.h);
    if (sc > best) { best = sc; ic = i; }
  });
  const c = warm(hc[ic].h) < 1 ? a.clone() : atLum(pal[ic], 1);
  // deep: the darkest raw palette colour (planner palettes start with one), chroma pushed, luminance 1
  let deep: THREE.Color | null = null;
  let dl = Infinity;
  for (const h of hex ?? []) {
    const c = new THREE.Color();
    try { c.set(h); } catch { continue; }
    const l = lumOf(c);
    if (l < dl) { dl = l; deep = c; }
  }
  if (!deep || hueChroma(deep).s < 0.25) deep = pal[ib].clone();
  const dlum = Math.max(1e-6, lumOf(deep));
  const dn = deep.clone().multiplyScalar(1 / dlum);
  dn.setRGB(Math.max(0, 1 + (dn.r - 1) * 1.3), Math.max(0, 1 + (dn.g - 1) * 1.3), Math.max(0, 1 + (dn.b - 1) * 1.3));
  // the light B throws on the surfaces: B itself unless it is a yellow/orange (dim → brown), then A.
  // Surface colours are dim, so they get the full jewel saturation (a dim pastel reads as maroon / grey)
  // (the second block colour: B, or when B is a yellow/orange the third colour C, so a palette with a gold
  // accent still has two luminous cool block colours; gold then only shows in bright thin lines)
  const spillB = jewelise(warm(hc[ib].h) < 1 ? c : b);
  // light colours at full chroma and their brightest: max channel 1 (a blue or crimson light is darker
  // than a cyan one, but it never washes towards white or salmon); deep stays at luminance 1
  return { a: atMax(capRedHue(a)), b: atMax(capRedHue(b)), c: atMax(capRedHue(jewelise(c))), deep: capRed(jewelise(atLum(dn, 1))), spillB: atMax(capRedHue(spillB)) };
}

/** Keep the red share R/(R+G+B) ≤ `max` (margin to the saturated-red flash rule, §4.1) by raising the
 *  larger of G and B (hot pink → magenta-pink, orange-red → orange), so the colour keeps its chroma. */
export function capRedHue(c: THREE.Color, max = 0.74): THREE.Color {
  const r = Math.max(0, c.r), g = Math.max(0, c.g), b = Math.max(0, c.b);
  if (r <= 0 || r / Math.max(1e-9, r + g + b) <= max) return new THREE.Color(r, g, b);
  const need = r / max - r - g - b;                     // how much G+B must grow
  return g >= b ? new THREE.Color(r, g + need, b) : new THREE.Color(r, g, b + need);
}
