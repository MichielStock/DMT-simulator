// Chrysanthemum layer (BUILD.md §11.5): hyperbolic triangle-group tilings in the Poincaré disk by
// reflection folding (glsl/hyperbolic.frag.glsl), warped onto a flower/dome sheet, groups "flickering"
// by crossfade only (GroupScheduler, ≥ 300 ms), animated by a slow Möbius motion whose speed follows
// state.pulse, plus a slowly morphing Kleinian (Maskit) limit set as a lace ring. Everything is driven
// by the shared state (wallTime, pulse, intensity, fieldTexture, palette, challenge, look).

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { deriveSeed } from '../rng';
import {
  GroupScheduler, compose, diskRotation, diskTranslation, maskitParams, sanitiseGroups,
  triangleMirrors, type Cx, type Mat2, type TriangleMirrors,
} from './mobius';
import vert from './glsl/hyperbolic.vert.glsl?raw';
import frag from './glsl/hyperbolic.frag.glsl?raw';

const LUMA = [0.2126, 0.7152, 0.0722];

/** Palette hex colours → linear colours normalised to relative luminance 0.2, no saturated red. */
export function preparePalette(hex: string[] | undefined): THREE.Color[] {
  let src = hex && hex.length ? hex : ['#ffb000', '#4fe3ff', '#ff4fd8', '#7dff6a', '#ffe08a'];
  // planner palettes start with a near-black background colour: skip very dark colours (if enough remain)
  const lumOf = (h: string) => { const c = new THREE.Color(); try { c.set(h); } catch { return 0; } return c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2]; };
  const lit = src.filter((h) => lumOf(h) > 0.012);
  if (lit.length >= 3) src = lit;
  const out: THREE.Color[] = [];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Color();
    try { c.set(src[i % src.length]); } catch { c.set('#888888'); }
    let rgb = [c.r, c.g, c.b];
    const l = Math.max(1e-4, rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]);
    rgb = rgb.map((x) => (x * 0.2) / l);
    // jewel tones: push chroma away from the grey of the same luminance (pale palette entries stay coloured)
    rgb = rgb.map((x) => Math.max(0, 0.2 + (x - 0.2) * 1.4));
    // keep every channel share < 0.75 (so even the hue-rotated challenge colours stay clear of the
    // saturated-red rule R/(R+G+B) ≥ 0.8) by mixing with grey. Channels above 1 are allowed here: the
    // shaders re-normalise to their (darker) target luminance, so saturated hues stay saturated
    // (mixing every out-of-gamut colour with grey at luminance 0.2 made the layers pastel).
    for (let k = 0; k < 30; k++) {
      const sum = rgb[0] + rgb[1] + rgb[2];
      if (Math.max(...rgb) / Math.max(sum, 1e-6) < 0.75) break;
      rgb = rgb.map((x) => 0.2 + (x - 0.2) * 0.85);
    }
    out.push(new THREE.Color(rgb[0], rgb[1], rgb[2]));
  }
  return out;
}

interface TriUniforms { tri: THREE.Vector4; cen: THREE.Vector2; meta: THREE.Vector4 }

function triUniforms(t: TriangleMirrors, into: TriUniforms): void {
  const inr = Math.hypot(t.centre[0], t.centre[1]) - t.radius;          // A to the polygon edge (euclidean)
  const lambda = 2 * 2 * Math.atanh(Math.min(0.999, inr));               // polygon diameter (hyperbolic)
  into.tri.set(t.wedge, t.n2[0], t.n2[1], t.radius);
  into.cen.set(t.centre[0], t.centre[1]);
  into.meta.set(inr, lambda, t.p, 0);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class HyperbolicLayer implements Layer<SharedState> {
  readonly name = 'chrysanthemum';
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private groups: [number, number, number][] = [];
  private tris: TriangleMirrors[] = [];
  private scheduler: GroupScheduler | null = null;
  private scriptKey: unknown = undefined;
  private lastWall: number | null = null;
  private lastModel: number | null = null;
  private theta = 0;      // Möbius rotation phase (rad)
  private tau = 0;        // translation path phase
  private omega = 0;      // current rotation speed (rad/s), smoothed
  private klein = { height: 1.97, shift: 0 };
  private paletteKey = '';
  private shownFrom = -1;
  private shownTo = -1;

  constructor() {
    const v4 = () => new THREE.Vector4();
    const pal = preparePalette(undefined);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uWeight: { value: 0 }, uTime: { value: 0 },
        uPulse: { value: 0 }, uIntensity: { value: 0 }, uChallenge: { value: 0 }, uLook: { value: new THREE.Vector2() },
        uTriA: { value: v4() }, uCenA: { value: new THREE.Vector2() }, uMetaA: { value: v4() },
        uTriB: { value: v4() }, uCenB: { value: new THREE.Vector2() }, uMetaB: { value: v4() },
        uMix: { value: 0 },
        uMobAB: { value: v4() }, uMobCD: { value: v4() }, uMobAB2: { value: v4() }, uMobCD2: { value: v4() },
        uZoom: { value: 1.4 }, uPetals: { value: 14 },
        uPal: { value: pal }, uMean: { value: new THREE.Color(0.5, 0.5, 0.5) },
        uField: { value: null }, uHasField: { value: 0 },
        uKlein: { value: new THREE.Vector2(1.97, 0) }, uLaceRot: { value: 0 }, uLaceN: { value: 14 }, uLace: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  init(_renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.configure(state);
  }

  resize(w: number, h: number): void {
    (this.material.uniforms.uRes.value as THREE.Vector2).set(Math.max(1, w), Math.max(1, h));
  }

  /** (Re)read the trip script: groups, Kleinian traces, seed. */
  private configure(state: SharedState): void {
    const script = state.tripScript;
    if (this.scriptKey === script && this.scheduler) return;
    this.scriptKey = script;
    const ch = (script?.layers as Record<string, any> | undefined)?.chrysanthemum;
    this.groups = sanitiseGroups(ch?.groups);
    this.tris = this.groups.map(([p, q, r]) => triangleMirrors(p, q, r));
    const seed = deriveSeed(state.seed >>> 0, 'chrysanthemum');
    this.scheduler = new GroupScheduler(this.tris.length, seed);
    const ta = Array.isArray(ch?.kleinian?.trace_a) ? (ch.kleinian.trace_a as Cx) : ([2.0, 0.05] as Cx);
    const tb = Array.isArray(ch?.kleinian?.trace_b) ? (ch.kleinian.trace_b as Cx) : ([2.0, 0.1] as Cx);
    this.klein = maskitParams([Number(ta[0]), Number(ta[1])], [Number(tb[0]), Number(tb[1])]);
    this.material.uniforms.uPetals.value = 2 * this.tris[0].p;
    this.shownFrom = this.shownTo = -1;
    // start at a seeded phase so two seeds do not look identical
    this.theta = ((seed % 1000) / 1000) * 2 * Math.PI;
    this.tau = ((seed >>> 10) % 1000) / 10;
  }

  private setPalette(state: SharedState): void {
    const key = (state.palette?.colours ?? []).join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const pal = preparePalette(state.palette?.colours);
    this.material.uniforms.uPal.value = pal;
    const mean = new THREE.Color(0, 0, 0);
    for (const c of pal) mean.add(c);
    mean.multiplyScalar(1 / pal.length);
    (this.material.uniforms.uMean.value as THREE.Color).copy(mean);
  }

  /** Möbius motion at phases (θ, τ): rotate about the centre, then a small wandering translation. */
  private motion(theta: number, tau: number): Mat2 {
    const r = 0.16 * (0.6 + 0.4 * Math.sin(0.31 * tau));
    const a: Cx = [r * Math.cos(0.17 * tau + 1.3), r * Math.sin(0.23 * tau)];
    return compose(diskTranslation(a), diskRotation(theta));
  }

  private advance(state: SharedState): void {
    const wall = state.wallTime;
    const dtWall = this.lastWall === null ? 0 : Math.max(0, Math.min(0.1, wall - this.lastWall));
    this.lastWall = wall;
    const dtModel = this.lastModel === null ? 0 : Math.max(0, (state.t_min - this.lastModel) * 60);
    this.lastModel = state.t_min;
    const v = state.intensity.visual;
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    // speed follows the pulse (≤ 0.5 Hz oscillator) and the intensity; the challenge speeds it up
    const target = 0.055 * (0.6 + 0.6 * Math.min(1, v / 9)) * (1 + 0.7 * state.pulse) * (1 + 1.0 * ch);
    this.omega += (target - this.omega) * Math.min(1, dtWall * 2);
    this.theta = (this.theta + this.omega * dtWall) % (2 * Math.PI * 1000);
    this.tau += this.omega * dtWall * 3;
    const st = this.scheduler!.update(Math.min(dtModel, 5), dtWall, ch);
    const u = this.material.uniforms;
    if (st.from !== this.shownFrom || st.to !== this.shownTo) {
      this.shownFrom = st.from; this.shownTo = st.to;
      triUniforms(this.tris[st.from], { tri: u.uTriA.value, cen: u.uCenA.value, meta: u.uMetaA.value });
      triUniforms(this.tris[st.to], { tri: u.uTriB.value, cen: u.uCenB.value, meta: u.uMetaB.value });
    }
    u.uMix.value = st.from === st.to ? 0 : st.mix;
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    this.configure(state);
    this.advance(state);
    const w = state.layerWeights.chrysanthemum;
    if (w < 0.002) return;
    this.setPalette(state);
    const u = this.material.uniforms;
    const v = state.intensity.visual;
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    u.uWeight.value = w;
    u.uTime.value = state.wallTime;
    u.uPulse.value = state.pulse;
    u.uIntensity.value = Math.max(0, Math.min(1, v / 10));
    u.uChallenge.value = ch;
    (u.uLook.value as THREE.Vector2).set(state.look.yaw, -state.look.pitch);

    const m = this.motion(this.theta, this.tau);
    const m2 = this.motion(this.theta + this.omega * 0.25, this.tau + this.omega * 0.75);
    (u.uMobAB.value as THREE.Vector4).set(m[0][0], m[0][1], m[1][0], m[1][1]);
    (u.uMobCD.value as THREE.Vector4).set(m[2][0], m[2][1], m[3][0], m[3][1]);
    (u.uMobAB2.value as THREE.Vector4).set(m2[0][0], m2[0][1], m2[1][0], m2[1][1]);
    (u.uMobCD2.value as THREE.Vector4).set(m2[2][0], m2[2][1], m2[3][0], m2[3][1]);

    // the sheet tightens (more, smaller tiles) with intensity and in a difficult passage
    u.uZoom.value = 1.25 + 0.3 * smooth(4.5, 9, v) + 0.35 * ch;

    // Kleinian lace: trace parameters morph slowly (periods 43 s and 61 s, ≥ 30 s)
    const t = state.wallTime;
    const height = Math.min(2.0, Math.max(1.92, this.klein.height + 0.022 * Math.sin((2 * Math.PI * t) / 43) - 0.02 * ch));
    const shift = Math.max(-0.2, Math.min(0.2, this.klein.shift + 0.06 * Math.sin((2 * Math.PI * t) / 61 + 1.1)));
    (u.uKlein.value as THREE.Vector2).set(height, shift);
    u.uLaceRot.value = -0.35 * this.theta;
    u.uLace.value = 0.2 + 0.8 * smooth(5.0, 8.5, v);

    const tex = state.fieldTexture;
    if (tex && (tex as THREE.Texture).isTexture) {
      u.uField.value = tex as THREE.Texture;
      u.uHasField.value = 1;
    } else {
      u.uField.value = null;
      u.uHasField.value = 0;
    }
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Diagnostics for tests: current groups and crossfade. */
  get debugInfo(): { groups: [number, number, number][]; from: number; to: number; mix: number; omega: number } {
    const st = this.scheduler?.state ?? { from: 0, to: 0, mix: 0 };
    return { groups: this.groups, from: st.from, to: st.to, mix: st.mix, omega: this.omega };
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

export function createHyperbolicLayer(): HyperbolicLayer {
  return new HyperbolicLayer();
}
