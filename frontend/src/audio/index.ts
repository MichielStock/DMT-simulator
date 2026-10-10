// Synthesised audio of BUILD.md §12 with the audio safety of §4.2.
//
// ─── API for the integration agent ────────────────────────────────────────────────────────────
//   import { createAudio } from './audio';
//   const audio = createAudio(ctx, { enabled, microphone, seed? });
//     ctx: the AudioContext created on the safety-screen click (window.__hyperspace.audioContext);
//          an OfflineAudioContext works too (tests).
//   audio.start()                 fade the trip sound in (dB-linear, 4 s) — call when the trip starts
//   audio.update(state, dtSec)    every frame of the trip loop (reads only SharedState)
//   audio.exitTone()              Escape / exit corner: soft descending major third over 3 s, and
//                                 the trip sound fades out over the same 3 s
//   audio.groundingAmbient(on)    soft ambient during the grounding screen (4 s fades)
//   audio.stop(fadeSec = 3)       session over: everything fades out (sources keep running; start()
//                                 brings the trip sound back)
//   audio.uiClick()               end-screen line blip — see below
//   audio.setVolume(v 0–1) / audio.volume   always reachable (ramped over 250 ms)
//   audio.mic                     {level, centroid, centroidHz} 0–1 when the microphone option is on
//                                 and permission was granted, else null. Geometry may read it; audio
//                                 never drives geometry itself.
//   audio.dispose()
//
// ─── Safety (§4.2) ─────────────────────────────────────────────────────────────────────────────
//   Every trip sound → master chain (limiter.ts): compressor limiter (−6 dB, 20:1, knee 0, 3 ms /
//   250 ms) → WaveShaper hard ceiling just under −3 dBFS → volume. Continuous levels are slewed in
//   dB (≤ 20 dB/s rise, DbSlew) and then set with setTargetAtTime; grains and syllables use ≥ 200 ms
//   raised-cosine / linear attacks; fades from silence are dB-linear. The buzz is an amplitude
//   modulation of ≤ 4.4 dB depth (AM_DEPTH_MAX), never an onset.
//   THE ONE EXCEPTION: uiClick() is a 30 ms, −30 dBFS blip on its own GainNode straight to the
//   destination, outside the trip chain. UI only (end-screen typing), never during the trip, and
//   silent when the sound option is off or the volume is 0.

import { deriveSeed, mulberry32, type Rng } from '../rng';
import type { SharedState } from '../state';
import { createAmbient, expFade, playExitTone } from './ambient';
import { createEntityVoices, type EntityVoices } from './entityVoice';
import { createMasterChain, type MasterChain } from './limiter';
import { createMic, type Mic, type MicReading } from './mic';
import {
  AmLock, DbSlew, PulseTracker, SILENT_DB, WHINE_REL_DB, amDepth, amRateHz, carrierBLevel, carrierDb, carrierDetuneCents,
  carrierHz, chordAt, chordFreqs, clamp01, crackleDb, crackleRate, dbToGain, eyesCutoffHz, grainCurve,
  padRootHz, ringModAmount, rumbleDb, rumbleHz, whineHz, CHORD_XFADE_S, START_FADE_S, type ChordKind,
} from './synth';

export * from './synth';

export interface AudioOptions { enabled: boolean; microphone: boolean; seed?: number; volume?: number }

export interface HyperspaceAudio {
  update(state: SharedState, dtSec: number): void;
  start(): void;
  stop(fadeSec?: number): void;
  exitTone(): void;
  groundingAmbient(on: boolean): void;
  uiClick(): void;
  setVolume(v: number): void;
  readonly volume: number;
  readonly mic: MicReading | null;
  /** Read-only diagnostics for tests (current AM rate, lock multiple, chord, levels). */
  readonly debug: AudioDebug;
  dispose(): void;
}

export interface AudioDebug {
  amHz: number; amN: number; pulseHz: number; carrierHz: number; chord: string; grains: number;
  levels: Record<string, number>;
}

const LOOKAHEAD_S = 0.03;
const UI_CLICK_DBFS = -30;

function noiseBuffer(ctx: BaseAudioContext, seconds: number, rng: Rng): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return b;
}

/** A periodic wave with a few soft harmonics: the "carrier wave" hum. */
function carrierWave(ctx: BaseAudioContext): PeriodicWave {
  const real = new Float32Array([0, 0, 0, 0, 0, 0]);
  const imag = new Float32Array([0, 1, 0.32, 0.14, 0.06, 0.025]);
  return ctx.createPeriodicWave(real, imag);
}

function silentAudio(ctx: BaseAudioContext, opts: AudioOptions): HyperspaceAudio {
  let mic: Mic | null = null;
  let reading: MicReading | null = null;
  if (opts.microphone && typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
    createMic(ctx).then((m) => { mic = m; }).catch(() => { mic = null; });
  }
  return {
    update(_s, dt) { if (mic) reading = mic.read(dt); },
    start() {}, stop() {}, exitTone() {}, groundingAmbient() {}, uiClick() {}, setVolume() {},
    get volume() { return 0; },
    get mic() { return reading; },
    debug: { amHz: 0, amN: 0, pulseHz: 0, carrierHz: 0, chord: '', grains: 0, levels: {} },
    dispose() { mic?.dispose(); },
  };
}

export function createAudio(ctx: BaseAudioContext, opts: AudioOptions): HyperspaceAudio {
  if (!opts.enabled) return silentAudio(ctx, opts);

  let rng: Rng = mulberry32(deriveSeed(opts.seed ?? 1, 'audio'));
  let seeded = opts.seed !== undefined;
  const t0 = ctx.currentTime;
  const master: MasterChain = createMasterChain(ctx, ctx.destination, opts.volume ?? 0.8);
  const noise = noiseBuffer(ctx, 3, mulberry32(0x5eed));

  // ---- buses ----
  const tripGain = ctx.createGain();          // start / stop / exit fades
  tripGain.gain.value = 0;
  tripGain.connect(master.input);
  const roomLpf = ctx.createBiquadFilter();   // eyes-closed muffling of the room-ish elements
  roomLpf.type = 'lowpass';
  roomLpf.frequency.value = eyesCutoffHz(0);
  roomLpf.Q.value = 0.5;
  roomLpf.connect(tripGain);
  const ambientBus = ctx.createGain();
  ambientBus.connect(master.input);
  const exitBus = ctx.createGain();
  exitBus.connect(master.input);
  const ambient = createAmbient(ctx, ambientBus, noise);

  // ---- buzz VCA: carrier + rumble are amplitude-modulated together, locked to the pulse ----
  const amVca = ctx.createGain();
  amVca.gain.value = 1;
  amVca.connect(tripGain);
  const amOsc = ctx.createOscillator();
  amOsc.type = 'sine';
  amOsc.frequency.value = 4;
  const amDepthGain = ctx.createGain();
  amDepthGain.gain.value = 0;
  amOsc.connect(amDepthGain).connect(amVca.gain);
  const lock = new AmLock(t0, 4);

  // ---- carrier: two detuned oscillators, ring-mod for difficult passages, whine partial ----
  const wave = carrierWave(ctx);
  const carA = ctx.createOscillator();
  const carB = ctx.createOscillator();
  carA.setPeriodicWave(wave);
  carB.setPeriodicWave(wave);
  carA.frequency.value = carB.frequency.value = carrierHz(0);
  const carSum = ctx.createGain();
  carSum.gain.value = 0.8;
  const carBGain = ctx.createGain();
  carBGain.gain.value = carrierBLevel(0, 0);
  carA.connect(carSum);
  carB.connect(carBGain).connect(carSum);
  const carDry = ctx.createGain();
  carDry.gain.value = 0;
  carSum.connect(carDry).connect(amVca);
  const rmVca = ctx.createGain();
  rmVca.gain.value = 0;
  const rmOsc = ctx.createOscillator();
  rmOsc.frequency.value = carrierHz(0) * Math.SQRT2;
  rmOsc.connect(rmVca.gain);
  const rmLevel = ctx.createGain();
  rmLevel.gain.value = 0;
  carSum.connect(rmVca).connect(rmLevel).connect(amVca);
  const whine = ctx.createOscillator();
  whine.frequency.value = whineHz(0);
  const whineGain = ctx.createGain();
  whineGain.gain.value = 0;
  whine.connect(whineGain).connect(tripGain);

  // ---- body rumble 40–60 Hz ----
  const rum = ctx.createOscillator();
  rum.type = 'sine';
  rum.frequency.value = rumbleHz(0);
  const rum2 = ctx.createOscillator();
  rum2.type = 'triangle';
  rum2.frequency.value = rumbleHz(0) * 2;
  const rum2g = ctx.createGain();
  rum2g.gain.value = 0.1;
  const rumLp = ctx.createBiquadFilter();
  rumLp.type = 'lowpass';
  rumLp.frequency.value = 160;
  const rumGain = ctx.createGain();
  rumGain.gain.value = 0;
  rum.connect(rumLp);
  rum2.connect(rum2g).connect(rumLp);
  rumLp.connect(rumGain).connect(amVca);

  // ---- crackle grains (room bus) ----
  const crackleBus = ctx.createGain();
  crackleBus.gain.value = 0;
  crackleBus.connect(roomLpf);
  let nextGrain = t0 + 0.5;
  let liveGrains = 0;

  // ---- breakthrough pad: two chord slots, crossfaded ----
  const padBus = ctx.createGain();
  padBus.gain.value = 0;
  const padLp = ctx.createBiquadFilter();
  padLp.type = 'lowpass';
  padLp.frequency.value = 1800;
  padLp.Q.value = 0.3;
  padLp.connect(padBus).connect(tripGain);
  interface Slot { gain: GainNode; oscs: OscillatorNode[][] }
  const slots: Slot[] = [0, 1].map(() => {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(padLp);
    const oscs: OscillatorNode[][] = [];
    for (let k = 0; k < 4; k++) {
      const voice: OscillatorNode[] = [];
      // two detuned triangles (the slow chord) + two quiet sines two octaves up (the shimmer)
      for (const [type, mult, det, lvl] of [['triangle', 1, -4, 0.5], ['triangle', 1, 3, 0.5], ['sine', 4, -3, 0.07], ['sine', 4, 3, 0.07]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = 220 * mult;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = lvl * 0.25;
        o.connect(g).connect(gain);
        voice.push(o);
        (o as OscillatorNode & { _mult?: number })._mult = mult;
      }
      oscs.push(voice);
    }
    return { gain, oscs };
  });
  let activeSlot = 0;
  let chordKey = '';
  let chordKind: ChordKind = 'consonant';
  let lastChordChange = -1e9;

  // ---- entity voices ----
  const voiceBus = ctx.createGain();
  voiceBus.connect(tripGain);
  let voices: EntityVoices | null = null;

  const sources: AudioScheduledSourceNode[] = [amOsc, carA, carB, rmOsc, whine, rum, rum2, ...slots.flatMap((s) => s.oscs.flat())];
  for (const s of sources) s.start(t0);

  // ---- smoothed levels ----
  const lv = { carrier: new DbSlew(), rumble: new DbSlew(), crackle: new DbSlew(), pad: new DbSlew(SILENT_DB, 15) };
  const tracker = new PulseTracker();
  let rm = 0;
  let depth = 0;
  let running = false;
  let exiting = false;
  let snapLevels = false;

  // ---- mic ----
  let mic: Mic | null = null;
  let micReading: MicReading | null = null;
  if (opts.microphone && typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
    createMic(ctx).then((m) => { mic = m; }).catch(() => { mic = null; });
  }

  // ---- ui click (outside the trip chain) ----
  const uiGain = ctx.createGain();
  uiGain.gain.value = 0;
  uiGain.connect(ctx.destination);

  const debug: AudioDebug = { amHz: 4, amN: 0, pulseHz: 0, carrierHz: carrierHz(0), chord: '', grains: 0, levels: {} };

  function setChord(freqs: number[], slot: Slot, now: number, glide: boolean): void {
    slot.oscs.forEach((voice, k) => {
      for (const o of voice) {
        const f = freqs[k] * ((o as OscillatorNode & { _mult?: number })._mult ?? 1);
        if (glide) o.frequency.setTargetAtTime(f, now, 0.4);
        else { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(f, now); }
      }
    });
  }

  function crossfadeTo(freqs: number[], now: number): void {
    const next = 1 - activeSlot;
    const inactive = slots[next];
    // the incoming slot has been silent since the last crossfade unless a change interrupts one
    const quiet = now - lastChordChange > CHORD_XFADE_S + 0.5;
    setChord(freqs, inactive, now, !quiet);
    for (const [slot, target] of [[slots[activeSlot], 0], [inactive, 1]] as const) {
      slot.gain.gain.cancelScheduledValues(now);
      slot.gain.gain.setValueAtTime(slot.gain.gain.value, now);
      slot.gain.gain.linearRampToValueAtTime(target, now + CHORD_XFADE_S);
    }
    activeSlot = next;
    lastChordChange = now;
  }

  function spawnGrain(t: number, level: number): void {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200 * Math.pow(6500 / 1200, rng());
    bp.Q.value = 12 + 18 * rng();
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (rng() * 2 - 1) * 0.75;
    const attack = 0.2 + 0.06 * rng();
    const release = 0.12 + 0.3 * rng();
    g.gain.setValueCurveAtTime(grainCurve(attack, release, level * (0.45 + 0.55 * rng()) * 4), t, attack + release);
    src.connect(bp).connect(g).connect(pan).connect(crackleBus);
    src.start(t, rng() * 2.5);
    src.stop(t + attack + release + 0.05);
    liveGrains++;
    src.onended = () => { liveGrains--; pan.disconnect(); };
  }

  const api: HyperspaceAudio = {
    update(state: SharedState, dtSec: number) {
      const now = ctx.currentTime;
      const dt = Math.min(Math.max(dtSec, 0), 0.1);
      if (mic) micReading = mic.read(dt);
      if (!seeded) { rng = mulberry32(deriveSeed(state.seed, 'audio')); seeded = true; }
      const a = state.intensity.auditory;
      const b = state.intensity.body;
      const L = state.challenge.active ? clamp01(state.challenge.level) : 0;
      const relief = clamp01(state.challenge.relief ?? 0);
      if (snapLevels) {
        // start() fades the whole trip bus in dB-linearly; let the per-voice slews start at target
        // so the two rises do not stack.
        snapLevels = false;
        lv.carrier.snap(carrierDb(a)); lv.rumble.snap(rumbleDb(b)); lv.crackle.snap(crackleDb(a));
      }

      // pulse → buzz lock
      const sx = state as unknown as { pulsePhase?: number; pulseHz?: number };
      tracker.update(state.pulse, dt, typeof sx.pulsePhase === 'number' ? { phase: sx.pulsePhase, hz: sx.pulseHz } : undefined);
      const tS = now + LOOKAHEAD_S;
      const phaseAtS = (tracker.phase + tracker.hz * LOOKAHEAD_S) % 1;
      const buzzI = Math.max(a, b);
      const fAm = lock.step(tS, phaseAtS, tracker.hz, amRateHz(buzzI));
      amOsc.frequency.setValueAtTime(fAm, tS);
      const dTarget = amDepth(buzzI, tracker.norm);
      depth += (dTarget - depth) * Math.min(1, dt / 0.3);
      amVca.gain.setTargetAtTime(1 - depth, now, 0.05);
      amDepthGain.gain.setTargetAtTime(depth, now, 0.05);

      // carrier, ring-mod, whine
      const fc = carrierHz(a);
      for (const o of [carA, carB]) o.frequency.setTargetAtTime(fc, now, 0.25);
      carB.detune.setTargetAtTime(carrierDetuneCents(L, relief, fc), now, 0.6);
      carBGain.gain.setTargetAtTime(carrierBLevel(L, relief), now, 0.6);
      rmOsc.frequency.setTargetAtTime(fc * Math.SQRT2 * 1.003, now, 0.25);
      whine.frequency.setTargetAtTime(whineHz(a), now, 0.4);
      const rmT = ringModAmount(L, relief);
      rm += (rmT - rm) * Math.min(1, dt / 0.8);
      const cg = dbToGain(lv.carrier.step(carrierDb(a), dt));
      carDry.gain.setTargetAtTime(cg * (1 - 0.45 * rm), now, 0.05);
      rmLevel.gain.setTargetAtTime(cg * 0.9 * rm, now, 0.05);
      whineGain.gain.setTargetAtTime(cg * dbToGain(WHINE_REL_DB), now, 0.05);

      // rumble
      const fr = rumbleHz(b);
      rum.frequency.setTargetAtTime(fr, now, 0.5);
      rum2.frequency.setTargetAtTime(fr * 2, now, 0.5);
      rumGain.gain.setTargetAtTime(dbToGain(lv.rumble.step(rumbleDb(b), dt)), now, 0.05);

      // crackle
      const cl = lv.crackle.step(crackleDb(a), dt);
      crackleBus.gain.setTargetAtTime(dbToGain(cl), now, 0.05);
      const rate = crackleRate(a);
      if (rate <= 0) nextGrain = Math.max(nextGrain, now + 0.25);
      else {
        if (nextGrain < now + 0.02) nextGrain = now + 0.02 + (-Math.log(1 - rng()) / rate) * 0.5;
        while (nextGrain < now + 0.12) {
          if (liveGrains < 24) spawnGrain(nextGrain, 1);
          nextGrain += -Math.log(1 - rng()) / rate;
        }
      }
      roomLpf.frequency.setTargetAtTime(eyesCutoffHz(state.eyesClosed), now, 0.3);

      // breakthrough pad / difficult passage chords
      const w = clamp01(state.layerWeights.breakthrough);
      const padAmt = Math.max(w, 0.75 * L, 0.75 * relief);
      padBus.gain.setTargetAtTime(dbToGain(lv.pad.step(padAmt > 0.001 ? -14 + 20 * Math.log10(padAmt) : SILENT_DB, dt)), now, 0.05);
      const root = padRootHz(fc);
      const ch = chordAt(state.wallTime, L, relief);
      if (padAmt > 0.001 || lv.pad.db > SILENT_DB) {
        if (chordKey === '') {
          // first chord: set directly on the active slot (the pad bus itself is still silent)
          setChord(chordFreqs(root, ch.chord), slots[activeSlot], now, false);
          slots[activeSlot].gain.gain.setValueAtTime(1, now);
          chordKey = ch.key; chordKind = ch.kind; lastChordChange = now;
        } else if (ch.key !== chordKey && (now - lastChordChange >= CHORD_XFADE_S || ch.kind !== chordKind)) {
          crossfadeTo(chordFreqs(root, ch.chord), now);
          chordKey = ch.key; chordKind = ch.kind;
        }
      }
      padLp.frequency.setTargetAtTime(1300 + 1500 * tracker.norm * clamp01(a / 10), now, 0.3);

      // entity voices
      if (state.entity.present || voices) {
        if (!voices) voices = createEntityVoices(ctx, voiceBus, noise, mulberry32(deriveSeed(state.seed, 'voices')));
        voices.update(now, dt, state.entity.present, state.entity.intensity, root, tracker.norm);
      }

      debug.amHz = fAm; debug.amN = lock.n; debug.pulseHz = tracker.hz; debug.carrierHz = fc;
      debug.chord = chordKey; debug.grains = liveGrains;
      debug.levels = { carrier: lv.carrier.db, rumble: lv.rumble.db, crackle: lv.crackle.db, pad: lv.pad.db, rm, depth };
    },
    start() {
      running = true;
      exiting = false;
      if (tripGain.gain.value < 0.01) snapLevels = true;
      expFade(tripGain.gain, 1, ctx.currentTime, START_FADE_S);
    },
    stop(fadeSec = 3) {
      running = false;
      const now = ctx.currentTime;
      const d = Math.max(0.3, fadeSec);
      expFade(tripGain.gain, 0, now, d);
      ambient.set(false);
    },
    exitTone() {
      if (!exiting) {
        exiting = true;
        expFade(tripGain.gain, 0, ctx.currentTime, 3);
      }
      playExitTone(ctx, exitBus);
    },
    groundingAmbient(on: boolean) { ambient.set(on); },
    uiClick() {
      if (master.volume <= 0) return;
      const now = ctx.currentTime + 0.005;
      const o = ctx.createOscillator();
      o.frequency.value = 1320;
      o.connect(uiGain);
      const peak = dbToGain(UI_CLICK_DBFS) * master.volume;
      const n = 32;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = peak * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      uiGain.gain.cancelScheduledValues(now);
      uiGain.gain.setValueCurveAtTime(curve, now, 0.03);
      o.start(now);
      o.stop(now + 0.035);
      o.onended = () => o.disconnect();
    },
    setVolume(v: number) { master.setVolume(v); },
    get volume() { return master.volume; },
    get mic() { return micReading; },
    debug,
    dispose() {
      running = false;
      for (const s of sources) { try { s.stop(); } catch { /* ok */ } }
      voices?.dispose();
      ambient.dispose();
      mic?.dispose();
      master.dispose();
      uiGain.disconnect();
    },
  };
  void running;
  return api;
}
