// Pure TypeScript flash detector (no WebGL). Fed once per frame with per-tile relative luminance
// and saturated-red flags; decides when the SafetyLimiter must engage. See BUILD.md §4.1.
//
// Criterion implemented (deliberately stricter than the 3-flashes-per-second ceiling):
//  - Each signal (every tile, plus the whole-frame mean) runs a hysteresis extremum tracker.
//    A *transition* is a change of >= FLASH_DELTA between successive local extrema whose darker
//    state is < DARK_MAX. Successive transitions always alternate in direction (opposing).
//  - General: a signal qualifies when it has ENGAGE_AT opposing transitions inside the sliding
//    WINDOW_MS window, i.e. ENGAGE_AT + 1 = 3 transitions (1.5 flashes; the ceiling is 3 flashes).
//    Engage when more than AREA_FRACTION of the tiles qualify, OR the whole-frame mean qualifies.
//  - Red: tiles flagged saturated red (R/(R+G+B) >= RED_SAT, R > RED_MIN_R) at either end of a
//    transition use the lower RED_DELTA and qualify at the first opposing pair (2 transitions).
//    The whole frame counts as red while more than AREA_FRACTION of tiles are red.
//  - Once engaged, stays engaged until a full WINDOW_MS passes with no qualifying frame.
import {
  AREA_FRACTION, DARK_MAX, ENGAGE_AT, FLASH_DELTA, RED_DELTA, RED_ENGAGE_TRANSITIONS, WINDOW_MS,
} from './thresholds';

export type FlashKind = 'general' | 'red';
export interface FlashResult { engage: boolean; kind: FlashKind | null; tiles: number }

const RING = 4; // we never need more than the last 4 transition times per signal

/** Hysteresis extremum tracker for N independent signals; records transition timestamps. */
export class TransitionTracker {
  readonly n: number;
  private readonly delta: number;
  private readonly darkMax: number;
  private readonly requireRed: boolean;
  private readonly dir: Int8Array;
  private readonly ext: Float32Array;
  private readonly lo: Float32Array;
  private readonly hi: Float32Array;
  private readonly extRed: Uint8Array;
  private readonly loRed: Uint8Array;
  private readonly hiRed: Uint8Array;
  private readonly times: Float64Array;
  private readonly head: Uint8Array;
  private started = false;

  constructor(n: number, delta: number, darkMax: number, requireRed: boolean) {
    this.n = n; this.delta = delta; this.darkMax = darkMax; this.requireRed = requireRed;
    this.dir = new Int8Array(n); this.ext = new Float32Array(n);
    this.lo = new Float32Array(n); this.hi = new Float32Array(n);
    this.extRed = new Uint8Array(n); this.loRed = new Uint8Array(n); this.hiRed = new Uint8Array(n);
    this.times = new Float64Array(n * RING).fill(-Infinity);
    this.head = new Uint8Array(n);
  }

  reset(): void {
    this.started = false; this.dir.fill(0); this.times.fill(-Infinity); this.head.fill(0);
  }

  private record(i: number, t: number): void {
    this.times[i * RING + this.head[i]] = t;
    this.head[i] = (this.head[i] + 1) % RING;
  }

  /** Number of recorded transitions of signal i with tMs - t < WINDOW_MS. */
  count(i: number, tMs: number): number {
    let c = 0;
    for (let k = 0; k < RING; k++) if (tMs - this.times[i * RING + k] < WINDOW_MS) c++;
    return c;
  }

  update(values: ArrayLike<number>, red: ArrayLike<number> | null, tMs: number): void {
    const n = this.n;
    if (!this.started) {
      for (let i = 0; i < n; i++) {
        const v = values[i]; const r = red && red[i] ? 1 : 0;
        this.dir[i] = 0; this.lo[i] = v; this.hi[i] = v; this.loRed[i] = r; this.hiRed[i] = r;
      }
      this.started = true;
      return;
    }
    const d = this.delta;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const r = red && red[i] ? 1 : 0;
      const dir = this.dir[i];
      if (dir === 0) {
        if (v < this.lo[i]) { this.lo[i] = v; this.loRed[i] = r; }
        if (v > this.hi[i]) { this.hi[i] = v; this.hiRed[i] = r; }
        if (v - this.lo[i] >= d) {            // rising transition from lo
          this.turn(i, +1, v, r, this.lo[i], this.loRed[i], tMs);
        } else if (this.hi[i] - v >= d) {     // falling transition from hi
          this.turn(i, -1, v, r, this.hi[i], this.hiRed[i], tMs);
        }
      } else if (dir > 0) {
        if (v >= this.ext[i]) { this.ext[i] = v; this.extRed[i] = r; }
        else if (this.ext[i] - v >= d) this.turn(i, -1, v, r, this.ext[i], this.extRed[i], tMs);
      } else {
        if (v <= this.ext[i]) { this.ext[i] = v; this.extRed[i] = r; }
        else if (v - this.ext[i] >= d) this.turn(i, +1, v, r, this.ext[i], this.extRed[i], tMs);
      }
    }
  }

  private turn(i: number, newDir: 1 | -1, v: number, r: number, from: number, fromRed: number, tMs: number): void {
    const darker = Math.min(v, from);
    const qualifies = darker < this.darkMax && (!this.requireRed || r === 1 || fromRed === 1);
    if (qualifies) this.record(i, tMs);
    this.dir[i] = newDir; this.ext[i] = v; this.extRed[i] = r;
  }
}

export interface FlashDetectorOptions { tiles: number }

export class FlashDetector {
  readonly tiles: number;
  private readonly general: TransitionTracker;
  private readonly red: TransitionTracker;
  private readonly globalGeneral: TransitionTracker;
  private readonly globalRed: TransitionTracker;
  private readonly g1 = new Float32Array(1);
  private readonly r1 = new Uint8Array(1);
  private engagedState = false;
  private kindState: FlashKind | null = null;
  private lastQualifyMs = -Infinity;

  constructor(opts: FlashDetectorOptions) {
    this.tiles = opts.tiles;
    this.general = new TransitionTracker(opts.tiles, FLASH_DELTA, DARK_MAX, false);
    this.red = new TransitionTracker(opts.tiles, RED_DELTA, Infinity, true);
    this.globalGeneral = new TransitionTracker(1, FLASH_DELTA, DARK_MAX, false);
    this.globalRed = new TransitionTracker(1, RED_DELTA, Infinity, true);
  }

  get engaged(): boolean { return this.engagedState; }

  reset(): void {
    this.general.reset(); this.red.reset(); this.globalGeneral.reset(); this.globalRed.reset();
    this.engagedState = false; this.kindState = null; this.lastQualifyMs = -Infinity;
  }

  push(tileLuminance: Float32Array, tileRedFlags: Uint8Array, tMs: number): FlashResult {
    const n = this.tiles;
    let sum = 0; let redTiles = 0;
    for (let i = 0; i < n; i++) { sum += tileLuminance[i]; if (tileRedFlags[i]) redTiles++; }
    this.g1[0] = sum / n;
    this.r1[0] = redTiles / n > AREA_FRACTION ? 1 : 0;

    this.general.update(tileLuminance, tileRedFlags, tMs);
    this.red.update(tileLuminance, tileRedFlags, tMs);
    this.globalGeneral.update(this.g1, this.r1, tMs);
    this.globalRed.update(this.g1, this.r1, tMs);

    const generalNeed = ENGAGE_AT + 1;
    let gTiles = 0; let rTiles = 0; let anyTiles = 0;
    for (let i = 0; i < n; i++) {
      const g = this.general.count(i, tMs) >= generalNeed;
      const r = this.red.count(i, tMs) >= RED_ENGAGE_TRANSITIONS;
      if (g) gTiles++;
      if (r) rTiles++;
      if (g || r) anyTiles++;
    }
    const globalG = this.globalGeneral.count(0, tMs) >= generalNeed;
    const globalR = this.globalRed.count(0, tMs) >= RED_ENGAGE_TRANSITIONS;
    const areaHit = anyTiles / n > AREA_FRACTION;
    const qualifies = areaHit || globalG || globalR;

    if (qualifies) {
      this.lastQualifyMs = tMs;
      if (!this.engagedState) {
        this.engagedState = true;
        this.kindState = (globalR || rTiles > gTiles) ? 'red' : 'general';
      }
    } else if (this.engagedState && tMs - this.lastQualifyMs >= WINDOW_MS) {
      this.engagedState = false;
      this.kindState = null;
    }
    const tiles = anyTiles;
    return { engage: this.engagedState, kind: this.kindState, tiles };
  }
}
