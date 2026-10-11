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
//  3. Always: soft-cap mean luminance (no full-screen near-white) and, when a large area is covered by a
//     high-contrast PATTERN, compress local contrast there (backstop for the §4.1 pattern rule).
//     A tile counts only when its 5x5-tile neighbourhood exceeds GUARD_TILE_CONTRAST (range > GUARD_RANGE_MIN)
//     AND it is a pattern tile: periodic (periodicity.ts, score >= GUARD_PERIODICITY_MIN, NOTES.md S8) or
//     stripes (oriented, repeated full-range swings, which also covers chirps such as zone plates and
//     irregular bar codes, NOTES.md S8b), both 3x3-dilated, or spectrally sparse (most of a 4- or 8-tile
//     window's energy in three spectral peaks: 2-D lattices, crossed chirps, plaids, NOTES.md S8c).
//     Aperiodic high contrast (photos, filaments and blooms on black) never engages the guard. While the guard is on, the pattern tiles (5x5-dilated)
//     and the tiles they fully enclose are compressed so that the contrast over a 9x9-tile window, the
//     local mean's own variation included, stays at most GUARD_TARGET_CONTRAST.
//  4. While the flash backstop is engaged, the output steps toward the low-passed frame by ONE factor for
//     the whole frame (the largest per-pixel change sets it), so the fade itself never raises contrast.
import * as THREE from 'three';
import { FlashDetector, type FlashKind } from './flashDetector';
import {
  BLIT_FRAG, COPY_FRAG, EMA_FRAG, GUARD_CF_FRAG, LUMA_DOWN_FRAG, OUTPUT_FRAG, PERIODICITY_REDUCE_FRAG, QUAD_VERT, SLEW_GLOBAL_FRAG,
  SLEW_TILE_FRAG, SPEC_COLS, SPEC_COL_FRAG, SPEC_KX2, SPEC_KY2, SPEC_PICK_FRAG, SPEC_ROWS, SPEC_ROW_FRAG, SPEC_STATS_FRAG,
  SPEC_STRIP_FRAG,
  TENSOR_FRAG, periodicityFrag, tileFrag,
} from './limiterShaders';
import { N_DIRS, SPECTRAL_LEVELS, SPECTRAL_N, SPECTRAL_PEAKS, dilateMask, fillEnclosed } from './periodicity';
import {
  GUARD_AREA_FRACTION, GUARD_TILE_CONTRAST, LOWPASS_K_MAX, LOWPASS_TAU_S, MAX_SLEW_PER_S,
  MEAN_KNEE, MEAN_TARGET, RELEASE_MS, TILE_GRID,
} from './thresholds';

export interface LimiterInfo { kind: FlashKind; tiles: number }

/** Pattern guard: a tile's luminance counts as PERIODIC when its periodicity score (periodicity.ts:
 *  autocorrelation repeat height, max over directions and scales, 0..1) is at least this. Periodic
 *  stripes/rings/lattices score ~0.9-1.0; photos, noise, blooms and filaments score mostly < 0.3.
 *  This does not loosen any thresholds.ts value: it restricts the always-on guard to the periodic
 *  patterns that BUILD.md §4.1 caps (NOTES.md S8). */
export const GUARD_PERIODICITY_MIN = 0.5;

/** Pattern guard: a tile's 5x5-tile neighbourhood counts as high-contrast only when its luminance range
 *  (max - min) also exceeds this. Equal to flashcheck's own floor for a pattern block (hi - lo >= 0.02),
 *  so dark or saturated-blue stripes (blue 0.6 on black: range 0.043) are not missed (S8b; was 0.05). */
export const GUARD_RANGE_MIN = 0.02;

export interface LimiterStatus {
  engaged: boolean; strength: number; patternGuard: number; meanLuminance: number;
  /** Fraction of tiles that are pattern tiles (periodic or stripes, 3x3-dilated) AND high-contrast: what the
   *  guard counts. */
  highContrastFraction: number;
  /** Fraction of tiles whose own periodicity score is >= GUARD_PERIODICITY_MIN (any contrast). */
  periodicFraction: number;
  /** Fraction of tiles that pass the stripe test (S8b; any contrast), periodic or not. */
  stripeFraction: number;
  /** Fraction of tiles whose local spectrum is sparse (S8c; any contrast). */
  spectralFraction: number;
  /** Fraction of high-contrast tiles regardless of periodicity (what the guard counted before S8). */
  contrastFraction: number;
  episodes: number;
}

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
  private readonly lumTarget: THREE.WebGLRenderTarget;
  private readonly profileTarget: THREE.WebGLRenderTarget;
  private readonly perTarget: THREE.WebGLRenderTarget;
  private readonly tensorTarget: THREE.WebGLRenderTarget;
  private readonly guardTarget: THREE.WebGLRenderTarget;
  private readonly specScale: number;
  private readonly specStatsTarget: THREE.WebGLRenderTarget;
  private readonly specRowTarget: THREE.WebGLRenderTarget;
  private readonly specPowTarget: THREE.WebGLRenderTarget;
  private readonly specStripTarget: THREE.WebGLRenderTarget;
  private readonly specState: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly specPeakTarget: THREE.WebGLRenderTarget;
  private readonly slewTileTarget: THREE.WebGLRenderTarget;
  private readonly slewTarget: THREE.WebGLRenderTarget;
  private readonly guardMaskData: Uint8Array<ArrayBuffer>;
  private readonly guardMaskTex: THREE.DataTexture;
  private readonly guardWeight: Float32Array;
  private readonly periodicMask: Uint8Array;
  private readonly patternRaw: Uint8Array;
  private readonly profileRaw: Uint8Array;
  private readonly stripeRaw: Uint8Array;
  private readonly spectralRaw: Uint8Array;
  private readonly compressMask: Uint8Array;
  private readonly fillScratch: Int32Array;
  private readonly periodicity: Float32Array;
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
  private readonly lumMat: THREE.ShaderMaterial;
  private readonly perMat: THREE.ShaderMaterial;
  private readonly reduceMat: THREE.ShaderMaterial;
  private readonly tensorMat: THREE.ShaderMaterial;
  private readonly guardCfMat: THREE.ShaderMaterial;
  private readonly specStatsMat: THREE.ShaderMaterial;
  private readonly specRowMat: THREE.ShaderMaterial;
  private readonly specColMat: THREE.ShaderMaterial;
  private readonly specStripMat: THREE.ShaderMaterial;
  private readonly specPickMat: THREE.ShaderMaterial;
  private readonly slewTileMat: THREE.ShaderMaterial;
  private readonly slewMat: THREE.ShaderMaterial;
  private readonly emaMat: THREE.ShaderMaterial;
  private readonly outMat: THREE.ShaderMaterial;
  private readonly blitMat: THREE.ShaderMaterial;
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly listeners: Array<(info: LimiterInfo) => void> = [];
  private lastMs: number | null = null;
  private strength = 0;
  private guard = 0;
  private episodeOpen = false;
  private engagedFlag = false;
  private lastMean = 0;
  private lastGuardFraction = 0;
  private lastPeriodicFraction = 0;
  private lastStripeFraction = 0;
  private lastSpectralFraction = 0;
  private lastContrastFraction = 0;
  private episodes = 0;

  constructor(renderer: THREE.WebGLRenderer, opts: SafetyLimiterOptions = {}) {
    this.renderer = renderer;
    this.now = opts.now ?? (() => performance.now());
    const tileOpts = {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    } as const;
    const halfOpts = { ...tileOpts, type: THREE.HalfFloatType } as const;
    this.tileTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, tileOpts);
    // half float: the guard's neighbourhood mean / min / max keep their precision on dark content (S8b)
    this.statsTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, halfOpts);
    this.guardTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, halfOpts);
    // box-filtered luminance, 8x8 texels per tile; mip level 3 = exact-area tile means (64 x 36)
    this.lumTarget = new THREE.WebGLRenderTarget(this.cols * 8, this.rows * 8, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    });
    this.profileTarget = new THREE.WebGLRenderTarget(this.cols * N_DIRS, this.rows * 4, {
      ...halfOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    // structure tensor per luminance texel; mip level 3 = per-tile mean tensor (S8b stripe test)
    this.tensorTarget = new THREE.WebGLRenderTarget(this.cols * 8, this.rows * 8, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    });
    this.perTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, tileOpts);
    // S8c local spectrum: per-window stats, row DFT, power spectrum (half plane), peak fractions
    const nearestHalf = { ...halfOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as const;
    const nLv = SPECTRAL_LEVELS.length;
    // the DFT targets are 32-bit float where renderable (EXT_color_buffer_float; every desktop WebGL2), else
    // half float with a 1/N scale per DFT pass (the S8c decision is a ratio of energies)
    const ext = (renderer as { extensions?: { has?: (n: string) => boolean } }).extensions;
    const floatOk = !!ext?.has?.('EXT_color_buffer_float');
    const dftOpts = { ...nearestHalf, type: floatOk ? THREE.FloatType : THREE.HalfFloatType } as const;
    this.specScale = floatOk ? 1 : 1 / SPECTRAL_N;
    this.specStatsTarget = new THREE.WebGLRenderTarget(SPEC_COLS, SPEC_ROWS * nLv, dftOpts);
    this.specRowTarget = new THREE.WebGLRenderTarget(SPEC_COLS * SPEC_KX2, nLv * SPEC_ROWS * SPECTRAL_N, dftOpts);
    this.specPowTarget = new THREE.WebGLRenderTarget(SPEC_COLS * SPEC_KX2, nLv * SPEC_ROWS * SPEC_KY2, dftOpts);
    this.specStripTarget = new THREE.WebGLRenderTarget(SPEC_COLS, nLv * SPEC_ROWS * SPEC_KY2, dftOpts);
    this.specState = [new THREE.WebGLRenderTarget(SPEC_COLS, SPEC_ROWS * nLv, dftOpts),
      new THREE.WebGLRenderTarget(SPEC_COLS, SPEC_ROWS * nLv, dftOpts)];
    this.specPeakTarget = new THREE.WebGLRenderTarget(SPEC_COLS, SPEC_ROWS * nLv, nearestHalf);
    // global slew factor of the output pass (S8c)
    this.slewTileTarget = new THREE.WebGLRenderTarget(this.cols, this.rows, nearestHalf);
    this.slewTarget = new THREE.WebGLRenderTarget(1, 1, nearestHalf);
    this.guardMaskData = new Uint8Array(this.nTiles);
    this.guardMaskTex = new THREE.DataTexture(this.guardMaskData, this.cols, this.rows, THREE.RedFormat,
      THREE.UnsignedByteType);
    this.guardMaskTex.minFilter = THREE.LinearFilter;
    this.guardMaskTex.magFilter = THREE.LinearFilter;
    this.guardMaskTex.generateMipmaps = false;
    this.guardMaskTex.needsUpdate = true;
    this.guardWeight = new Float32Array(this.nTiles);
    this.periodicMask = new Uint8Array(this.nTiles);
    this.patternRaw = new Uint8Array(this.nTiles);
    this.profileRaw = new Uint8Array(this.nTiles);
    this.stripeRaw = new Uint8Array(this.nTiles);
    this.spectralRaw = new Uint8Array(this.nTiles);
    this.compressMask = new Uint8Array(this.nTiles);
    this.fillScratch = new Int32Array(this.nTiles);
    this.periodicity = new Float32Array(this.nTiles);
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
    this.statsMat = mk(tileFrag(1), { uInput: { value: null }, uLum: { value: this.lumTarget.texture } });
    this.lumMat = mk(LUMA_DOWN_FRAG, { uInput: { value: null } });
    this.perMat = mk(periodicityFrag(), { uInput: { value: null }, uLum: { value: this.lumTarget.texture } });
    this.reduceMat = mk(PERIODICITY_REDUCE_FRAG, {
      uPer: { value: this.profileTarget.texture }, uStats: { value: this.statsTarget.texture },
      uTensor: { value: this.tensorTarget.texture }, uLum: { value: this.lumTarget.texture },
      uSpec: { value: this.specPeakTarget.texture },
    });
    this.specStatsMat = mk(SPEC_STATS_FRAG, { uLum: { value: this.lumTarget.texture } });
    this.specRowMat = mk(SPEC_ROW_FRAG, { uLum: { value: this.lumTarget.texture }, uSpecStats: { value: this.specStatsTarget.texture },
      uScale: { value: this.specScale } });
    this.specColMat = mk(SPEC_COL_FRAG, { uRow: { value: this.specRowTarget.texture }, uScale: { value: this.specScale } });
    this.specStripMat = mk(SPEC_STRIP_FRAG, { uPow: { value: this.specPowTarget.texture }, uState: { value: null }, uQ: { value: 0 } });
    this.specPickMat = mk(SPEC_PICK_FRAG, { uPow: { value: this.specPowTarget.texture }, uStrips: { value: this.specStripTarget.texture },
      uState: { value: null }, uQ: { value: 0 }, uScale: { value: this.specScale } });
    this.slewTileMat = mk(SLEW_TILE_FRAG, { uEma: { value: null }, uPrev: { value: null } });
    this.slewMat = mk(SLEW_GLOBAL_FRAG, { uSlewTiles: { value: this.slewTileTarget.texture }, uMaxDelta: { value: 1 } });
    this.tensorMat = mk(TENSOR_FRAG, { uLum: { value: this.lumTarget.texture } });
    this.guardCfMat = mk(GUARD_CF_FRAG, { uStats: { value: this.statsTarget.texture } });
    this.emaMat = mk(EMA_FRAG, {
      uInput: { value: null }, uPrevEma: { value: null }, uStats: { value: this.guardTarget.texture },
      uK: { value: 1 }, uBright: { value: 1 }, uGuard: { value: 0 }, uGuardMask: { value: this.guardMaskTex },
    });
    this.outMat = mk(OUTPUT_FRAG, {
      uEma: { value: null }, uPrev: { value: null }, uSlew: { value: this.slewTarget.texture }, uSlewOn: { value: 0 },
    });
    this.blitMat = mk(BLIT_FRAG, { uSrc: { value: null } });
    this.copyMat = mk(COPY_FRAG, { uSrc: { value: null } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.tileMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** True while the flash backstop is engaged (input flicker detected within the window). */
  get engaged(): boolean { return this.engagedFlag; }

  /** Diagnostics only (read-only snapshot). */
  get status(): LimiterStatus {
    return { engaged: this.engagedFlag, strength: this.strength, patternGuard: this.guard,
      meanLuminance: this.lastMean, highContrastFraction: this.lastGuardFraction,
      periodicFraction: this.lastPeriodicFraction, stripeFraction: this.lastStripeFraction,
      spectralFraction: this.lastSpectralFraction, contrastFraction: this.lastContrastFraction,
      episodes: this.episodes };
  }

  /** Diagnostics only: copy of the last frame's per-tile periodicity scores (row-major, row 0 = bottom). */
  periodicityMap(): Float32Array { return this.periodicity.slice(); }

  /** Diagnostics only: copy of the last frame's per-tile stripe flags (S8b; 0/1, row 0 = bottom). */
  stripeMap(): Uint8Array { return this.stripeRaw.slice(); }

  /** Diagnostics only: copy of the last frame's per-tile local-spectrum flags (S8c; 0/1, row 0 = bottom). */
  spectralMap(): Uint8Array { return this.spectralRaw.slice(); }

  /** Diagnostics only: wall-clock latency (ms, mean over `iterations`) of the analysis as it runs in a
   *  frame, each iteration ended by a synchronising 1-pixel readback: `baseMs` the tile + stats passes
   *  (the analysis before S8; its stats pass now reads the luminance pyramid, here left from the last
   *  frame), `withPeriodicityMs` everything S8/S8b/S8c runs: tile, luminance pyramid, structure tensor,
   *  stats, both periodicity passes, the four local-spectrum passes and the guard-cf pass. */
  timeAnalysis(input: THREE.Texture, iterations = 200): { baseMs: number; withPeriodicityMs: number } {
    const px = new Uint8Array(4);
    this.tileMat.uniforms.uInput.value = input;
    this.statsMat.uniforms.uInput.value = input;
    this.perMat.uniforms.uInput.value = input;
    this.lumMat.uniforms.uInput.value = input;
    const run = (all: boolean): number => {
      let total = 0;
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        this.pass(this.tileMat, this.tileTarget);
        if (all) { this.pass(this.lumMat, this.lumTarget); this.pass(this.tensorMat, this.tensorTarget); }
        this.pass(this.statsMat, this.statsTarget);
        if (all) {
          this.pass(this.perMat, this.profileTarget); this.spectrum();
          this.pass(this.reduceMat, this.perTarget); this.pass(this.guardCfMat, this.guardTarget);
        }
        this.renderer.readRenderTargetPixels(all ? this.perTarget : this.statsTarget, 0, 0, 1, 1, px);
        total += performance.now() - t0;
      }
      return total / iterations;
    };
    run(true); run(false);  // warm-up
    return { baseMs: run(false), withPeriodicityMs: run(true) };
  }

  /** Called once at the start of every engagement episode. */
  onEngaged(cb: (info: LimiterInfo) => void): void { this.listeners.push(cb); }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** S8c local spectrum: window means, row DFT, power spectrum, then per peak a strip and a pick pass
   *  (the last pick writes the top-3 energy fraction per window, read by the reduce pass). */
  private spectrum(): void {
    this.pass(this.specStatsMat, this.specStatsTarget);
    this.pass(this.specRowMat, this.specRowTarget);
    this.pass(this.specColMat, this.specPowTarget);
    const [a, b] = this.specState;
    for (let q = 0; q < SPECTRAL_PEAKS; q++) {
      // state: pick q reads the state of pick q - 1 (none for q = 0) and writes the other one / the result
      const prev = q === 0 ? b : q % 2 === 1 ? a : b;
      const next = q === SPECTRAL_PEAKS - 1 ? this.specPeakTarget : q % 2 === 0 ? a : b;
      this.specStripMat.uniforms.uQ.value = q; this.specStripMat.uniforms.uState.value = prev.texture;
      this.pass(this.specStripMat, this.specStripTarget);
      this.specPickMat.uniforms.uQ.value = q; this.specPickMat.uniforms.uState.value = prev.texture;
      this.pass(this.specPickMat, next);
    }
  }

  private ensureHistory(w: number, h: number): void {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (this.history && this.histW === w && this.histH === h) return;
    const o = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    } as const;
    const oldHist = this.history; const oldEma = this.ema;
    this.history = [new THREE.WebGLRenderTarget(w, h, o), new THREE.WebGLRenderTarget(w, h, o)];
    this.ema = [new THREE.WebGLRenderTarget(w, h, o), new THREE.WebGLRenderTarget(w, h, o)];
    this.histW = w; this.histH = h;
    if (oldHist && oldEma && this.hasHistory) {
      // Resize (window or render scale): carry the previous output and EMA over (bilinear resample) so the
      // low-pass and slew keep acting across the resize. Resetting them showed one unfiltered frame per
      // resize, which let a flickering input through at 3.5 flashes/s under repeated resizes (attack-dynamics-r2).
      const p = 1 - this.cur;
      this.copyMat.uniforms.uSrc.value = oldHist[p].texture; this.pass(this.copyMat, this.history[p]);
      this.copyMat.uniforms.uSrc.value = oldEma[p].texture; this.pass(this.copyMat, this.ema[p]);
    } else {
      this.hasHistory = false;
    }
    if (oldHist) { oldHist[0].dispose(); oldHist[1].dispose(); }
    if (oldEma) { oldEma[0].dispose(); oldEma[1].dispose(); }
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
    this.perMat.uniforms.uInput.value = input;
    this.lumMat.uniforms.uInput.value = input;
    this.pass(this.tileMat, this.tileTarget);
    this.pass(this.lumMat, this.lumTarget);       // box-filtered luminance + mips (exact tile means)
    this.pass(this.tensorMat, this.tensorTarget); // structure tensor + mips (per-tile orientation, S8b)
    this.pass(this.statsMat, this.statsTarget);
    this.pass(this.perMat, this.profileTarget);  // periodicity score + stripe transitions per (tile, dir, scale)
    this.spectrum();                             // local spectrum per window (S8c)
    this.pass(this.reduceMat, this.perTarget);   // (sqrt minY, sqrt maxY, periodicity, pattern kinds) per tile
    this.pass(this.guardCfMat, this.guardTarget); // envelope-aware compression factor (S8b)
    r.readRenderTargetPixels(this.tileTarget, 0, 0, this.cols, this.rows, this.tileBuf);
    r.readRenderTargetPixels(this.perTarget, 0, 0, this.cols, this.rows, this.statsBuf);
    const n = this.nTiles;
    // pattern tile = periodic (p >= GUARD_PERIODICITY_MIN), stripes (S8b) or spectrally sparse (S8c): reduce
    // pass alpha >= 128 (bits 64 pixel stripe, 32 spectral, 16 grid stripe)
    let periodicRaw = 0; let stripeRaw = 0; let spectralRaw = 0;
    for (let i = 0; i < n; i++) {
      const p = this.statsBuf[4 * i + 2] / 255;
      const kinds = this.statsBuf[4 * i + 3];
      const any = kinds >= 128;
      const stripe = any && (kinds & (64 | 16)) !== 0;
      const spectral = any && (kinds & 32) !== 0;
      this.periodicity[i] = p;
      if (p >= GUARD_PERIODICITY_MIN) periodicRaw++;
      if (stripe) stripeRaw++;
      if (spectral) spectralRaw++;
      this.stripeRaw[i] = stripe ? 1 : 0;
      this.spectralRaw[i] = spectral ? 1 : 0;
      this.patternRaw[i] = p >= GUARD_PERIODICITY_MIN || any ? 1 : 0;
      this.profileRaw[i] = p >= GUARD_PERIODICITY_MIN || stripe ? 1 : 0;
    }
    // counted area: profile-based pattern tiles (periodic or stripe; each decided from one tile's profiles)
    // 3x3-dilated, the spectral tiles as they are (each already stands for a 4- or 8-tile window), plus the
    // tiles they fully enclose (the converging centre of a zone plate or sunburst, whose period changes too
    // fast for any profile, belongs to the pattern)
    dilateMask(this.profileRaw, this.cols, this.rows, 1, this.periodicMask);
    for (let i = 0; i < n; i++) if (this.spectralRaw[i]) this.periodicMask[i] = 1;
    fillEnclosed(this.periodicMask, this.cols, this.rows, this.fillScratch);
    let sum = 0; let hiContrast = 0; let contrastOnly = 0;
    for (let i = 0; i < n; i++) {
      const y = this.tileBuf[4 * i] / 255;
      const rf = this.tileBuf[4 * i + 1] >= 128 ? 1 : 0;
      this.lum[i] = y; sum += y; this.red[i] = rf;
      this.probes[2 * i] = this.tileBuf[4 * i + 2] / 255;
      this.probes[2 * i + 1] = this.tileBuf[4 * i + 3] / 255;
      this.probeRed[2 * i] = rf; this.probeRed[2 * i + 1] = rf;
      // sqrt-encoded neighbourhood min / max, decoded half a code step wider (never narrower than true)
      const mnS = Math.max(0, (this.statsBuf[4 * i] - 0.5) / 255);
      const mxS = Math.min(1, (this.statsBuf[4 * i + 1] + 0.5) / 255);
      const mn = mnS * mnS; const mx = mxS * mxS;
      if ((mx - mn) / Math.max(mx + mn, 1e-4) > GUARD_TILE_CONTRAST && mx - mn > GUARD_RANGE_MIN) {
        contrastOnly++;
        if (this.periodicMask[i]) hiContrast++;
      }
    }
    const mean = sum / n;
    this.lastMean = mean;
    this.lastGuardFraction = hiContrast / n;
    this.lastPeriodicFraction = periodicRaw / n;
    this.lastStripeFraction = stripeRaw / n;
    this.lastSpectralFraction = spectralRaw / n;
    this.lastContrastFraction = contrastOnly / n;

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
    // Per-tile compression weight: 1 on the pattern tiles (5x5-dilated, so the borders of a partly
    // detected pattern are covered too, S8b) and on the tiles they enclose (holes the analysis missed
    // inside a pattern), released over RELEASE_MS elsewhere, so a tile whose score hovers around the
    // threshold cannot toggle its compression frame to frame. Only used while the guard is on (uGuard),
    // and the guard engages only on high-contrast pattern area.
    dilateMask(this.patternRaw, this.cols, this.rows, 2, this.compressMask);
    fillEnclosed(this.compressMask, this.cols, this.rows, this.fillScratch);
    const rel = (dtClamped * 1000) / RELEASE_MS;
    for (let i = 0; i < n; i++) {
      const w = this.compressMask[i] ? 1 : Math.max(0, this.guardWeight[i] - rel);
      this.guardWeight[i] = w;
      this.guardMaskData[i] = Math.round(w * 255);
    }
    this.guardMaskTex.needsUpdate = true;

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
    uo.uSlewOn.value = maxDelta < 1 ? 1 : 0;
    if (maxDelta < 1) {
      // one step factor for the whole frame (S8c): the fade never creates contrast
      this.slewTileMat.uniforms.uEma.value = ema[this.cur].texture;
      this.slewTileMat.uniforms.uPrev.value = prev.texture;
      this.pass(this.slewTileMat, this.slewTileTarget);
      this.slewMat.uniforms.uMaxDelta.value = maxDelta;
      this.pass(this.slewMat, this.slewTarget);
    }
    this.pass(this.outMat, dst);
    this.blitMat.uniforms.uSrc.value = dst.texture;
    this.pass(this.blitMat, null);
    this.hasHistory = true;
    this.cur = 1 - this.cur;
  }

  dispose(): void {
    this.tileTarget.dispose(); this.statsTarget.dispose(); this.lumTarget.dispose(); this.profileTarget.dispose(); this.perTarget.dispose();
    this.tensorTarget.dispose(); this.guardTarget.dispose(); this.tensorMat.dispose(); this.guardCfMat.dispose();
    for (const t of [this.specStatsTarget, this.specRowTarget, this.specPowTarget, this.specStripTarget, ...this.specState,
      this.specPeakTarget, this.slewTileTarget, this.slewTarget]) t.dispose();
    for (const m of [this.specStatsMat, this.specRowMat, this.specColMat, this.specStripMat, this.specPickMat, this.slewTileMat,
      this.slewMat]) m.dispose();
    this.guardMaskTex.dispose();
    if (this.history) { this.history[0].dispose(); this.history[1].dispose(); }
    if (this.ema) { this.ema[0].dispose(); this.ema[1].dispose(); }
    this.tileMat.dispose(); this.statsMat.dispose(); this.lumMat.dispose(); this.perMat.dispose(); this.reduceMat.dispose(); this.emaMat.dispose(); this.outMat.dispose();
    this.blitMat.dispose(); this.copyMat.dispose();
    this.quad.geometry.dispose();
  }
}
