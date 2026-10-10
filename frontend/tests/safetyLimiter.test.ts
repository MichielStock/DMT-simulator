// PROTECTED (BUILD.md §0.7, §16.2 "Safety"): photosensitivity limiter unit tests.
import { describe, expect, it } from 'vitest';
import { FlashDetector } from '../src/safety/flashDetector';
import {
  SafetyLimiter, capMeanLuminance, limiterParams, stepLuminance, type LimiterInfo,
} from '../src/safety/safetyLimiter';
import { DARK_MAX, FLASH_DELTA, MAX_FLASHES_PER_S, TILE_GRID, WINDOW_MS } from '../src/safety/thresholds';

const N = TILE_GRID[0] * TILE_GRID[1];
const RED_Y = 0.2126;

type Frame = { lum: number; red: boolean; frac?: number };

/** Feed a full-screen (or partial) signal to a detector at `fps`; returns per-frame results. */
function drive(det: FlashDetector, fn: (tS: number) => Frame, seconds: number, fps = 60, t0 = 0) {
  const lum = new Float32Array(N);
  const red = new Uint8Array(N);
  const out: Array<{ t: number; engage: boolean; kind: string | null }> = [];
  for (let f = 0; f <= Math.round(seconds * fps); f++) {
    const tS = t0 + f / fps;
    const fr = fn(tS);
    const k = Math.round((fr.frac ?? 1) * N);
    for (let i = 0; i < N; i++) {
      lum[i] = i < k ? fr.lum : 0.3;
      red[i] = i < k && fr.red ? 1 : 0;
    }
    const r = det.push(lum, red, tS * 1000);
    out.push({ t: tS, engage: r.engage, kind: r.kind });
  }
  return out;
}

const square = (hz: number, hi: number, lo: number) => (t: number) =>
  (Math.floor(t * hz * 2 + 1e-9) % 2 === 0 ? hi : lo);

describe('FlashDetector', () => {
  it('engages on a 10 Hz full-screen black/white square wave within the first 3 transitions', () => {
    const det = new FlashDetector({ tiles: N });
    const s = square(10, 1, 0);
    const res = drive(det, (t) => ({ lum: s(t), red: false }), 1);
    const first = res.find((r) => r.engage);
    expect(first).toBeDefined();
    // transitions happen at 50, 100, 150 ms: engaged no later than the third one
    expect(first!.t).toBeLessThanOrEqual(0.15 + 1e-6);
    expect(first!.kind).toBe('general');
    expect(res.filter((r) => r.t > 0.2).every((r) => r.engage)).toBe(true);
  });

  it('never engages on a 1 Hz full-screen square wave', () => {
    const det = new FlashDetector({ tiles: N });
    const s = square(1, 1, 0);
    const res = drive(det, (t) => ({ lum: s(t), red: false }), 6);
    expect(res.some((r) => r.engage)).toBe(false);
  });

  it('never engages on a soft 0.5 Hz pulse', () => {
    const det = new FlashDetector({ tiles: N });
    const res = drive(det, (t) => ({ lum: 0.5 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t), red: false }), 8);
    expect(res.some((r) => r.engage)).toBe(false);
  });

  it('engages on a saturated-red 8 Hz flicker as a red flash', () => {
    const det = new FlashDetector({ tiles: N });
    const res = drive(det, (t) => {
      const on = square(8, 1, 0)(t) === 1;
      return { lum: on ? RED_Y : 0, red: on };
    }, 1);
    const first = res.find((r) => r.engage);
    expect(first).toBeDefined();
    expect(first!.kind).toBe('red');
    // transitions at 62.5 and 125 ms (sampled on the next 60 fps frame): engaged at the second one
    expect(first!.t).toBeLessThanOrEqual(0.125 + 1 / 60 + 1e-6);
  });

  it('applies the stricter red rule: a red pulse too small for the general rule still engages', () => {
    const det = new FlashDetector({ tiles: N });
    // luminance swings 0.07 (< FLASH_DELTA) but the tiles are saturated red
    const res = drive(det, (t) => ({ lum: square(6, 0.2126, 0.14)(t), red: true }), 1);
    expect(res.some((r) => r.engage && r.kind === 'red')).toBe(true);
    const det2 = new FlashDetector({ tiles: N });
    const res2 = drive(det2, (t) => ({ lum: square(6, 0.2126, 0.14)(t), red: false }), 1);
    expect(res2.some((r) => r.engage)).toBe(false);
  });

  it('engages when more than 25% of the area flickers even if the whole-frame change is small', () => {
    const det = new FlashDetector({ tiles: N });
    // 30% of tiles flicker 0.25 <-> 0.4; global mean moves only 0.045
    const res = drive(det, (t) => ({ lum: square(10, 0.4, 0.25)(t), red: false, frac: 0.3 }), 1);
    expect(res.some((r) => r.engage)).toBe(true);
  });

  it('ignores a small flickering region', () => {
    const det = new FlashDetector({ tiles: N });
    const res = drive(det, (t) => ({ lum: square(10, 0.4, 0.3)(t), red: false, frac: 0.1 }), 2);
    expect(res.some((r) => r.engage)).toBe(false);
  });

  it('ignores flicker between two bright states (darker state >= 0.80)', () => {
    const det = new FlashDetector({ tiles: N });
    const res = drive(det, (t) => ({ lum: square(10, 0.98, 0.85)(t), red: false }), 2);
    expect(res.some((r) => r.engage)).toBe(false);
    expect(DARK_MAX).toBe(0.8);
  });

  it('recovers after the pattern stops', () => {
    const det = new FlashDetector({ tiles: N });
    const s = square(10, 1, 0);
    const a = drive(det, (t) => ({ lum: s(t), red: false }), 2);
    expect(a.at(-1)!.engage).toBe(true);
    const b = drive(det, () => ({ lum: 0.3, red: false }), 2, 60, 2 + 1 / 60);
    // still engaged right after stopping; released once the last qualifying transitions have left the
    // window AND a further full window has passed with no qualifying frame (at most 2 windows).
    expect(b[0].engage).toBe(true);
    const release = b.find((r) => !r.engage);
    expect(release).toBeDefined();
    expect(release!.t - 2).toBeGreaterThanOrEqual(WINDOW_MS / 1000);
    expect(release!.t - 2).toBeLessThanOrEqual((2 * WINDOW_MS) / 1000 + 0.1);
    expect(b.at(-1)!.engage).toBe(false);
  });
});

// ---- SafetyLimiter with a mocked renderer ------------------------------------------------------
class MockRenderer {
  calls = 0;
  y = 0;
  redOn = false;
  setRenderTarget() { /* noop */ }
  render() { /* noop */ }
  readRenderTargetPixels(_t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) {
    const tile = this.calls++ % 2 === 0;
    const Y = Math.round(this.y * 255);
    for (let i = 0; i < w * h; i++) {
      if (tile) { buf[4 * i] = Y; buf[4 * i + 1] = this.redOn ? 255 : 0; buf[4 * i + 2] = Y; buf[4 * i + 3] = Y; }
      else { buf[4 * i] = Y; buf[4 * i + 1] = Y; buf[4 * i + 2] = 255; buf[4 * i + 3] = Y; }
    }
  }
}

function runLimiter(pattern: (t: number) => { y: number; red: boolean }, seconds: number, fps = 60) {
  const mock = new MockRenderer();
  let now = 0;
  const lim = new SafetyLimiter(mock as any, { now: () => now });
  const infos: LimiterInfo[] = [];
  lim.onEngaged((i) => infos.push(i));
  const engagedAt: number[] = [];
  for (let f = 0; f <= seconds * fps; f++) {
    now = (f / fps) * 1000;
    const p = pattern(f / fps);
    mock.y = p.y; mock.redOn = p.red;
    lim.render({} as any, 64, 36);
    if (lim.engaged) engagedAt.push(f / fps);
  }
  return { lim, infos, engagedAt };
}

describe('SafetyLimiter', () => {
  it('engages once per episode on a 10 Hz flicker and reports a general flash', () => {
    const s = square(10, 1, 0);
    const { infos, engagedAt, lim } = runLimiter((t) => ({ y: s(t), red: false }), 3);
    expect(infos.length).toBe(1);
    expect(infos[0].kind).toBe('general');
    expect(infos[0].tiles).toBeGreaterThan(0);
    expect(engagedAt[0]).toBeLessThanOrEqual(0.15 + 1e-6);
    expect(lim.engaged).toBe(true);
  });

  it('reports a red flash for saturated-red 8 Hz', () => {
    const s = square(8, 1, 0);
    const { infos } = runLimiter((t) => ({ y: s(t) ? RED_Y : 0, red: s(t) === 1 }), 2);
    expect(infos.length).toBe(1);
    expect(infos[0].kind).toBe('red');
  });

  it('does not engage on static content or a slow pulse', () => {
    expect(runLimiter(() => ({ y: 0.4, red: false }), 3).infos.length).toBe(0);
    expect(runLimiter((t) => ({ y: 0.5 + 0.3 * Math.sin(Math.PI * t), red: false }), 5).infos.length).toBe(0);
  });

  it('has no disable / bypass / skip path', () => {
    const names = Object.getOwnPropertyNames(SafetyLimiter.prototype).map((n) => n.toLowerCase());
    for (const n of names) expect(/disable|bypass|skip|off$/.test(n)).toBe(false);
  });
});

describe('limiter output (CPU reference of the output pass)', () => {
  /** Simulate the output luminance of a full-screen input through detection + output pass. */
  function simulate(input: (t: number) => number, seconds: number, fps: number) {
    const det = new FlashDetector({ tiles: 1 });
    const lum = new Float32Array(1); const red = new Uint8Array(1);
    const st = { ema: input(0), out: input(0) }; let strength = 0;
    const out: number[] = [];
    for (let f = 0; f <= seconds * fps; f++) {
      const t = f / fps; const y = input(t);
      lum[0] = y;
      const r = det.push(lum, red, t * 1000);
      strength = r.engage ? 1 : Math.max(0, strength - 1 / fps);
      const { k, maxDelta } = limiterParams(1 / fps, strength);
      if (f > 0) stepLuminance(st, y, k, maxDelta);
      out.push(st.out);
    }
    return out;
  }

  function countTransitions(sig: number[], fps: number) {
    const times: number[] = [];
    // Independent extremum walk (same definition as flashcheck.py):
    let dir = 0; let ext = sig[0]; let lo = sig[0]; let hi = sig[0];
    sig.forEach((y, f) => {
      if (dir === 0) {
        lo = Math.min(lo, y); hi = Math.max(hi, y);
        if (y - lo >= FLASH_DELTA) { dir = 1; ext = y; times.push(f / fps); }
        else if (hi - y >= FLASH_DELTA) { dir = -1; ext = y; times.push(f / fps); }
      } else if (dir > 0) {
        if (y >= ext) ext = y; else if (ext - y >= FLASH_DELTA) { dir = -1; ext = y; times.push(f / fps); }
      } else if (y <= ext) ext = y; else if (y - ext >= FLASH_DELTA) { dir = 1; ext = y; times.push(f / fps); }
    });
    let maxPerWindow = 0;
    for (const t0 of times) maxPerWindow = Math.max(maxPerWindow, times.filter((t) => t >= t0 && t - t0 < 1).length);
    return { times, maxFlashesPerS: maxPerWindow / 2 };
  }

  for (const fps of [60, 30, 144]) {
    it(`damps a 10 Hz full-amplitude flicker at ${fps} fps: residual < 0.10, flashes well below the ceiling`, () => {
      const out = simulate(square(10, 1, 0), 6, fps);
      // after engaging, the output glides (<= 0.2/s, a single slow transition) to the temporal mean;
      // once there, the remaining oscillation must be far below FLASH_DELTA
      const tail = out.slice(Math.round(3.5 * fps));
      let worst = 0;
      for (let i = 0; i + fps <= tail.length; i++) {
        const w = tail.slice(i, i + fps);
        worst = Math.max(worst, Math.max(...w) - Math.min(...w));
      }
      expect(worst).toBeLessThan(0.1);
      // settles toward the temporal mean (mid-grey), not a frozen black or white frame
      const sq = square(10, 1, 0);
      let mean = 0;
      for (let f = 5 * fps; f < 6 * fps; f++) mean += sq(f / fps) / fps;
      expect(Math.abs(out.at(-1)! - mean)).toBeLessThan(0.1);
      const { maxFlashesPerS } = countTransitions(out, fps);
      expect(maxFlashesPerS).toBeLessThanOrEqual(1.5);
      expect(maxFlashesPerS).toBeLessThan(MAX_FLASHES_PER_S);
    });
  }

  it('passes slow content through unchanged', () => {
    const input = (t: number) => 0.5 + 0.3 * Math.sin(2 * Math.PI * 0.5 * t);
    const out = simulate(input, 4, 60);
    out.forEach((y, f) => expect(Math.abs(y - input(f / 60))).toBeLessThan(1e-9));
  });

  it('caps mean luminance: no full-screen near-white', () => {
    expect(capMeanLuminance(1)).toBeLessThanOrEqual(0.8);
    expect(capMeanLuminance(0.9)).toBeLessThan(0.8);
    expect(capMeanLuminance(0.5)).toBe(0.5);
    let prev = 0;
    for (let m = 0; m <= 1; m += 0.01) { const c = capMeanLuminance(m); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
  });

  it('low-pass factor never exceeds 0.15 when engaged', () => {
    for (const fps of [10, 20, 30, 60, 144, 240]) {
      const { k, maxDelta } = limiterParams(1 / fps, 1);
      expect(k).toBeLessThanOrEqual(0.15);
      expect(maxDelta).toBeLessThanOrEqual(0.2 / 20 + 1e-9);
    }
    expect(limiterParams(1 / 60, 0)).toEqual({ k: 1, maxDelta: 1 });
  });
});
