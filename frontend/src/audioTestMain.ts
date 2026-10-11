// Offline audio test harness (BUILD.md §16.2 "Audio", M7). Renders the FULL audio graph through an
// OfflineAudioContext (48 kHz) driven by a synthetic SharedState, frame by frame (suspend/resume
// every 6 render quanta = 16 ms), and analyses the buffers in-page:
//   - peak sample ≤ −3 dBFS (ceiling) at maximum intensity
//   - no attack faster than 200 ms: RMS over 10 ms windows; any rise ≥ 12 dB within 200 ms fails
//   - levels follow the shared state: RMS at intensity 2 < RMS at intensity 8
//   - buzz (AM) rate at intensity 10 ≤ 12 Hz (peak of the envelope spectrum), locked to the pulse
// Results on window.__audioTest; ?wav=1 also returns base64 WAVs of the listening renders.

import { createAudio, type HyperspaceAudio } from './audio';
import { createMasterChain, DEFAULT_VOLUME } from './audio/limiter';
import { createState, type SharedState } from './state';

const SR = 48000;
const QUANTUM = 128;
const FRAME_QUANTA = 6;
const DT = (FRAME_QUANTA * QUANTUM) / SR;

interface Drive { (st: SharedState, t: number): void }
interface Scenario { name: string; seconds: number; drive: Drive; wav?: boolean; at?: Array<[number, (a: HyperspaceAudio) => void]> }

function setIntensity(st: SharedState, v: number): void {
  st.intensity.visual = v; st.intensity.body = v; st.intensity.auditory = v;
}
function base(v: number, bt = 0): Drive {
  return (st) => {
    setIntensity(st, v);
    st.layerWeights.breakthrough = bt;
    st.eyesClosed = v >= 3 ? 1 : 0;
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'max', seconds: 20,
    drive: (st) => {
      setIntensity(st, 10);
      st.layerWeights.breakthrough = 1;
      st.entity.present = true; st.entity.intensity = 1;
      st.challenge.active = true; st.challenge.level = 1; st.challenge.relief = 0;
      st.eyesClosed = 1;
    },
  },
  { name: 'level2', seconds: 10, drive: base(2) },
  { name: 'level8', seconds: 10, drive: base(8) },
  { name: 'i2', seconds: 10, drive: base(2), wav: true },
  { name: 'i6', seconds: 10, drive: base(6), wav: true },
  { name: 'i10', seconds: 10, drive: base(10), wav: true },
  {
    name: 'breakthrough', seconds: 20, wav: true,
    drive: (st, t) => {
      setIntensity(st, 9.5);
      st.layerWeights.breakthrough = Math.min(1, t / 2.5);
      st.entity.present = t > 5; st.entity.intensity = Math.min(1, Math.max(0, (t - 5) / 3));
      st.eyesClosed = 1;
    },
  },
  {
    name: 'challenge', seconds: 24, wav: true,
    drive: (st, t) => {
      setIntensity(st, 9);
      st.layerWeights.breakthrough = 0;
      const on = t > 3 && t < 13;
      st.challenge.active = on;
      st.challenge.level = on ? Math.min(1, (t - 3) / 3) : 0;
      st.challenge.relief = t >= 13 ? 1 : 0;
      st.eyesClosed = 1;
    },
  },
  {
    // Escape at 6 s (exit tone + 3 s fade), grounding ambient from 9 s, session over at 15 s
    name: 'exit', seconds: 20, wav: true, drive: base(7),
    at: [[6, (a) => a.exitTone()], [9, (a) => a.groundingAmbient(true)], [15, (a) => a.stop(3)]],
  },
];

interface RenderOut { buffer: AudioBuffer; am: number[]; amN: number[]; pulseHz: number[]; chords: string[] }

async function render(sc: Scenario): Promise<RenderOut> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * sc.seconds), SR);
  const audio: HyperspaceAudio = createAudio(ctx, { enabled: true, microphone: false, seed: 42, volume: 1 });
  const st = createState(42);
  let phase = 0;
  const am: number[] = []; const amN: number[] = []; const pulseHz: number[] = []; const chords: string[] = [];
  const step = (t: number) => {
    sc.drive(st, t);
    st.wallTime = t;
    st.t_min = t / 60;
    // the pulse exactly as main.ts makes it: 0.08–0.5 Hz, depth min(1, v/5)
    const v = st.intensity.visual;
    phase = (phase + (0.08 + 0.42 * Math.min(1, v / 10)) * DT) % 1;
    st.pulse = (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)) * Math.min(1, v / 5);
    for (const [ta, fn] of sc.at ?? []) if (t >= ta && t < ta + DT * 0.99) fn(audio);
    audio.update(st, DT);
    am.push(audio.debug.amHz); amN.push(audio.debug.amN); pulseHz.push(audio.debug.pulseHz);
    if (!chords.length || chords[chords.length - 1] !== audio.debug.chord) chords.push(audio.debug.chord);
  };
  audio.start();
  step(0);
  const n = Math.floor(sc.seconds / DT) - 1;
  for (let k = 1; k <= n; k++) {
    const t = k * DT;
    ctx.suspend(t).then(() => { step(t); return ctx.resume(); });
  }
  const buffer = await ctx.startRendering();
  return { buffer, am, amN, pulseHz, chords };
}

/** Ceiling stress: drive the master chain alone with a +12 dBFS square wave switched on abruptly
 * and full-scale noise bursts; the hard ceiling must still hold the output at ≤ −3 dBFS. */
async function renderStress(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, SR * 3, SR);
  const chain = createMasterChain(ctx, ctx.destination, 1);
  const sq = ctx.createOscillator(); sq.type = 'square'; sq.frequency.value = 97;
  const g = ctx.createGain(); g.gain.value = 4;
  sq.connect(g).connect(chain.input); sq.start(0.5); sq.stop(1.5);
  const nb = ctx.createBuffer(1, SR, SR); const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 12.9898) * 43758.5453 % 1;
  const ns = ctx.createBufferSource(); ns.buffer = nb; const ng = ctx.createGain(); ng.gain.value = 8;
  ns.connect(ng).connect(chain.input); ns.start(1.8);
  return ctx.startRendering();
}

// ---------------------------------------------------------------- analysis
function mixPower(buf: AudioBuffer): Float32Array {
  const a = buf.getChannelData(0); const b = buf.getChannelData(1);
  const p = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) p[i] = 0.5 * (a[i] * a[i] + b[i] * b[i]);
  return p;
}
function peakDbfs(buf: AudioBuffer): number {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); }
  return 20 * Math.log10(m + 1e-12);
}
function rmsWindowsDb(p: Float32Array, win: number, floorDb = -60): Float32Array {
  const n = Math.floor(p.length / win);
  const out = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win; i++) s += p[i];
    out[w] = Math.max(floorDb, 10 * Math.log10(s / win + 1e-15));
  }
  return out;
}
/** Largest rise (dB) between any two 10 ms windows ≤ 200 ms apart. */
function maxRise(db: Float32Array, span = 20): { rise: number; at: number } {
  let best = 0; let at = 0;
  for (let j = 1; j < db.length; j++) {
    for (let i = Math.max(0, j - span); i < j; i++) {
      const r = db[j] - db[i];
      if (r > best) { best = r; at = j; }
    }
  }
  return { rise: best, at: at * 0.01 };
}
function segmentRmsDb(p: Float32Array, t0: number, t1: number): number {
  let s = 0; const a = Math.floor(t0 * SR); const b = Math.min(p.length, Math.floor(t1 * SR));
  for (let i = a; i < b; i++) s += p[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-15);
}
function fftMag(re: Float64Array): Float64Array {
  const n = re.length; const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k); const wi = Math.sin(ang * k);
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr; im[i + k] += xi;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
/** Peak frequency (2–40 Hz) of the amplitude envelope (RMS over 2.5 ms hops) in [t0, t1]. */
function envelopePeakHz(p: Float32Array, t0: number, t1: number): { hz: number; prominence: number } {
  const hop = 120; const env: number[] = [];
  for (let i = Math.floor(t0 * SR); i + hop <= Math.floor(t1 * SR); i += hop) {
    let s = 0; for (let k = 0; k < hop; k++) s += p[i + k];
    env.push(Math.sqrt(s / hop));
  }
  const mean = env.reduce((x, y) => x + y, 0) / env.length;
  const N = 1 << Math.ceil(Math.log2(env.length * 4));
  const re = new Float64Array(N);
  for (let i = 0; i < env.length; i++) re[i] = (env[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (env.length - 1)));
  const mag = fftMag(re);
  const fs = SR / hop; let best = 0; let bi = 0; let sum = 0; let cnt = 0;
  for (let i = 1; i < mag.length; i++) {
    const f = (i * fs) / N;
    if (f < 2 || f > 40) continue;
    sum += mag[i]; cnt++;
    if (mag[i] > best) { best = mag[i]; bi = i; }
  }
  return { hz: (bi * fs) / N, prominence: best / (sum / Math.max(1, cnt)) };
}

function wavBase64(buf: AudioBuffer): string {
  const n = buf.length; const ch = buf.numberOfChannels;
  const bytes = new Uint8Array(44 + n * ch * 2); const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data');
  dv.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), true); o += 2; }
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += '\n' + s; };
declare global { interface Window { __audioTest?: Record<string, unknown> } }

async function main(): Promise<void> {
  const wantWav = new URLSearchParams(location.search).has('wav');
  const results: Record<string, Record<string, unknown>> = {};
  const wavs: Record<string, string> = {};
  const t0 = performance.now();
  for (const sc of SCENARIOS) {
    if (sc.wav && !wantWav) continue;
    const r = await render(sc);
    const p = mixPower(r.buffer);
    const rise = maxRise(rmsWindowsDb(p, SR / 100));
    const res: Record<string, unknown> = {
      seconds: sc.seconds,
      peakDbfs: +peakDbfs(r.buffer).toFixed(2),
      maxRiseDb200ms: +rise.rise.toFixed(2), riseAtS: +rise.at.toFixed(2),
      rmsDbfs: +segmentRmsDb(p, 6, sc.seconds).toFixed(2),
      chords: r.chords.filter(Boolean),
    };
    if (sc.name === 'max') {
      const env = envelopePeakHz(p, 8, 18);
      const late = r.am.slice(Math.floor(8 / DT));
      res.amEnvelopePeakHz = +env.hz.toFixed(3);
      res.amEnvelopeProminence = +env.prominence.toFixed(1);
      res.amOscMaxHz = +Math.max(...r.am).toFixed(3);
      res.amOscMeanHz = +(late.reduce((x, y) => x + y, 0) / late.length).toFixed(3);
      res.amLockN = r.amN[r.amN.length - 1];
      res.pulseHzEstimate = +r.pulseHz[r.pulseHz.length - 1].toFixed(4);
    }
    results[sc.name] = res;
    if (sc.wav) wavs[sc.name] = wavBase64(r.buffer);
    log(`${sc.name}: ${JSON.stringify(res)}`);
  }
  const stress = await renderStress();
  results.ceilingStress = { peakDbfs: +peakDbfs(stress).toFixed(2), maxRiseDb200ms: 0 };
  log(`ceilingStress: ${JSON.stringify(results.ceilingStress)}`);
  const m = results.max;
  const checks = {
    ceiling: (m.peakDbfs as number) <= -3 && (results.ceilingStress.peakDbfs as number) <= -3,
    noFastAttack: Object.values(results).every((r) => (r.maxRiseDb200ms as number) < 12),
    levelsFollowState: (results.level2.rmsDbfs as number) < (results.level8.rmsDbfs as number),
    amRateMax12: (m.amEnvelopePeakHz as number) <= 12 && (m.amOscMaxHz as number) <= 12,
    amRateInBuzzRange: (m.amEnvelopePeakHz as number) >= 4,
    amLockedToPulse: Math.abs((m.amEnvelopePeakHz as number) / 0.5 - Math.round((m.amEnvelopePeakHz as number) / 0.5)) < 0.1,
  };
  const pass = Object.values(checks).every(Boolean);
  window.__audioTest = { done: true, pass, checks, results, wavs, renderMs: Math.round(performance.now() - t0), sampleRate: SR, frameDt: DT };
  log(`checks: ${JSON.stringify(checks)}\nPASS=${pass}`);
}

/** ?realtime=1: smoke test of the same graph on a live AudioContext with irregular rAF frames:
 * no exceptions, the buzz locks to the pulse, the whole public API is callable. */
async function realtime(): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  const audio = createAudio(ctx, { enabled: true, microphone: false, seed: 7 });
  const startVolume = audio.volume;
  const st = createState(7);
  setIntensity(st, 10);
  st.layerWeights.breakthrough = 1; st.entity.present = true; st.entity.intensity = 1;
  audio.start();
  let phase = 0; let last = performance.now(); const t0 = last;
  const amN: number[] = [];
  await new Promise<void>((done) => {
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      st.wallTime += dt;
      phase = (phase + 0.5 * dt) % 1;
      st.pulse = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
      audio.update(st, dt);
      amN.push(audio.debug.amN);
      if (now - t0 < 7000) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  audio.setVolume(0.3);
  audio.exitTone();
  audio.groundingAmbient(true);
  audio.uiClick();
  audio.stop(1);
  const res = { state: ctx.state, amN: amN[amN.length - 1], amHz: audio.debug.amHz, pulseHz: audio.debug.pulseHz, volume: audio.volume, startVolume, frames: amN.length, chord: audio.debug.chord };
  audio.dispose();
  await ctx.close();
  window.__audioTest = { done: true, pass: res.amN >= 21 && res.amN <= 23 && res.volume === 0.3 && res.startVolume === DEFAULT_VOLUME, realtime: res };
  log(`realtime: ${JSON.stringify(res)}`);
}

(new URLSearchParams(location.search).has('realtime') ? realtime() : main()).catch((e) => {
  window.__audioTest = { done: true, pass: false, error: String(e?.stack ?? e) };
  log('ERROR ' + String(e?.stack ?? e));
});
