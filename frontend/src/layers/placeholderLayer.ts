// Shared implementation of the M3 placeholder layers: one full-screen shader per layer, tinted,
// modulated by state.pulse and the visual intensity, composited with alpha = its layer weight.
// Each layer file (room.ts, neuralField.ts, ...) keeps the Layer interface; later agents replace
// the internals.

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState, WeightKey } from '../state';
import vert from './glsl/placeholder.vert.glsl?raw';
import frag from './glsl/placeholder.frag.glsl?raw';

export interface PlaceholderSpec {
  name: string;
  key: WeightKey;
  mode: number;
  tint: string;
  tint2: string;
}

export class PlaceholderLayer implements Layer<SharedState> {
  readonly name: string;
  protected scene = new THREE.Scene();
  protected camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  protected material: THREE.ShaderMaterial;
  protected mesh: THREE.Mesh;
  protected aspect = 16 / 9;
  private roomTex: THREE.Texture | null = null;
  private roomUrl: string | null = null;

  constructor(protected spec: PlaceholderSpec) {
    this.name = spec.name;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: spec.mode !== 0,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uPulse: { value: 0 }, uIntensity: { value: 0 }, uWeight: { value: 0 },
        uEyes: { value: 0 }, uChallenge: { value: 0 }, uEntity: { value: 0 }, uAspect: { value: this.aspect },
        uLook: { value: new THREE.Vector2() }, uTint: { value: new THREE.Color(spec.tint) },
        uTint2: { value: new THREE.Color(spec.tint2) }, uMode: { value: spec.mode },
        uRoom: { value: null }, uHasRoom: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  init(_renderer: THREE.WebGLRenderer, _state: SharedState): void {
    /* nothing to allocate beyond the constructor */
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
  }

  /** Room image of the session (room layer only). */
  private ensureRoom(state: SharedState): void {
    const img = state.tripScript?.room?.image;
    const url = img && state.assetBase ? state.assetBase + img : null;
    if (url === this.roomUrl) return;
    this.roomUrl = url;
    this.roomTex?.dispose();
    this.roomTex = null;
    this.material.uniforms.uHasRoom.value = 0;
    if (!url) return;
    new THREE.TextureLoader().load(url, (tex) => {
      if (this.roomUrl !== url) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      this.roomTex = tex;
      this.material.uniforms.uRoom.value = tex;
      this.material.uniforms.uHasRoom.value = 1;
    }, undefined, () => { /* default room */ });
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    const w = this.spec.mode === 0 ? 1 : state.layerWeights[this.spec.key];
    if (w < 0.002) return;
    if (this.spec.mode === 0) this.ensureRoom(state);
    const u = this.material.uniforms;
    u.uTime.value = state.wallTime;
    u.uPulse.value = state.pulse;
    u.uIntensity.value = Math.max(0, Math.min(1, state.intensity.visual / 10));
    u.uWeight.value = w;
    u.uEyes.value = state.eyesClosed;
    u.uChallenge.value = state.challenge.level;
    u.uEntity.value = state.entity.present ? state.entity.intensity : 0;
    u.uAspect.value = this.aspect;
    (u.uLook.value as THREE.Vector2).set(state.look.yaw, state.look.pitch);
    const pal = state.palette?.colours;
    if (pal && pal.length >= 2 && this.spec.mode !== 0) {
      // palette tint, kept per layer so each placeholder stays recognisable
      (u.uTint.value as THREE.Color).set(this.spec.tint).lerp(new THREE.Color(pal[this.spec.mode % pal.length]), 0.35);
    }
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.roomTex?.dispose();
  }
}
