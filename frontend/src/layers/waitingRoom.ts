// Waiting room (BUILD.md §11.6): ray-marched kaleidoscopic fractal interior (glsl/waitingRoom.frag.glsl):
// kind "kifs" = kaleidoscopic IFS, "mandelbox" = Mandelbox (tripScript.layers.waiting_room.kind). Slow
// constant-velocity drift along a carved nave with a stable horizon (§4.5), palette-tinted fog and
// ambient occlusion, fieldTexture-modulated surfaces, pulse-driven glow. Quality knob: `quality`
// (0.5–1) scales the ray-march step budget and the internal resolution.

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { deriveSeed } from '../rng';
import { preparePalette } from './hyperbolic';
import vert from './glsl/hyperbolic.vert.glsl?raw';
import frag from './glsl/waitingRoom.frag.glsl?raw';

const BLIT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }
`;

/** Per-kind drift: units per second along +z (cells are 2 units (kifs) / 16 units (mandelbox) long). */
const KINDS = {
  kifs: { id: 0, speed: 0.12, far: 14, path: [0, 0] },
  mandelbox: { id: 1, speed: 0.4, far: 40, path: [2.5, 2.5] },   // a hall between the Mandelbox blocks
} as const;

export class WaitingRoomLayer implements Layer<SharedState> {
  readonly name = 'waiting_room';
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private blitScene = new THREE.Scene();
  private blitMat: THREE.ShaderMaterial;
  private rt: THREE.WebGLRenderTarget | null = null;
  private w = 1;
  private h = 1;
  private kind: keyof typeof KINDS = 'kifs';
  zOffset = 0;
  private scriptKey: unknown = undefined;
  private paletteKey = '';
  /** 0.5–1: ray-march steps 64 + 64·q; internal resolution q (rendered at the pipeline scale × q). */
  quality = 1;
  /** Debug/tuning: override the drift line (x, y) and the start offset along it. */
  pathOverride: [number, number] | null = null;

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
        uFar: { value: 14 }, uPal: { value: preparePalette(undefined) }, uFog: { value: new THREE.Color(0.2, 0.2, 0.2) },
        uField: { value: null }, uHasField: { value: 0 },
      },
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    q.frustumCulled = false;
    this.scene.add(q);
    this.blitMat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: BLIT_FRAG, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { uTex: { value: null } },
    });
    const b = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
    b.frustumCulled = false;
    this.blitScene.add(b);
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
    // fog: the palette's coolest colour (highest blue share), softened towards the palette mean
    const fog = new THREE.Color(0, 0, 0);
    for (const c of pal) fog.add(c);
    fog.multiplyScalar(1 / pal.length);
    const cool = pal.reduce((a, c) => (c.b / (c.r + c.g + c.b + 1e-6) > a.b / (a.r + a.g + a.b + 1e-6) ? c : a), pal[0]);
    fog.lerp(cool, 0.85);
    // saturate the fog (it is the colour of depth, not a grey veil)
    const fl = 0.2126 * fog.r + 0.7152 * fog.g + 0.0722 * fog.b;
    fog.setRGB(Math.max(0, fl + (fog.r - fl) * 1.6), Math.max(0, fl + (fog.g - fl) * 1.6), Math.max(0, fl + (fog.b - fl) * 1.6));
    (this.material.uniforms.uFog.value as THREE.Color).copy(fog);
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
    u.uFar.value = spec.far;
    u.uSteps.value = Math.round(64 + 64 * q);
    // slow morph of the fold geometry (period ≈ 52 s)
    u.uMorph.value = (2 * Math.PI * state.wallTime) / 52;
    const tex = state.fieldTexture;
    if (tex && (tex as THREE.Texture).isTexture) { u.uField.value = tex; u.uHasField.value = 1; }
    else { u.uField.value = null; u.uHasField.value = 0; }

    if (q >= 0.999) {
      (u.uRes.value as THREE.Vector2).set(this.w, this.h);
      renderer.setRenderTarget(target);
      renderer.render(this.scene, this.camera);
      return;
    }
    // reduced internal resolution: render opaque into a smaller target, then blend it in
    const rw = Math.max(1, Math.round(this.w * q));
    const rh = Math.max(1, Math.round(this.h * q));
    if (!this.rt || this.rt.width !== rw || this.rt.height !== rh) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(rw, rh, {
        type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
    }
    (u.uRes.value as THREE.Vector2).set(rw, rh);
    const prevTransparent = this.material.transparent;
    this.material.transparent = false;
    this.material.blending = THREE.NoBlending;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    this.material.transparent = prevTransparent;
    this.material.blending = THREE.NormalBlending;
    this.blitMat.uniforms.uTex.value = this.rt.texture;
    renderer.setRenderTarget(target);
    renderer.render(this.blitScene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.blitMat.dispose();
    this.rt?.dispose();
  }
}

export function createWaitingRoomLayer(): WaitingRoomLayer {
  return new WaitingRoomLayer();
}
