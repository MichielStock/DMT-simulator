// Room layer (BUILD.md 11.3, 8.1). The first, opaque layer of the scene target (NOTES.md S4).
//
//   photo     → depth-displaced plane, parallax from the (comfort-clamped) mouse look
//   panorama  → depth-displaced inward-facing sphere (2:1 equirectangular, else shown as a photo)
//   no image  → the built-in procedural interior, baked once into colour + depth textures and drawn
//               through the same displaced-mesh path
//
// Distortions follow the coupling rule (11.1): everything is driven by state.fieldTexture (or a slow
// procedural stand-in until the neural field exists), state.pulse, the visual intensity, the hysteretic
// room-distortion amount, state.challenge and state.eyesClosed; time comes only from state.wallTime.
// Passes: mesh → roomRT; tracer feedback (roomRT + previous) → history; final (eyes-closed field, layer
// weight) → the scene target. Safety at source: all modulations ≤ 0.5 Hz (ROOM_FREQS), no luminance
// modulation over time, tracer feedback decays within 0.5 s, eyes-closed field is dim.

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { computeLayerWeights, type LayerWeights } from '../layerWeights';
import { NOISE_GLSL } from './noise';
import fieldSample from './glsl/fieldSample.glsl?raw';
import {
  CAMERA_FOV_DEG, DRIFT_SPEED, DRIFT_TAU_S, PLANE_DEPTH, SPHERE_DEPTH, ROOM_FREQS, buildPlaneGeometry, buildSphereGeometry, cameraPose,
  coverFit, roomEffects, vividColours, selectRoomGeometry, smoothstep, tracerFeedback, wallpaperForSeed,
  type DepthMapping, type RoomGeometryKind,
} from './roomGeometry';
import quadVert from './glsl/roomQuad.vert.glsl?raw';
import defaultFrag from './glsl/roomDefault.frag.glsl?raw';
import meshVert from './glsl/roomMesh.vert.glsl?raw';
import meshFrag from './glsl/roomMesh.frag.glsl?raw';
import tracerFrag from './glsl/roomTracer.frag.glsl?raw';
import finalFrag from './glsl/roomFinal.frag.glsl?raw';
import flowFrag from './glsl/roomFlow.frag.glsl?raw';

const BAKE_W = 1600;
const BAKE_H = 1000;
const SPHERE_RADIUS = 10;
const FADE_IN_S = 0.8;
const FLOW_SIZE = 512;

function rt(w: number, h: number, depth: boolean, mips = false): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: mips,
  });
}

function quadMaterial(frag: string, uniforms: Record<string, THREE.IUniform>, prefix = ''): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: quadVert, fragmentShader: prefix + frag, uniforms,
    depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
  });
}

export class RoomLayer implements Layer<SharedState> {
  readonly name = 'room';
  /** Which geometry is in use (tests / diagnostics). */
  kind: RoomGeometryKind = 'procedural';

  private w = 1;
  private h = 1;
  private camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, 0.02, 100);
  private meshScene = new THREE.Scene();
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private mesh: THREE.Mesh | null = null;
  private meshMat: THREE.ShaderMaterial;
  private tracerMat: THREE.ShaderMaterial;
  private flowMat: THREE.ShaderMaterial;
  private flow: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private flowValid = false;
  private finalMat: THREE.ShaderMaterial;
  private roomRT: THREE.WebGLRenderTarget | null = null;
  private hist: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private histValid = false;
  private bakeColour: THREE.WebGLRenderTarget | null = null;
  private bakeDepth: THREE.WebGLRenderTarget | null = null;
  private imageTex: THREE.Texture | null = null;
  private depthTex: THREE.Texture | null = null;
  private imgAspect = BAKE_W / BAKE_H;
  private sourceKey: string | null = null;
  private ready = false;
  private fade = 0;
  private loadToken = 0;

  private lastWall = NaN;
  private fxTime = 0;
  private tileOrigin = new THREE.Vector2(0.13, 0.07);
  private lastLook = { yaw: 0, pitch: 0 };
  private lookSpeed = 0;
  private ownWeights: LayerWeights | null = null;
  private distortion = 0;

  constructor() {
    const u = (v: unknown) => ({ value: v });
    this.meshMat = new THREE.ShaderMaterial({
      vertexShader: NOISE_GLSL + meshVert,
      fragmentShader: NOISE_GLSL + fieldSample + '\n' + meshFrag,
      side: THREE.DoubleSide,
      uniforms: {
        uDepth: u(null), uHasDepth: u(0), uDepthAmt: u(PLANE_DEPTH.amount), uDepthPivot: u(PLANE_DEPTH.pivot),
        uDepthGamma: u(PLANE_DEPTH.gamma), uDepthLod: u(2.5), uEdgeFade: u(PLANE_DEPTH.edgeFade), uKind: u(0),
        uFxTime: u(0), uBreathe: u(0), uBreathScale: u(0.04), uPulse: u(0), uBreathHz: u(ROOM_FREQS.breathNoise),
        uImage: u(null), uImgAspect: u(this.imgAspect), uWarp: u(0), uDrift: u(0), uFlow: u(null),
        uTile: u(0), uTileScale: u(0.12), uTileOrigin: u(this.tileOrigin), uGroup: u(0),
        uSat: u(1), uHue: u(0), uHueHz: u(ROOM_FREQS.hueWander), uPalette: u(0), uPalTint: u(new THREE.Vector3(1, 0.7, 0.3)),
        uChallenge: u(0), uField: u(null), uHasField: u(0),
        uMaskHz: u(ROOM_FREQS.driftField), uResolution: u(new THREE.Vector2(1, 1)), uViewAspect: u(16 / 9),
      },
    });
    this.tracerMat = quadMaterial(tracerFrag, { uCur: u(null), uPrev: u(null), uFeedback: u(0) });
    this.flowMat = quadMaterial(flowFrag, {
      uPrev: u(null), uDt: u(0), uTau: u(DRIFT_TAU_S), uFxTime: u(0), uDriftField: u(ROOM_FREQS.driftField),
      uImgAspect: u(this.imgAspect), uAmp: u(DRIFT_SPEED), uScale: u(1.5), uReset: u(1),
    }, NOISE_GLSL);
    this.finalMat = quadMaterial(finalFrag, {
      uRoom: u(null), uEyes: u(0), uWeight: u(1), uFade: u(0), uField: u(null), uHasField: u(0), uFxTime: u(0), uPhosHz: u(ROOM_FREQS.phosphene),
      uViewAspect: u(16 / 9), uPhos: u(0), uPulse: u(0),
      uPalA: u(new THREE.Vector3(1, 0.7, 0)), uPalB: u(new THREE.Vector3(0.1, 0.8, 1)), uPalC: u(new THREE.Vector3(1, 0.1, 0.8)),
    }, NOISE_GLSL + fieldSample + '\n');
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.finalMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  init(renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.flow = [rt(FLOW_SIZE, FLOW_SIZE, false), rt(FLOW_SIZE, FLOW_SIZE, false)];
    this.bakeProcedural(renderer);
    this.ensureSource(state);
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    if (!this.roomRT) {
      this.roomRT = rt(this.w, this.h, true);
      this.hist = [rt(this.w, this.h, false), rt(this.w, this.h, false)];
    } else {
      this.roomRT.setSize(this.w, this.h);
      this.hist![0].setSize(this.w, this.h);
      this.hist![1].setSize(this.w, this.h);
    }
    this.histValid = false;
    if (this.mesh && this.kind !== 'sphere') this.rebuildPlane();
  }

  // ------------------------------------------------------------------ sources

  /** Bake the procedural interior (colour + depth) once. */
  private bakeProcedural(renderer: THREE.WebGLRenderer): void {
    if (this.bakeColour) return;
    this.bakeColour = rt(BAKE_W, BAKE_H, false, true);   // mips: local means for the contrast cap
    this.bakeDepth = rt(BAKE_W, BAKE_H, false);
    for (const t of [this.bakeColour, this.bakeDepth]) {
      t.texture.wrapS = t.texture.wrapT = THREE.MirroredRepeatWrapping;
    }
    const mat = quadMaterial(defaultFrag, { uOut: { value: 0 }, uAspect: { value: BAKE_W / BAKE_H } });
    const prevTarget = renderer.getRenderTarget();
    this.quad.material = mat;
    renderer.setRenderTarget(this.bakeColour);
    renderer.render(this.quadScene, this.quadCam);
    mat.uniforms.uOut.value = 1;
    renderer.setRenderTarget(this.bakeDepth);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prevTarget);
    this.quad.material = this.finalMat;
    mat.dispose();
  }

  private useProcedural(): void {
    this.disposeImages();
    this.kind = 'procedural';
    this.imgAspect = BAKE_W / BAKE_H;
    this.setMesh('procedural');
    const u = this.meshMat.uniforms;
    u.uImage.value = this.bakeColour!.texture;
    u.uDepth.value = this.bakeDepth!.texture;
    u.uHasDepth.value = 1;
    u.uDepthLod.value = 0;     // the bake has no mips; it is smooth already
    this.ready = true;
  }

  private ensureSource(state: SharedState): void {
    const room = state.tripScript?.room;
    const base = state.assetBase;
    const imgUrl = room?.image && base ? base + room.image : null;
    const depthUrl = room?.depth && base ? base + room.depth : null;
    const key = `${room?.source ?? 'default'}|${imgUrl ?? ''}|${depthUrl ?? ''}`;
    if (key === this.sourceKey) return;
    this.sourceKey = key;
    const token = ++this.loadToken;
    if (!imgUrl) { this.useProcedural(); return; }
    this.ready = false;
    this.fade = 0;
    const loader = new THREE.TextureLoader();
    const fail = () => { if (token === this.loadToken) this.useProcedural(); };
    loader.load(imgUrl, (tex) => {
      if (token !== this.loadToken) { tex.dispose(); return; }
      const im = tex.image as { width: number; height: number };
      const kind = selectRoomGeometry(room?.source, true, im.width, im.height);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = kind === 'sphere' ? THREE.RepeatWrapping : THREE.MirroredRepeatWrapping;
      tex.wrapT = THREE.MirroredRepeatWrapping;
      tex.needsUpdate = true;
      const finish = (depth: THREE.Texture | null) => {
        if (token !== this.loadToken) { tex.dispose(); depth?.dispose(); return; }
        this.disposeImages();
        this.imageTex = tex;
        this.depthTex = depth;
        this.kind = kind;
        this.imgAspect = kind === 'sphere' ? 2 : im.width / Math.max(1, im.height);
        this.setMesh(kind);
        const u = this.meshMat.uniforms;
        u.uImage.value = tex;
        u.uDepth.value = depth;
        u.uHasDepth.value = depth ? 1 : 0;
        u.uDepthLod.value = depth ? Math.max(1.5, Math.log2(Math.max((depth.image as { width: number }).width, 1) / 160)) : 0;
        this.ready = true;
      };
      if (!depthUrl) { finish(null); return; }
      loader.load(depthUrl, (d) => {
        d.colorSpace = THREE.NoColorSpace;
        d.wrapS = kind === 'sphere' ? THREE.RepeatWrapping : THREE.MirroredRepeatWrapping;
        d.wrapT = THREE.MirroredRepeatWrapping;
        d.minFilter = THREE.LinearMipmapLinearFilter;
        d.generateMipmaps = true;
        d.needsUpdate = true;
        finish(d);
      }, undefined, () => finish(null));
    }, undefined, fail);
  }

  private setMesh(kind: RoomGeometryKind): void {
    if (this.mesh) { this.meshScene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    const m: DepthMapping = kind === 'sphere' ? SPHERE_DEPTH : PLANE_DEPTH;
    const u = this.meshMat.uniforms;
    u.uKind.value = kind === 'sphere' ? 1 : 0;
    u.uDepthAmt.value = m.amount;
    u.uDepthPivot.value = m.pivot;
    u.uDepthGamma.value = m.gamma;
    u.uEdgeFade.value = m.edgeFade;
    u.uBreathScale.value = kind === 'sphere' ? SPHERE_RADIUS * 0.035 : 0.04;
    u.uImgAspect.value = this.imgAspect;
    const geo = kind === 'sphere' ? buildSphereGeometry(SPHERE_RADIUS) : this.planeGeometry();
    this.mesh = new THREE.Mesh(geo, this.meshMat);
    this.mesh.frustumCulled = false;
    this.meshScene.add(this.mesh);
    this.histValid = false;
    this.flowValid = false;
    if (this.flow) for (const t of this.flow) t.texture.wrapS = kind === 'sphere' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  }

  private planeGeometry(): THREE.BufferGeometry {
    const { width, height } = coverFit(this.imgAspect, this.w / this.h);
    return buildPlaneGeometry(width, height, 256, Math.max(96, Math.round(256 / Math.max(0.5, this.imgAspect))));
  }

  private rebuildPlane(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.planeGeometry();
  }

  private disposeImages(): void {
    this.imageTex?.dispose();
    this.depthTex?.dispose();
    this.imageTex = null;
    this.depthTex = null;
  }

  // ------------------------------------------------------------------ per frame

  /** Room distortion amount (0–1): state.layerWeights.roomDistortion when main.ts provides it, else the
   *  same hysteretic window computed locally from the visual intensity. */
  private distortionAmount(state: SharedState, dt: number): number {
    const provided = (state.layerWeights as unknown as { roomDistortion?: number }).roomDistortion;
    this.ownWeights = computeLayerWeights(state.intensity.visual, this.ownWeights);
    if (typeof provided === 'number' && Number.isFinite(provided)) return provided;
    const target = this.ownWeights.roomDistortion;
    const step = dt / 0.3;
    this.distortion += Math.max(-step, Math.min(step, target - this.distortion));
    return this.distortion;
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    this.ensureSource(state);
    const wall = state.wallTime;
    const dt = Number.isFinite(this.lastWall) ? Math.min(0.1, Math.max(0, wall - this.lastWall)) : 0;
    this.lastWall = wall;
    const weight = Math.max(0, Math.min(1, state.layerWeights.room));
    const v = state.intensity.visual;
    const challenge = state.challenge?.active ? Math.max(0, Math.min(1, state.challenge.level)) : 0;
    const dist = this.distortionAmount(state, dt);
    const fx = roomEffects(v, dist, challenge);
    // debug/gallery only: window.__roomFx = { drift: 0, ... } overrides individual effect amounts
    const ovr = (globalThis as { __roomFx?: Partial<typeof fx> }).__roomFx;
    if (ovr) Object.assign(fx, ovr);
    this.fxTime += dt * fx.speed;
    if (this.ready) this.fade = Math.min(1, this.fade + dt / FADE_IN_S);

    // look speed (rad/s), for the tracers
    const dl = Math.hypot(state.look.yaw - this.lastLook.yaw, state.look.pitch - this.lastLook.pitch);
    this.lastLook = { yaw: state.look.yaw, pitch: state.look.pitch };
    const inst = dt > 0 ? dl / dt : 0;
    this.lookSpeed += (inst - this.lookSpeed) * (dt > 0 ? 1 - Math.exp(-dt / 0.08) : 0);

    if (weight < 0.002 || !this.mesh || !this.roomRT || !this.hist) { this.histValid = false; return; }

    // tile lattice crawls at constant (slow) velocity
    this.tileOrigin.x += dt * fx.speed * ROOM_FREQS.tileCrawl * fx.tileScale;
    this.tileOrigin.y += dt * fx.speed * ROOM_FREQS.tileCrawl * fx.tileScale * 0.6;

    const field = state.fieldTexture instanceof THREE.Texture ? state.fieldTexture : null;
    const vivid = vividColours(state.palette?.colours);

    // ---- camera (user-initiated look only; comfort clamp already applied in main.ts) ----
    const pose = cameraPose(this.kind, state.look.yaw, state.look.pitch);
    this.camera.position.set(pose.x, pose.y, 0);
    this.camera.rotation.set(pose.pitch, -pose.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();

    // ---- drift: advect the texture-coordinate offsets ----
    if (this.flow) {
      const fl = this.flowMat.uniforms;
      fl.uPrev.value = this.flow[1].texture;
      fl.uDt.value = dt * fx.speed;
      fl.uFxTime.value = this.fxTime;
      fl.uImgAspect.value = this.imgAspect;
      fl.uScale.value = this.kind === 'sphere' ? 3.75 : 1.5;
      fl.uReset.value = this.flowValid ? 0 : 1;
      this.quad.material = this.flowMat;
      renderer.setRenderTarget(this.flow[0]);
      renderer.render(this.quadScene, this.quadCam);
      this.flow = [this.flow[1], this.flow[0]];
      this.flowValid = true;
    }

    // ---- mesh pass ----
    const u = this.meshMat.uniforms;
    u.uFlow.value = this.flow ? this.flow[1].texture : null;
    u.uFxTime.value = this.fxTime;
    u.uPulse.value = state.pulse;
    u.uBreathe.value = fx.breathe;
    u.uWarp.value = fx.warp;
    u.uDrift.value = fx.drift;
    u.uTile.value = fx.tile;
    u.uTileScale.value = fx.tileScale;
    u.uGroup.value = wallpaperForSeed(state.seed).id;
    u.uSat.value = fx.sat;
    u.uHue.value = fx.hue;
    u.uPalette.value = fx.palette;
    (u.uPalTint.value as THREE.Vector3).set(...vivid[0]);
    u.uChallenge.value = challenge;
    u.uField.value = field;
    u.uHasField.value = field ? 1 : 0;
    (u.uResolution.value as THREE.Vector2).set(this.w, this.h);
    u.uViewAspect.value = this.w / this.h;
    u.uImgAspect.value = this.imgAspect;
    renderer.setRenderTarget(this.roomRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(this.meshScene, this.camera);

    // ---- tracers ----
    const [cur, prev] = this.hist;
    this.tracerMat.uniforms.uCur.value = this.roomRT.texture;
    this.tracerMat.uniforms.uPrev.value = prev.texture;
    this.tracerMat.uniforms.uFeedback.value = this.histValid ? tracerFeedback(this.lookSpeed, fx.tracer, dt) : 0;
    this.quad.material = this.tracerMat;
    renderer.setRenderTarget(cur);
    renderer.render(this.quadScene, this.quadCam);
    this.histValid = true;

    // ---- final: eyes-closed field + weight → scene target ----
    const f = this.finalMat.uniforms;
    f.uRoom.value = cur.texture;
    f.uEyes.value = Math.max(0, Math.min(1, state.eyesClosed));
    f.uWeight.value = weight;
    f.uFade.value = this.fade;
    f.uField.value = field;
    f.uHasField.value = field ? 1 : 0;
    f.uFxTime.value = this.fxTime;
    f.uViewAspect.value = this.w / this.h;
    f.uPhos.value = smoothstep(0.3, 4.5, v);
    f.uPulse.value = state.pulse;
    (f.uPalA.value as THREE.Vector3).set(...vivid[0]);
    (f.uPalB.value as THREE.Vector3).set(...vivid[1]);
    (f.uPalC.value as THREE.Vector3).set(...vivid[2]);
    this.quad.material = this.finalMat;
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCam);
    this.hist = [prev, cur];
  }

  dispose(): void {
    this.disposeImages();
    this.mesh?.geometry.dispose();
    this.meshMat.dispose();
    this.tracerMat.dispose();
    this.flowMat.dispose();
    this.flow?.forEach((t) => t.dispose());
    this.finalMat.dispose();
    this.quad.geometry.dispose();
    this.roomRT?.dispose();
    this.hist?.forEach((t) => t.dispose());
    this.bakeColour?.dispose();
    this.bakeDepth?.dispose();
  }
}

export function createRoomLayer(): RoomLayer {
  return new RoomLayer();
}
