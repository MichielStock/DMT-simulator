// SafetyLimiter: the final, always-on photosensitivity pass (BUILD.md §4.1). There is deliberately
// no flag, option, URL parameter or method that disables or bypasses it.
//
// Per frame:
//  1. Downsample the LINEAR scene texture to a 64x36 tile grid (mean relative luminance, saturated-red
//     fraction, two point probes per tile; plus min/max/contrast factor) and read it back.
//  2. Feed two FlashDetectors (tile means, and point probes that also catch fine patterns reversing
//     inside a tile). When either engages, the frame is temporally low-passed (EMA, k <= 0.15) and the
//     output moves from the previous OUTPUT frame toward it with a per-pixel luminance slew limit
//     (MAX_SLEW_PER_S, applied globally) until the window clears, then is released gradually.
//     A full-amplitude 10 Hz flicker therefore settles to its temporal mean (mid-grey), not to a
//     dark or bright frozen frame, with a residual far below FLASH_DELTA.
//  3. Always: soft-cap mean luminance (no full-screen near-white) and, when a large area is high
//     contrast, compress local contrast (backstop for the periodic-pattern rule).
import * as THREE from 'three';
import { FlashDetector, type FlashKind } from './flashDetector';
import { BLIT_FRAG, EMA_FRAG, OUTPUT_FRAG, QUAD_VERT, tileFrag } from './limiterShaders';
import {
  GUARD_AREA_FRACTION, GUARD_TILE_CONTRAST, LOWPASS_K_MAX, LOWPASS_TAU_S, MAX_SLEW_PER_S,
  MEAN_KNEE, MEAN_TARGET, RELEASE_MS, TILE_GRID,
} from './thresholds';

export interface LimiterInfo { kind: FlashKind; tiles: number }

/** Mean-luminance soft cap: identity below MEAN_KNEE, smoothly saturating at MEAN_TARGET. */
export function capMeanLuminance(m: number): number {
  if (m <= MEAN_KNEE) return m;
  const span = MEAN_TARGET - MEAN_KNEE;
  return MEAN_KNEE + span * (1 - Math.exp(-(m - MEAN_KNEE) / span));
}

/** Low-pass factor and per-frame luminance clamp for a frame of dtS seconds at engagement strength s. */
export function limiterParams(dtS: number, strength: number): { k: number; maxDelta: number } {
  const dt = Math.min(1 / 20, Math.max(0, dtS));
  const s = Math.min(1, Math.max(0, strength));
  const kE = Math.min(LOWPASS_K_MAX, 1 - Math.exp(-dt / LOWPASS_TAU_S));
  const k = s >= 1 ? kE : kE + (1 - kE) * (1 - s);
  const dE = MAX_SLEW_PER_S * dt;
  const maxDelta = s <= 0 ? 1 : Math.min(1, dE * Math.pow(1 / dE, 1 - s));
  return { k, maxDelta };
}

/** CPU reference of the two output passes for one luminance value (tests; mirrors EMA_FRAG + OUTPUT_FRAG).
 *  Mutates and returns `st` ({ema, out}). */
export function stepLuminance(st: { ema: number; out: number }, input: number, k: number, maxDelta: number):
  { ema: number; out: number } {
  st.ema = st.ema + (input - st.ema) * k;
  const d = st.ema - st.out;
  const s = Math.min(1, maxDelta / Math.max(Math.abs(d), 1e-6));
  st.out = st.out + d * s;
  return st;
}

export interface SafetyLimiterOptions { now?: () => number }

export class SafetyLimiter {
  readonly renderer: THREE.WebGLRenderer;
  private readonly now: () => number;
  private readonly cols = TILE_GRID[0];
  private readonly rows = TILE_GRID[1];
  private readonly nTiles = TILE_GRID[0] * TILE_GRID[1];
  private readonly tileTarget: THREE.WebGLRenderTarget;
  private readonly statsTarget: THREE.WebGLRenderTarget;
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private ema: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private histW = 0;
  private histH = 0;
  private cur = 0;
  private hasHistory = false;
  private readonly tileBuf: Uint8Array;
  private readonly statsBuf: Uint8Array;
  private readonly lum: Float32Array;
  private readonly red: Uint8Array;
  private readonly probes: Float32Array;
  private readonly probeRed: Uint8Array;
  private readonly meanDetector: FlashDetector;
  private readonly probeDetector: FlashDetector;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly tileMat: THREE.ShaderMaterial;
  private readonly statsMat: THREE.ShaderMaterial;
  private readonly emaMat: THREE.ShaderMaterial;
  private readonly outMat: THREE.ShaderMaterial;
  private readonly blitMat: THREE.ShaderMaterial;
  private readonly listeners: Array<(info: LimiterInfo) => void> = [];
  private lastMs: number | null = null;
  private strength = 0;
  private guard = 0;
  private episodeOpen = false;
  private engagedFlag = false;
  private lastMean = 0;
  private lastGuardFraction = 0;
  private episodes = 0;

  constructor(renderer: THREE.WebGLRenderer, opts: SafetyLimiterOptions = {}) {
    this.renderer = renderer;
    this.now = opts.now ?? (() => performance.now());
    const tileOpts = {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    } as const;
    this.tileTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, tileOpts);
    this.statsTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, tileOpts);
    this.tileBuf = new Uint8Array(this.nTiles * 4);
    this.statsBuf = new Uint8Array(this.nTiles * 4);
    this.lum = new Float32Array(this.nTiles);
    this.red = new Uint8Array(this.nTiles);
    this.probes = new Float32Array(this.nTiles * 2);
    this.probeRed = new Uint8Array(this.nTiles * 2);
    this.meanDetector = new FlashDetector({ tiles: this.nTiles });
    this.probeDetector = new FlashDetector({ tiles: this.nTiles * 2 });

    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT, fragmentShader: frag, uniforms,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
      });
    this.tileMat = mk(tileFrag(0), { uInput: { value: null } });
    this.statsMat = mk(tileFrag(1), { uInput: { value: null } });
    this.emaMat = mk(EMA_FRAG, {
      uInput: { value: null }, uPrevEma: { value: null }, uStats: { value: this.statsTarget.texture },
      uK: { value: 1 }, uBright: { value: 1 }, uGuard: { value: 0 },
    });
    this.outMat = mk(OUTPUT_FRAG, { uEma: { value: null }, uPrev: { value: null }, uMaxDelta: { value: 1 } });
    this.blitMat = mk(BLIT_FRAG, { uSrc: { value: null } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.tileMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** True while the flash backstop is engaged (input flicker detected within the window). */
  get engaged(): boolean { return this.engagedFlag; }

  /** Diagnostics only (read-only snapshot). */
  get status(): { engaged: boolean; strength: number; patternGuard: number; meanLuminance: number;
    highContrastFraction: number; episodes: number } {
    return { engaged: this.engagedFlag, strength: this.strength, patternGuard: this.guard,
      meanLuminance: this.lastMean, highContrastFraction: this.lastGuardFraction, episodes: this.episodes };
  }

  /** Called once at the start of every engagement episode. */
  onEngaged(cb: (info: LimiterInfo) => void): void { this.listeners.push(cb); }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  private ensureHistory(w: number, h: number): void {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (this.history && this.histW === w && this.histH === h) return;
    if (this.history) { this.history[0].dispose(); this.history[1].dispose(); }
    if (this.ema) { this.ema[0].dispose(); this.ema[1].dispose(); }
    const o = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    } as const;
    this.history = [new THREE.WebGLRenderTarget(w, h, o), new THREE.WebGLRenderTarget(w, h, o)];
    this.ema = [new THREE.WebGLRenderTarget(w, h, o), new THREE.WebGLRenderTarget(w, h, o)];
    this.histW = w; this.histH = h; this.hasHistory = false;
  }

  /** Analyse `input` (linear RGB scene texture) and draw the limited result to the screen (w x h). */
  render(input: THREE.Texture, w: number, h: number): void {
    const t = this.now();
    const dtS = this.lastMs === null ? 1 / 60 : (t - this.lastMs) / 1000;
    this.lastMs = t;
    this.ensureHistory(w, h);
    const r = this.renderer;

    // 1. analysis
    this.tileMat.uniforms.uInput.value = input;
    this.statsMat.uniforms.uInput.value = input;
    this.pass(this.tileMat, this.tileTarget);
    this.pass(this.statsMat, this.statsTarget);
    r.readRenderTargetPixels(this.tileTarget, 0, 0, this.cols, this.rows, this.tileBuf);
    r.readRenderTargetPixels(this.statsTarget, 0, 0, this.cols, this.rows, this.statsBuf);
    const n = this.nTiles;
    let sum = 0; let hiContrast = 0;
    for (let i = 0; i < n; i++) {
      const y = this.tileBuf[4 * i] / 255;
      const rf = this.tileBuf[4 * i + 1] >= 128 ? 1 : 0;
      this.lum[i] = y; sum += y; this.red[i] = rf;
      this.probes[2 * i] = this.tileBuf[4 * i + 2] / 255;
      this.probes[2 * i + 1] = this.tileBuf[4 * i + 3] / 255;
      this.probeRed[2 * i] = rf; this.probeRed[2 * i + 1] = rf;
      const mn = this.statsBuf[4 * i] / 255; const mx = this.statsBuf[4 * i + 1] / 255;
      if ((mx - mn) / Math.max(mx + mn, 1e-4) > GUARD_TILE_CONTRAST && mx - mn > 0.05) hiContrast++;
    }
    const mean = sum / n;
    this.lastMean = mean;
    this.lastGuardFraction = hiContrast / n;

    const a = this.meanDetector.push(this.lum, this.red, t);
    const b = this.probeDetector.push(this.probes, this.probeRed, t);
    const engagedNow = a.engage || b.engage;
    this.engagedFlag = engagedNow;
    if (engagedNow && !this.episodeOpen) {
      this.episodeOpen = true;
      this.episodes++;
      const kind: FlashKind = a.kind === 'red' || b.kind === 'red' ? 'red' : 'general';
      const info: LimiterInfo = { kind, tiles: Math.max(a.tiles, Math.ceil(b.tiles / 2)) };
      for (const cb of this.listeners) { try { cb(info); } catch (e) { console.error(e); } }
    }
    const dtClamped = Math.min(1 / 20, Math.max(0, dtS));
    if (engagedNow) this.strength = 1;
    else {
      this.strength = Math.max(0, this.strength - (dtClamped * 1000) / RELEASE_MS);
      if (this.strength === 0) this.episodeOpen = false;
    }
    if (this.lastGuardFraction > GUARD_AREA_FRACTION) this.guard = 1;
    else this.guard = Math.max(0, this.guard - (dtClamped * 1000) / RELEASE_MS);

    // 2. EMA (low-pass) and slew-limited output into the linear history, then blit to screen
    const hist = this.history!;
    const ema = this.ema!;
    const dst = hist[this.cur];
    const prev = hist[1 - this.cur];
    let { k, maxDelta } = limiterParams(dtS, this.strength);
    if (!this.hasHistory) { k = 1; maxDelta = 1; }
    const ue = this.emaMat.uniforms;
    ue.uInput.value = input;
    ue.uPrevEma.value = ema[1 - this.cur].texture;
    ue.uK.value = k;
    ue.uBright.value = mean > 1e-4 ? capMeanLuminance(mean) / mean : 1;
    ue.uGuard.value = this.guard;
    this.pass(this.emaMat, ema[this.cur]);
    const uo = this.outMat.uniforms;
    uo.uEma.value = ema[this.cur].texture;
    uo.uPrev.value = prev.texture;
    uo.uMaxDelta.value = maxDelta;
    this.pass(this.outMat, dst);
    this.blitMat.uniforms.uSrc.value = dst.texture;
    this.pass(this.blitMat, null);
    this.hasHistory = true;
    this.cur = 1 - this.cur;
  }

  dispose(): void {
    this.tileTarget.dispose(); this.statsTarget.dispose();
    if (this.history) { this.history[0].dispose(); this.history[1].dispose(); }
    if (this.ema) { this.ema[0].dispose(); this.ema[1].dispose(); }
    this.tileMat.dispose(); this.statsMat.dispose(); this.emaMat.dispose(); this.outMat.dispose();
    this.blitMat.dispose();
    this.quad.geometry.dispose();
  }
}
