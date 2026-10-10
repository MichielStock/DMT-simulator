// Grounding ambient (BUILD.md §13.1 "soft ambient sound") and the exit tone (§4.2 "a soft tone").
// Both feed the master safety chain. Ambient: a warm, low open-fifth drone over brown-ish air
// noise, fading in and out over seconds. Exit tone: a soft descending major third over 3 s
// (E4 → C4 sine-ish notes, 0.9 s dB-linear swells from −40 dB: ≤ 9 dB per 200 ms even from silence).

import { dbToGain, swellCurve } from './synth';

export interface Ambient {
  set(on: boolean): void;
  dispose(): void;
}

export const AMBIENT_FADE_S = 4;
/** Ambient bus level: soft, about −31 dBFS RMS. */
export const AMBIENT_LEVEL = 0.5;

/**
 * Fade a gain param in dB-linear steps: from max(current, −60 dB) to `target` over `dur` s
 * (60 dB in 4 s = 15 dB/s). Fading to 0 ends at −80 dB and then holds 0.
 */
export function expFade(param: AudioParam, target: number, now: number, dur: number): void {
  const FLOOR = 1e-3;
  param.cancelScheduledValues(now);
  const cur = Math.max(param.value, (target > 0 ? target : 1) * FLOOR);
  param.setValueAtTime(cur, now);
  if (target > 0) {
    param.exponentialRampToValueAtTime(target, now + dur);
  } else {
    param.exponentialRampToValueAtTime(1e-4, now + dur);
    param.setValueAtTime(0, now + dur + 0.01);
  }
}

export function createAmbient(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): Ambient {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(out);
  let started = false;
  const nodes: AudioScheduledSourceNode[] = [];
  function build(): void {
    started = true;
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    // air: white noise through two cascaded low-passes (24 dB/oct at 320 Hz) ≈ a soft brown rumble
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 0.5;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 320;
    lp2.Q.value = 0.5;
    const ng = ctx.createGain();
    ng.gain.value = dbToGain(-22);
    n.connect(lp).connect(lp2).connect(ng).connect(bus);
    n.start();
    nodes.push(n);
    // A2, E3, A3, C#4 very soft: warm major colour
    const notes: Array<[number, number]> = [[110, -30], [164.81, -34], [220, -38], [277.18, -44]];
    for (const [f, db] of notes) {
      for (const det of [-4, 4]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = dbToGain(db - 3);
        o.connect(g).connect(bus);
        o.start();
        nodes.push(o);
      }
    }
  }
  return {
    set(on: boolean) {
      if (on && !started) build();
      expFade(bus.gain, on ? AMBIENT_LEVEL : 0, ctx.currentTime, AMBIENT_FADE_S);
    },
    dispose() {
      for (const n of nodes) { try { n.stop(); } catch { /* ok */ } }
      bus.disconnect();
    },
  };
}

export const EXIT_TONE_S = 3;
/** Notes of the exit tone: a descending major third, E4 → C4. */
export const EXIT_NOTES = [329.63, 261.63];

export function playExitTone(ctx: BaseAudioContext, out: AudioNode, at = ctx.currentTime + 0.02): void {
  const plan: Array<{ f: number; start: number; attack: number; release: number }> = [
    { f: EXIT_NOTES[0], start: 0, attack: 0.9, release: 1.2 },
    { f: EXIT_NOTES[1], start: 0.8, attack: 0.9, release: 1.3 },
  ];
  for (const p of plan) {
    const t = at + p.start;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueCurveAtTime(swellCurve(p.attack, p.release, dbToGain(-24), -40), t, p.attack + p.release);
    g.connect(out);
    for (const [mult, lvl] of [[1, 1], [2, 0.18], [3, 0.05]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = p.f * mult;
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + p.attack + p.release + 0.05);
      o.onended = () => { og.disconnect(); if (mult === 1) g.disconnect(); };
    }
  }
}
