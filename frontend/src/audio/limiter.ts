// Master safety chain of BUILD.md §4.2: input gain → DynamicsCompressor limiter (threshold −6 dB,
// ratio 20, knee 0, attack 3 ms, release 250 ms) → ceiling trim → WaveShaper hard ceiling (the
// output can never exceed CEILING_DBFS, whatever the compressor's automatic make-up gain or
// attack overshoot does) → volume → destination. Volume changes ramp over ≥ 250 ms.

import { CEILING_DBFS, clamp01, dbToGain } from './synth';

/** Linear peak of the hard ceiling: a hair under −3 dBFS. */
export const CEILING_LINEAR = dbToGain(CEILING_DBFS - 0.2);

/**
 * Transfer curve of the hard ceiling: identity up to `knee`, then a tanh shoulder that approaches
 * but never reaches `ceiling`. Inputs beyond ±1 map to the curve ends (Web Audio clamps).
 */
export function ceilingCurve(ceiling = CEILING_LINEAR, knee = 0.5, n = 8193): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    out[i] = Math.sign(x) * Math.min(y, ceiling * 0.9999);
  }
  return out;
}

export interface MasterChain {
  input: GainNode;
  compressor: DynamicsCompressorNode;
  setVolume(v: number): void;
  readonly volume: number;
  dispose(): void;
}

export const VOLUME_RAMP_S = 0.25;
/** Default master volume (D-A-soft0: 0.8 → 0.5; −/+ still step it by 0.1 up to 1). */
export const DEFAULT_VOLUME = 0.5;

export function createMasterChain(ctx: BaseAudioContext, destination: AudioNode = ctx.destination, volume = DEFAULT_VOLUME): MasterChain {
  const input = ctx.createGain();
  input.gain.value = 1;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.ratio.value = 20;
  comp.knee.value = 0;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  // Chrome's compressor adds automatic make-up gain (~+3.4 dB at these settings); trim it back.
  const trim = ctx.createGain();
  trim.gain.value = dbToGain(-2);
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve();
  ceiling.oversample = 'none'; // oversampling filters could ring above the ceiling
  const vol = ctx.createGain();
  let current = clamp01(volume);
  vol.gain.value = current;
  input.connect(comp).connect(trim).connect(ceiling).connect(vol).connect(destination);
  return {
    input,
    compressor: comp,
    setVolume(v: number) {
      current = clamp01(v);
      const now = ctx.currentTime;
      vol.gain.cancelScheduledValues(now);
      vol.gain.setValueAtTime(vol.gain.value, now);
      vol.gain.linearRampToValueAtTime(current, now + VOLUME_RAMP_S);
    },
    get volume() { return current; },
    dispose() {
      for (const n of [input, comp, trim, ceiling, vol]) n.disconnect();
    },
  };
}
