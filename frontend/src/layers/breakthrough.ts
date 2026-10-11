// Breakthrough world and entities (BUILD.md 11.7 steps 1-6, docs/VISUAL_DIRECTION.md 3): "generated
// worlds, framed". The session's SDXL panoramas (breakthrough.world.images, 2048x1024 equirect, sRGB)
// are the surrounding world, seen through a glowing procedural mandala frame that opens as the veil
// lifts; beings stand in front as depth-placed billboards with kaleidoscopic echoes, morphing between
// their three variants; the glyph message streams from them as rotating rings of a seeded alphabet.
// Procedural fallback (world.procedural or a failed image): an emissive lattice dome with lanterns.
// All shading in glsl/breakthrough.frag.glsl (one full-screen pass, alpha = layer weight); the timing
// arithmetic (schedules, caps) lives in breakthroughMath.ts. Reads the shared state only, defensively
// (optional fields: entity.variant/morph/depth/position, message.present/intensity/glyphSeed,
// interaction.keyPulse/lookVel).

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { deriveSeed } from '../rng';
import { preparePalette } from './hyperbolic';
import { ATLAS_COLS, glyphAtlasCanvas, glyphBeingCanvas, makeAlphabet } from './glyphs';
import {
  DRIFT_YAW_DEG_S, MEMBRANE_CELLS, MORPH_PERIOD_S, aperture, behaviourLook, echoCount, follow, frameFold, frameLuminance,
  frameRotationRev, messageEnvelope, morphFromPhase, ringCount, ringRotationRev, smoothstep, veilProgress, worldSchedule,
} from './breakthroughMath';
import vert from './glsl/hyperbolic.vert.glsl?raw';
import frag from './glsl/breakthrough.frag.glsl?raw';

const LUMA = [0.2126, 0.7152, 0.0722];

interface LooseEntity {
  present?: boolean; index?: number; behaviour?: string | null; intensity?: number;
  variant?: number; morph?: number; depth?: number; position?: [number, number] | { x: number; y: number };
}
interface LooseMessage { present?: boolean; active?: boolean; intensity?: number; glyphSeed?: number; t?: number }

function hue01(c: THREE.Color): THREE.Color {
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  return new THREE.Color(c.r / m, c.g / m, c.b / m);
}
function chroma(c: THREE.Color): number {
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  return (m - Math.min(c.r, c.g, c.b)) / m;
}
function lumOf(c: THREE.Color): number {
  return c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
}
/** keep the red share under 0.75 (margin to the 0.8 red-flash rule) by raising blue / green */
/** jewel chroma: pull the smallest channel down to ~10 % of the largest (pale entries become pure hues) */
function jewel(c: THREE.Color): THREE.Color {
  const h = hue01(c);
  const m = Math.min(h.r, h.g, h.b);
  const k = Math.min(0.9, m) ;
  const out = new THREE.Color(Math.max(0, h.r - k * 0.9 * (h.r > m ? 1 : 1)), Math.max(0, h.g - k * 0.9), Math.max(0, h.b - k * 0.9));
  return hue01(new THREE.Color(out.r + 0.06, out.g + 0.06, out.b + 0.06));
}
function capRed(c: THREE.Color): THREE.Color {
  for (let i = 0; i < 20; i++) {
    const s = c.r + c.g + c.b;
    if (c.r / Math.max(1e-4, s) < 0.72) break;
    c.b += 0.05; c.g += 0.03;
  }
  return hue01(c);
}

export class BreakthroughLayer implements Layer<SharedState> {
  readonly name = 'breakthrough';
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private w = 1;
  private h = 1;
  private pending = 0;

  // world
  private worldKey = '';
  private worlds: (THREE.Texture | null)[] = [];
  private worldFailed: boolean[] = [];
  private procedural = true;
  private worldStart = -1;
  // entity sprites per entity index (3 variants)
  private entKey = '';
  private entTex: THREE.Texture[] = [];
  private entOwned: THREE.Texture[] = [];
  // glyph atlas
  private atlasSeed = -1;
  private atlas: THREE.Texture | null = null;
  private glyphCount = 24;
  // palette
  private paletteKey = '';
  private fold = 9;
  private seed = 0;
  // time state
  private lastWall = -1;
  private latched = false;
  private latchStart = -1;
  private yaw = 0;
  private bandRot = new Float32Array(8);
  // membrane flow (cells) / rotation (rad) and the being's sway phase: INTEGRATED, never time x rate (a
  // rate that changes with the challenge level would otherwise sweep the phase at many Hz)
  private memFlow = 0;
  private memRot = 0;
  private swayPhase = 0;
  private ringRot = new Float32Array(4);
  private morphPhase = 0;
  private behaviour: string | null = null;
  private behaviourStart = 0;
  private msgOn = false;
  private msgStart = 0;
  private entPulse = 0;
  private lookVel = 0;
  private lastLook: [number, number] | null = null;
  private ent = 0;
  private stern = 0;
  private dbgLog = false;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uWeight: { value: 0 }, uTime: { value: 0 }, uVI: { value: 0 },
        uVeil: { value: 0 }, uAperture: { value: 0 }, uDim: { value: 1 }, uLook: { value: new THREE.Vector2() },
        uCamOff: { value: new THREE.Vector3() },
        uWorldA: { value: null }, uWorldB: { value: null }, uMix: { value: 0 }, uHasWorld: { value: 0 },
        uWorldLod: { value: new THREE.Vector2(11, 11) },
        uPal: { value: [0, 1, 2, 3, 4].map(() => new THREE.Color(1, 1, 1)) }, uDeep: { value: new THREE.Color(0.3, 0.2, 1) },
        uAccA: { value: new THREE.Color(0, 1, 1) }, uAccB: { value: new THREE.Color(1, 0, 1) },
        uField: { value: null }, uHasField: { value: 0 }, uChallenge: { value: 0 }, uRelief: { value: 0 },
        uFold: { value: 9 }, uBandRot: { value: new THREE.Vector4() }, uBandRot2: { value: new THREE.Vector4() },
        uFrameDensity: { value: 0 }, uMem: { value: new THREE.Vector2(0, 0) }, uWorldGain: { value: new THREE.Vector2(1, 1) }, uFrameLum: { value: new THREE.Vector3(0.04, 0.09, 0.7) }, uSeed: { value: 0 },
        uEnt: { value: 0 }, uEntPos: { value: new THREE.Vector2() }, uEntSize: { value: 0.5 },
        uEntA: { value: null }, uEntB: { value: null }, uEntMix: { value: 0 }, uEntEcho: { value: 5 },
        uEntSway: { value: 0 }, uEntPulse: { value: 0 }, uEntStern: { value: 0 }, uObj: { value: 0 }, uSparks: { value: 0 },
        uEntGlow: { value: new THREE.Color(0, 1, 1) },
        uMsg: { value: 0 }, uMsgT: { value: 0 }, uRings: { value: 3 }, uRingRot: { value: new THREE.Vector4() },
        uAtlas: { value: null }, uGlyphCount: { value: 24 }, uGlyphSeed: { value: 0 }, uKeyPulse: { value: 0 }, uLookVel: { value: 0 },
      },
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    q.frustumCulled = false;
    this.scene.add(q);
    this.dbgLog = typeof location !== 'undefined' && /[?&]btdebug=1/.test(location.search);
  }

  /** false while world / sprite textures of the session are still loading (readyForCapture, D-G3). */
  get ready(): boolean {
    return this.pending === 0;
  }

  init(_renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.configure(state);
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  // ------------------------------------------------------------------ assets
  private load(url: string, srgb: boolean, ok: (t: THREE.Texture) => void, fail: () => void): void {
    this.pending++;
    new THREE.TextureLoader().load(url, (tex) => {
      this.pending--;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      ok(tex);
    }, undefined, () => { this.pending--; fail(); });
  }

  private configure(state: SharedState): void {
    const script = state.tripScript;
    const bt = script?.breakthrough;
    const world = (bt?.world ?? null) as { images?: string[]; image?: string; procedural?: boolean } | null;
    const base = state.assetBase;
    const imgs = world ? (Array.isArray(world.images) && world.images.length ? world.images : world.image ? [world.image] : []) : [];
    const procedural = !world || world.procedural === true || !base || imgs.length === 0;
    const key = `${base}|${imgs.join(',')}|${procedural}`;
    if (key !== this.worldKey) {
      this.worldKey = key;
      for (const t of this.worlds) t?.dispose();
      this.worlds = [];
      this.worldFailed = [];
      this.procedural = procedural;
      if (!procedural) {
        imgs.slice(0, 3).forEach((p, i) => {
          this.worlds.push(null);
          this.worldFailed.push(false);
          this.load(base + p, true, (tex) => {
            if (this.worldKey !== key) { tex.dispose(); return; }
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.generateMipmaps = true;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            this.worlds[i] = tex;
          }, () => { if (this.worldKey === key) this.worldFailed[i] = true; });
        });
      }
    }
    // palette
    const pal = state.palette?.colours ?? [];
    const pk = pal.join(',');
    if (pk !== this.paletteKey) {
      this.paletteKey = pk;
      const prepared = preparePalette(pal.length ? pal : undefined).map((c) => capRed(jewel(c.clone())));
      const u = this.material.uniforms;
      (u.uPal.value as THREE.Color[]).forEach((c, i) => c.copy(prepared[i % prepared.length]));
      // deep base: darkest raw palette colour, chroma kept
      let deep = new THREE.Color(0.25, 0.1, 0.9);
      let dl = Infinity;
      for (const h of pal) {
        const c = new THREE.Color();
        try { c.set(h); } catch { continue; }
        if (lumOf(c) < dl && chroma(c) > 0.2) { dl = lumOf(c); deep = c; }
      }
      (u.uDeep.value as THREE.Color).copy(capRed(jewel(deep.clone())));
      // accents: the most saturated, then the most saturated far in hue
      const by = [...prepared].sort((a, b) => chroma(b) - chroma(a));
      const a = by[0];
      let best = by[1] ?? a;
      let bs = -1;
      for (const c of prepared) {
        const d = Math.hypot(c.r - a.r, c.g - a.g, c.b - a.b) * (0.3 + chroma(c));
        if (d > bs) { bs = d; best = c; }
      }
      (u.uAccA.value as THREE.Color).copy(a);
      (u.uAccB.value as THREE.Color).copy(best);
    }
    const seed = (state.seed >>> 0);
    if (seed !== this.seed) {
      this.seed = seed;
      this.fold = frameFold(seed);
      this.material.uniforms.uSeed.value = (deriveSeed(seed, 'bt-shader') % 1000) / 10;
    }
  }

  private configureEntity(state: SharedState, index: number): void {
    const ents = state.tripScript?.breakthrough?.entities ?? [];
    const e = ents[index] as unknown as { sprites?: string[]; glyph_sprites?: string[] } | undefined;
    const base = state.assetBase;
    const files = e ? (e.sprites?.length === 3 ? e.sprites : e.glyph_sprites?.length === 3 ? e.glyph_sprites : null) : null;
    const key = `${base}|${index}|${files?.join(',') ?? 'glyph'}|${this.paletteKey}`;
    if (key === this.entKey) return;
    this.entKey = key;
    for (const t of this.entOwned) t.dispose();
    this.entOwned = [];
    // procedural glyph beings first (also the fallback while / if the sprites fail)
    const pal = state.palette?.colours ?? [];
    const cols = this.beingColours(pal);
    const s = deriveSeed(this.seed, `being-${index}`);
    this.entTex = [0, 1, 2].map((v) => {
      const t = new THREE.CanvasTexture(glyphBeingCanvas(s, v, 512, cols));
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      this.entOwned.push(t);
      return t;
    });
    if (files && base) {
      files.forEach((f, v) => {
        this.load(base + f, true, (tex) => {
          if (this.entKey !== key) { tex.dispose(); return; }
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.generateMipmaps = true;
          tex.needsUpdate = true;
          this.entTex[v] = tex;
          this.entOwned.push(tex);
        }, () => { /* keep the glyph being */ });
      });
    }
  }

  /** Exposure for a panorama: dark worlds (mean linear luminance < 0.11) are lifted toward it, at most
   *  x2.2 (the tone curve keeps the dark base dark; the back end's luminous floor is the lower bound). The
   *  mean is measured once per texture on a 64x32 canvas copy. */
  private gains = new WeakMap<THREE.Texture, number>();
  private worldGain(t: THREE.Texture): number {
    const known = this.gains.get(t);
    if (known !== undefined) return known;
    let g = 1;
    try {
      const img = t.image as CanvasImageSource & { width: number; height: number };
      const c = document.createElement('canvas'); c.width = 64; c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, 64, 32);
      const d = ctx.getImageData(0, 0, 64, 32).data;
      const lin = (x: number) => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      const mean = sum / (d.length / 4);
      g = Math.max(1, Math.min(2.2, 0.11 / Math.max(1e-3, mean)));
    } catch { g = 1; }
    this.gains.set(t, g);
    return g;
  }

  private beingColours(pal: string[]): [string, string, string] {
    const lit = pal.filter((h) => { const c = new THREE.Color(); try { c.set(h); } catch { return false; } return lumOf(c) > 0.05; });
    const src = lit.length >= 3 ? lit : ['#7df9ff', '#ff4fd8', '#ffe08a'];
    const toHex = (h: string) => { const c = new THREE.Color(); c.set(h); return '#' + c.getHexString(); };
    return [toHex(src[src.length - 1]), toHex(src[Math.floor(src.length / 2)]), toHex(src[0])];
  }

  private ensureAtlas(glyphSeed: number): void {
    if (glyphSeed === this.atlasSeed && this.atlas) return;
    this.atlasSeed = glyphSeed;
    this.atlas?.dispose();
    const a = makeAlphabet(glyphSeed);
    this.glyphCount = a.glyphs.length;
    const tex = new THREE.CanvasTexture(glyphAtlasCanvas(a, 128));
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    this.atlas = tex;
  }

  // ------------------------------------------------------------------ frame
  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    this.configure(state);
    const wall = state.wallTime ?? 0;
    const dt = this.lastWall < 0 ? 0 : Math.max(0, Math.min(0.1, wall - this.lastWall));
    this.lastWall = wall;
    const weight = state.layerWeights?.breakthrough ?? 0;
    const latched = !!state.breakthroughLatched;
    if (latched && !this.latched) this.latchStart = wall;
    this.latched = latched;
    if (weight < 0.002) {
      if (!latched) this.latchStart = -1;
      return;
    }
    if (this.latchStart < 0) this.latchStart = wall;
    if (this.worldStart < 0) this.worldStart = wall;

    const u = this.material.uniforms;
    const v = Math.max(0, Math.min(10, state.intensity?.visual ?? 0));
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    const relief = Math.max(0, Math.min(1, state.challenge?.relief ?? 0));
    const veil = veilProgress(wall - this.latchStart);
    const descent = smoothstep(5.5, 7.6, v);

    // ---- camera: user look (already comfort-clamped in main.ts) + slow constant yaw drift ----
    const look = state.look as unknown as { yaw?: number; pitch?: number; x?: number; y?: number } | undefined;
    const ly = Number(look?.yaw ?? look?.x ?? 0) || 0;
    const lp = Number(look?.pitch ?? look?.y ?? 0) || 0;
    this.yaw += (DRIFT_YAW_DEG_S * Math.PI / 180) * dt * (1 + 0.3 * ch);
    (u.uLook.value as THREE.Vector2).set(this.yaw + ly, Math.max(-0.6, Math.min(0.6, 0.07 + lp)));
    (u.uCamOff.value as THREE.Vector3).set(
      0.035 * Math.sin(wall * 0.05) + 0.03 * ly, 0.015 * Math.cos(wall * 0.037) + 0.03 * lp, 0.02 * Math.sin(wall * 0.029));
    // own look speed when the shared state carries no interaction block
    if (this.lastLook && dt > 0) {
      const sp = Math.hypot(ly - this.lastLook[0], lp - this.lastLook[1]) / dt;
      this.lookVel = follow(this.lookVel, Math.min(1, sp / 1.2), dt, 0.25, 0.8);
    }
    this.lastLook = [ly, lp];
    const inter = (state as unknown as { interaction?: { keyPulse?: number; lookVel?: number } }).interaction;
    const keyPulse = Math.max(0, Math.min(1, Number(inter?.keyPulse ?? 0) || 0));
    const lookVel = Math.max(0, Math.min(1, Number(inter?.lookVel ?? this.lookVel) || 0));

    // ---- world schedule ----
    const ready = this.worlds.map((t, i) => (t && !this.worldFailed[i] ? i : -1)).filter((i) => i >= 0);
    // only once every world has settled (loaded or failed): the schedule never re-indexes mid-view
    const settled = this.worlds.every((t, i) => t !== null || this.worldFailed[i]);
    const useImages = !this.procedural && settled && ready.length > 0;
    if (useImages) {
      const sch = worldSchedule(wall - this.worldStart, ready.length, this.seed);
      const ta = this.worlds[ready[sch.a]]!;
      const tb = this.worlds[ready[sch.b]]!;
      u.uWorldA.value = ta;
      u.uWorldB.value = tb;
      u.uMix.value = sch.mix;
      const lod = (t: THREE.Texture) => Math.log2(Math.max((t.image as { width?: number })?.width ?? 2048, 1));
      (u.uWorldLod.value as THREE.Vector2).set(lod(ta), lod(tb));
      (u.uWorldGain.value as THREE.Vector2).set(this.worldGain(ta), this.worldGain(tb));
      u.uHasWorld.value = 1;
    } else {
      u.uHasWorld.value = 0;
      u.uMix.value = 0;
    }

    // ---- frame ----
    const vi = v / 10;
    u.uVI.value = vi;
    u.uVeil.value = veil;
    u.uAperture.value = aperture(v, veil, ch);
    u.uDim.value = 0.35 + 0.65 * descent;
    u.uFold.value = this.fold;
    const fl = frameLuminance(v, ch);
    (u.uFrameLum.value as THREE.Vector3).set(fl.lMin, fl.lMax, fl.edge);
    u.uFrameDensity.value = smoothstep(6, 9.5, v);
    const N = this.fold;
    const cellsOf = (k: number) => (k === 0 ? N : k === 7 ? 4 * N : N * (1 + ((k - 1) % 2)) * (k - 1 > 4 ? 2 : 1));
    for (let k = 0; k < 8; k++) {
      const dir = k % 2 === 0 ? 1 : -1;
      const g = 0.45 + 0.55 * ((deriveSeed(this.seed, `band-${k}`) % 1000) / 1000);
      // the polygons (0: aperture rim + lips, 2, 3: outer filament polygons): vertices pass a given angle at
      // <= 0.06 Hz calm, <= 0.45 Hz in a difficult passage. Measured: at the old 1.6 Hz the thin bright
      // lines and their halos swept tiles back and forth fast enough to keep the flash backstop engaged.
      const rev = k === 0 || k === 2 || k === 3 ? (0.06 + 0.39 * ch) / N : frameRotationRev(cellsOf(k), v, ch);
      this.bandRot[k] += dir * g * rev * 2 * Math.PI * dt;
    }
    (u.uBandRot.value as THREE.Vector4).set(this.bandRot[0], this.bandRot[1], this.bandRot[2], this.bandRot[3]);
    (u.uBandRot2.value as THREE.Vector4).set(this.bandRot[4], this.bandRot[5], this.bandRot[6], this.bandRot[7]);
    // membrane: MEMBRANE_CELLS cells around; flow 0.035 -> 0.12 cells/s, rotation so edges pass a pixel at
    // 0.03 -> 0.3 Hz (both far below 2 Hz)
    this.memFlow += dt * (0.035 + 0.085 * ch);
    this.memRot += dt * 2 * Math.PI * (0.03 + 0.27 * ch) / MEMBRANE_CELLS;
    (u.uMem.value as THREE.Vector2).set(this.memFlow % 1000, this.memRot % (2 * Math.PI));
    u.uChallenge.value = ch;
    u.uRelief.value = relief;
    u.uTime.value = wall;
    const tex = state.fieldTexture;
    if (tex && (tex as THREE.Texture).isTexture) { u.uField.value = tex; u.uHasField.value = 1; }
    else { u.uField.value = null; u.uHasField.value = 0; }

    // ---- entity ----
    const e = (state.entity ?? {}) as LooseEntity;
    const present = !!e.present;
    const idx = Math.max(0, Number(e.index ?? 0) || 0);
    this.configureEntity(state, idx);
    const entTarget = present ? Math.max(0, Math.min(1, Number(e.intensity ?? 1))) : 0;
    this.ent = follow(this.ent, entTarget, dt, 0.6, 1.0);
    const beh = e.behaviour ?? null;
    if (beh !== this.behaviour) { this.behaviour = beh; this.behaviourStart = wall; }
    const bl = behaviourLook(beh, wall - this.behaviourStart);
    this.stern = follow(this.stern, ch, dt, 2, 4);
    // morph: shared-state variant/morph when present, else a slow own cycle (faster when transforming)
    let variant: number;
    let morph: number;
    if (typeof e.variant === 'number' && typeof e.morph === 'number') {
      variant = ((Math.floor(e.variant) % 3) + 3) % 3;
      morph = Math.max(0, Math.min(1, e.morph));
    } else {
      this.morphPhase += dt / (MORPH_PERIOD_S / 3) * bl.morphSpeed * (1 - 0.5 * this.stern);
      ({ variant, morph } = morphFromPhase(this.morphPhase));
    }
    u.uEntA.value = this.entTex[variant] ?? null;
    u.uEntB.value = this.entTex[(variant + 1) % 3] ?? null;
    u.uEntMix.value = morph;
    const pos = e.position;
    let px = 0;
    let py = -0.08;
    if (Array.isArray(pos)) { px = Number(pos[0]) || 0; py = Number(pos[1]) || 0; }
    else if (pos && typeof pos === 'object') { px = Number(pos.x) || 0; py = Number(pos.y) || 0; }
    const aspect = this.w / this.h;
    const drift = 0.035;
    const depth = Math.max(0, Math.min(1, typeof e.depth === 'number' ? e.depth : 0.35));
    const recede = Math.max(bl.recede, 1 - descent);
    const size = (0.66 - 0.32 * depth) * bl.scale * (1 + 0.12 * this.stern) * (1 - 0.45 * (1 - descent));
    (u.uEntPos.value as THREE.Vector2).set(
      px * aspect * 0.55 + drift * Math.sin(wall * 0.11),
      py * 0.55 + drift * 0.6 * Math.sin(wall * 0.07 + 1) + 0.25 * recede * bl.recede);
    u.uEntSize.value = size;
    u.uEnt.value = this.ent * (1 - 0.6 * recede) * (0.4 + 0.6 * veil);
    u.uEntEcho.value = echoCount(this.seed, idx);
    this.swayPhase += dt * 2 * Math.PI * 0.18 * (1 - 0.5 * this.stern);
    u.uEntSway.value = bl.sway * Math.sin(this.swayPhase);
    this.entPulse = follow(this.entPulse, keyPulse, dt, 0.3, 0.9);
    u.uEntPulse.value = this.entPulse * 0.6;
    u.uEntStern.value = this.stern;
    u.uObj.value = bl.object;
    u.uSparks.value = bl.sparks;
    const pals = u.uPal.value as THREE.Color[];
    (u.uEntGlow.value as THREE.Color).copy(pals[(idx + 2) % 5]);

    // ---- message ----
    const m = (state.message ?? {}) as LooseMessage;
    const mOn = !!(m.present ?? m.active);
    if (mOn && !this.msgOn) this.msgStart = wall;
    this.msgOn = mOn;
    const mT = typeof m.t === 'number' && m.active !== undefined ? m.t : wall - this.msgStart;
    const mInt = typeof m.intensity === 'number' ? (mOn ? Math.max(0, Math.min(1, m.intensity)) : 0) : messageEnvelope(mOn, mT);
    const gseed = Number(m.glyphSeed ?? (state.tripScript?.breakthrough?.message as { glyph_seed?: number } | null)?.glyph_seed ?? this.seed) >>> 0;
    this.ensureAtlas(gseed);
    u.uAtlas.value = this.atlas;
    u.uGlyphCount.value = Math.min(this.glyphCount, ATLAS_COLS * 4);
    u.uGlyphSeed.value = (gseed % 997) + 0.5;
    const nR = ringCount(gseed);
    u.uRings.value = nR;
    const gh = 0.085 + 0.02 * size;
    for (let j = 0; j < 4; j++) {
      const R = size * 0.95 + gh * 1.25 * (j + 0.6);
      const cells = Math.floor((2 * Math.PI * R) / (gh * 1.05));
      this.ringRot[j] += ringRotationRev(j, cells) * 2 * Math.PI * dt * (1 + 0.3 * ch);
    }
    (u.uRingRot.value as THREE.Vector4).set(this.ringRot[0], this.ringRot[1], this.ringRot[2], this.ringRot[3]);
    u.uMsg.value = mInt * (this.ent > 0.05 ? 1 : 0.0) * (0.5 + 0.5 * descent);
    u.uMsgT.value = mT;
    u.uKeyPulse.value = keyPulse;
    u.uLookVel.value = lookVel;

    u.uWeight.value = Math.max(0, Math.min(1, weight));
    (u.uRes.value as THREE.Vector2).set(target ? target.width : this.w, target ? target.height : this.h);
    if (this.dbgLog && Math.floor(wall) !== Math.floor(wall - dt)) {
      console.log('[bt]', JSON.stringify({ v, veil, ap: u.uAperture.value, ent: u.uEnt.value, msg: u.uMsg.value, world: u.uHasWorld.value, mix: u.uMix.value }));
    }
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    for (const t of this.worlds) t?.dispose();
    for (const t of this.entOwned) t.dispose();
    this.atlas?.dispose();
  }
}

export function createBreakthroughLayer(): BreakthroughLayer {
  return new BreakthroughLayer();
}
