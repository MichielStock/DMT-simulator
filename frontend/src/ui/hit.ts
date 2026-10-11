// The hit (BUILD.md section 8.4) and repeat hits during the trip (section 7.5).
// Hold space (or the on-screen button) for up to 4 s: hold_fraction = min(1, held / 4).

import { onKey } from './dom';

export const HOLD_MAX_S = 4;
export const MAX_REPEAT_HITS = 3;
export const REPEAT_BLOCK_VISUAL = 3;
export const BLOCKED_CUE = 'Too deep to hold the pipe.';

export interface HitResult { holdFraction: number; heldS: number }

/** Tracks one hold of space / pointer. Wall-clock seconds (the hit is a real-time gesture). */
class Hold {
  private t0: number | null = null;
  start(): boolean {
    if (this.t0 !== null) return false;
    this.t0 = performance.now();
    return true;
  }
  get active(): boolean { return this.t0 !== null; }
  elapsedS(): number { return this.t0 === null ? 0 : (performance.now() - this.t0) / 1000; }
  stop(): number {
    const s = this.elapsedS();
    this.t0 = null;
    return Math.min(HOLD_MAX_S, s);
  }
}

export const holdFraction = (heldS: number) => Math.max(0, Math.min(1, heldS / HOLD_MAX_S));

export interface HitHooks {
  /** false while the session is still being prepared: Space then only triggers `onEarly` */
  armed: () => boolean;
  onEarly: () => void;
  /** the hold started (Space down or pointer down on `btn`) */
  onBegin: () => void;
}

/** The hold logic of the hit, bound to Space and to the on-screen button `btn`.
 *  Resolves once with hold_fraction = min(1, held / 4) when Space / the pointer is released or 4 s pass.
 *  Key handlers are screen handlers (removed when the next screen mounts). */
export function bindHit(btn: HTMLElement, hooks: HitHooks): Promise<HitResult> {
  const hold = new Hold();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const begin = () => {
      if (finished) return;
      if (!hooks.armed()) { hooks.onEarly(); return; }
      if (!hold.start()) return;
      hooks.onBegin();
      timer = setTimeout(end, HOLD_MAX_S * 1000);
    };
    const end = () => {
      if (finished || !hold.active) return;
      finished = true;
      if (timer) clearTimeout(timer);
      const heldS = hold.stop();
      off();
      offUp();
      resolve({ heldS, holdFraction: holdFraction(heldS) });
    };
    const off = onKey((e) => {
      if (e.key === ' ') { e.preventDefault(); if (!e.repeat) begin(); }
    });
    const offUp = onKey((e) => { if (e.key === ' ') end(); }, 'keyup');
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); begin(); });
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('pointercancel', end);
  });
}

export interface RepeatHitDeps {
  visual: () => number;
  /** apply the dose; returns false if the model refused it */
  apply: (holdFraction: number) => boolean;
  logHit: (holdFraction: number, n: number) => void;
  logBlocked: (reason: string) => void;
  cue: (text: string, ms: number) => void;
}

/** Repeat hits during the trip: H key or the faint hit button. Blocked while visual ≥ 3; max 3. */
export class RepeatHits {
  count = 0;
  private hold = new Hold();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: RepeatHitDeps) {}

  press(): void {
    if (this.hold.active) return;
    if (this.count >= MAX_REPEAT_HITS) {
      this.deps.logBlocked('max_repeats');
      this.deps.cue(BLOCKED_CUE, 2000);
      return;
    }
    if (this.deps.visual() >= REPEAT_BLOCK_VISUAL) {
      this.deps.logBlocked('too_deep');
      this.deps.cue(BLOCKED_CUE, 2000);
      return;
    }
    this.hold.start();
    this.deps.cue('Hold…', HOLD_MAX_S * 1000);
    this.timer = setTimeout(() => this.release(), HOLD_MAX_S * 1000);
  }

  release(): void {
    if (!this.hold.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const f = holdFraction(this.hold.stop());
    this.deps.cue('', 0);
    // re-check at release: the model may have crossed the block while the user was holding
    if (this.deps.visual() >= REPEAT_BLOCK_VISUAL || !this.deps.apply(f)) {
      this.deps.logBlocked('too_deep');
      this.deps.cue(BLOCKED_CUE, 2000);
      return;
    }
    this.count++;
    this.deps.logHit(f, this.count);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.hold.active) this.hold.stop();
  }
}
