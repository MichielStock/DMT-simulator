// Adaptive render scale (0.5–1.0) targeting 60 fps: EMA of the frame time, step ±0.05 every 60 frames.

export const QUALITY = { min: 0.5, max: 1.0, step: 0.05, frames: 60, targetMs: 1000 / 60, emaAlpha: 0.05 };

export class AdaptiveQuality {
  scale = 1.0;
  ema = QUALITY.targetMs;
  private n = 0;

  constructor(private apply: (scale: number) => void, initial = 1.0) {
    this.scale = initial;
  }

  /** Feed one frame time in milliseconds (wall clock). Returns the current scale. */
  frame(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 250) return this.scale; // ignore stalls (tab hidden)
    this.ema += QUALITY.emaAlpha * (ms - this.ema);
    if (++this.n >= QUALITY.frames) {
      this.n = 0;
      let next = this.scale;
      if (this.ema > QUALITY.targetMs * 1.15) next -= QUALITY.step;
      else if (this.ema < QUALITY.targetMs * 1.05) next += QUALITY.step;
      next = Math.min(QUALITY.max, Math.max(QUALITY.min, Math.round(next * 100) / 100));
      if (next !== this.scale) {
        this.scale = next;
        this.apply(next);
      }
    }
    return this.scale;
  }
}
