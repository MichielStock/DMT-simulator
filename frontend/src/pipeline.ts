// RenderPipeline: owns the WebGLRenderer, the half-float scene target and the ordered layer list.
// The LAST operation of every render() is ALWAYS SafetyLimiter.render(), which draws to the screen
// (BUILD.md §4.1). There is no option or method that removes, reorders or skips it.
import * as THREE from 'three';
import { SafetyLimiter } from './safety/safetyLimiter';

export const LIMITER_PASS = 'SafetyLimiter' as const;

/** A visual layer. Layers composite into the shared (linear RGB) scene target in order. */
export interface Layer<S = any> {
  name: string;
  init(renderer: THREE.WebGLRenderer, state: S): void;
  resize(w: number, h: number): void;
  render(renderer: THREE.WebGLRenderer, state: S, target: THREE.WebGLRenderTarget | null): void;
  dispose(): void;
}

export interface PipelineOptions {
  /** Debug mode (?debug=1). Has no effect on the SafetyLimiter. */
  debug?: boolean;
  /** Initial render scale, clamped to 0.5–1.0. */
  renderScale?: number;
  /** Cap on devicePixelRatio (default 2). */
  maxPixelRatio?: number;
  /** Inject a renderer (tests). Defaults to a new THREE.WebGLRenderer on `canvas`. */
  renderer?: THREE.WebGLRenderer;
}

export class RenderPipeline<S = any> {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly limiter: SafetyLimiter;
  readonly debug: boolean;
  private readonly layers: Layer<S>[] = [];
  private readonly initialised = new Set<Layer<S>>();
  private sceneTarget: THREE.WebGLRenderTarget;
  private scale: number;
  private readonly maxPixelRatio: number;
  private w = 1;
  private h = 1;
  private lastState: S | undefined;

  constructor(canvas: HTMLCanvasElement, opts: PipelineOptions = {}) {
    this.canvas = canvas;
    this.debug = !!opts.debug;
    this.scale = clampScale(opts.renderScale ?? 1);
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.renderer = opts.renderer ?? new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.limiter = new SafetyLimiter(this.renderer);
    this.resize();
    if (typeof window !== 'undefined' && !opts.renderer) window.addEventListener('resize', () => this.resize());
  }

  /** Names of the passes in execution order; always ends with 'SafetyLimiter'. */
  get passes(): readonly string[] {
    return Object.freeze([...this.layers.map((l) => l.name), LIMITER_PASS]);
  }

  get renderScale(): number { return this.scale; }
  get width(): number { return this.w; }
  get height(): number { return this.h; }
  get sceneSize(): { width: number; height: number } {
    return { width: this.sceneTarget.width, height: this.sceneTarget.height };
  }

  addLayer(layer: Layer<S>): void {
    if (this.layers.includes(layer)) return;
    this.layers.push(layer);
    if (this.lastState !== undefined) this.initLayer(layer, this.lastState);
  }

  private initLayer(layer: Layer<S>, state: S): void {
    if (this.initialised.has(layer)) return;
    layer.init(this.renderer, state);
    layer.resize(this.sceneTarget.width, this.sceneTarget.height);
    this.initialised.add(layer);
  }

  /** Render one frame: layers into the scene target, then (always, last) the SafetyLimiter to the screen. */
  render(state: S): void {
    this.lastState = state;
    const r = this.renderer;
    try {
      r.setRenderTarget(this.sceneTarget);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      for (const layer of this.layers) {
        try {
          this.initLayer(layer, state);
          r.setRenderTarget(this.sceneTarget);
          layer.render(r, state, this.sceneTarget);
        } catch (e) {
          console.error(`layer ${layer.name} failed`, e);
        }
      }
    } finally {
      this.limiter.render(this.sceneTarget.texture, this.w, this.h);
    }
  }

  /** Re-read the canvas size (CSS px x capped devicePixelRatio) and resize everything. */
  resize(): void {
    const dpr = Math.min(this.maxPixelRatio,
      typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    this.w = Math.max(1, Math.round(cssW * dpr));
    this.h = Math.max(1, Math.round(cssH * dpr));
    this.renderer.setSize(this.w, this.h, false);
    this.resizeScene();
  }

  private resizeScene(): void {
    const sw = Math.max(1, Math.round(this.w * this.scale));
    const sh = Math.max(1, Math.round(this.h * this.scale));
    this.sceneTarget.setSize(sw, sh);
    for (const layer of this.initialised) layer.resize(sw, sh);
  }

  /** Adaptive render scale for the scene target (0.5–1.0). The limiter always runs at full size. */
  setRenderScale(s: number): void {
    const c = clampScale(s);
    if (c === this.scale) return;
    this.scale = c;
    this.resizeScene();
  }

  /** PNG of the final on-screen framebuffer (after the SafetyLimiter). */
  captureFrame(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
  }

  dispose(): void {
    for (const l of this.layers) { try { l.dispose(); } catch { /* ignore */ } }
    this.sceneTarget.dispose();
    this.limiter.dispose();
    this.renderer.dispose();
  }
}

function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(1, Math.max(0.5, s));
}
