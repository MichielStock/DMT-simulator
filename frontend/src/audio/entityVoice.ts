// Entity "voices" (BUILD.md §12): granular, vowel-like formant textures, never words. Three voices,
// each a band-limited pulse train plus breath noise through a parallel bank of three formant
// band-pass filters. They "speak" in syllable grains (vowel → vowel glides, pitch contours on a
// pentatonic set above the pad root); every grain rises over ≥ 320 ms (no fast onsets).

import type { Rng } from '../rng';
import { DbSlew, VOWELS, VOWEL_KEYS, clamp01, gainToDb, SILENT_DB } from './synth';

const PENTA = [0, 2, 4, 7, 9, 12, 14];
const N_VOICES = 3;

interface Voice {
  osc: OscillatorNode;
  breath: GainNode;
  formants: BiquadFilterNode[];
  env: GainNode;
  pan: StereoPannerNode;
  nextT: number;
  busyUntil: number;
}

export interface EntityVoices {
  update(now: number, dt: number, present: boolean, intensity: number, rootHz: number, pulseNorm: number): void;
  dispose(): void;
}

export function createEntityVoices(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, rng: Rng): EntityVoices {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(out);
  const level = new DbSlew(SILENT_DB, 18); // the chorus swells in slowly
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = noise;
  noiseSrc.loop = true;
  noiseSrc.start();
  const voices: Voice[] = [];
  for (let v = 0; v < N_VOICES; v++) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 3200;
    const breath = ctx.createGain();
    breath.gain.value = 0.25;
    const src = ctx.createGain();
    src.gain.value = 1;
    osc.connect(soften).connect(src);
    noiseSrc.connect(breath).connect(src);
    const env = ctx.createGain();
    env.gain.value = 0;
    const formants: BiquadFilterNode[] = [];
    const vowel = VOWELS.a;
    const fGains = [1, 0.55, 0.28];
    const bws = [90, 110, 150];
    for (let k = 0; k < 3; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = vowel[k];
      bp.Q.value = vowel[k] / bws[k];
      const g = ctx.createGain();
      g.gain.value = fGains[k] * 2.2;
      src.connect(bp).connect(g).connect(env);
      formants.push(bp);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = (v - 1) * 0.55;
    env.connect(pan).connect(bus);
    osc.start();
    voices.push({ osc, breath, formants, env, pan, nextT: 0, busyUntil: 0 });
  }

  function syllable(vc: Voice, s: number, rootHz: number, pulseNorm: number): void {
    const A = 0.32 + 0.3 * rng();
    const H = 0.05 + 0.3 * rng();
    const R = 0.35 + 0.6 * rng();
    const peak = 0.45 + 0.55 * rng();
    const g = vc.env.gain;
    g.cancelScheduledValues(s);
    g.setValueAtTime(0, s);
    g.linearRampToValueAtTime(peak, s + A);
    g.setValueAtTime(peak, s + A + H);
    g.linearRampToValueAtTime(0, s + A + H + R);
    const v1 = VOWELS[VOWEL_KEYS[Math.floor(rng() * VOWEL_KEYS.length)]];
    const v2 = VOWELS[VOWEL_KEYS[Math.floor(rng() * VOWEL_KEYS.length)]];
    vc.formants.forEach((f, k) => {
      f.frequency.setTargetAtTime(v1[k], s, 0.06);
      f.frequency.setTargetAtTime(v2[k], s + A, 0.18);
      f.Q.setTargetAtTime(v1[k] / [90, 110, 150][k], s, 0.06);
    });
    // pitch: a pentatonic note above the pad root (one octave up), sliding a step; the pulse lifts it
    const base = rootHz * 2 * Math.pow(2, PENTA[Math.floor(rng() * PENTA.length)] / 12);
    const slide = Math.pow(2, ((rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 2)) * 2) / 12);
    vc.osc.frequency.setTargetAtTime(base, s, 0.05);
    vc.osc.frequency.setTargetAtTime(base * slide * (1 + 0.02 * pulseNorm), s + A * 0.6, 0.25);
    vc.breath.gain.setTargetAtTime(0.15 + 0.35 * rng(), s, 0.1);
    vc.busyUntil = s + A + H + R;
    vc.nextT = vc.busyUntil + 0.08 + 1.1 * rng();
  }

  return {
    update(now, dt, present, intensity, rootHz, pulseNorm) {
      const amt = present ? clamp01(intensity) : 0;
      level.step(amt > 0.001 ? -15 + gainToDb(amt) : SILENT_DB, dt);
      bus.gain.setTargetAtTime(level.gain, now, 0.05);
      if (amt <= 0.001) return;
      const horizon = now + 0.1;
      for (const vc of voices) {
        if (vc.nextT < now + 0.03) vc.nextT = Math.max(vc.busyUntil, now + 0.03 + 0.5 * rng());
        if (vc.nextT <= horizon && vc.nextT >= vc.busyUntil) syllable(vc, vc.nextT, rootHz, pulseNorm);
      }
    },
    dispose() {
      try { noiseSrc.stop(); } catch { /* already stopped */ }
      for (const v of voices) { try { v.osc.stop(); } catch { /* ok */ } v.pan.disconnect(); }
      bus.disconnect();
    },
  };
}
