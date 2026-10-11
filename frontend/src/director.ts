// Director: drives the breakthrough sequence, entities, behaviour beats, the glyph message and the
// difficult passages from the trip script (BUILD.md section 11.7). Deterministic for a seed, a trip
// script, the options and an input trajectory: every random draw comes from seeded mulberry32 streams
// and is taken at a scheduled moment (never per frame), and every timed decision uses model time.
// It emits events (logged by the caller) and keeps the entity / message / challenge / sequence fields
// that main.ts copies into the shared state for the layers and the audio.
//
// Sequence (model time):
//   latch (v ≥ 8)     phase 'veil': the geometry thins into a membrane and lifts (veil 0 → 1 over VEIL_S)
//   then              phase 'world': the world is shown, nobody there yet
//   +5–20 s           entity appears (entity_appear), first beat 'approach' at once; later beats every
//                     8–15 s (entity_behaviour); intensity/depth/position/variant/morph advance each frame
//   peak beat         message_shown at the entity's most intense planned beat (shown MESSAGE_SHOW_S)
//   'depart'          the entity recedes and fades; the next planned entity may arrive 5–20 s later
//   v < 7             phase 'descent': the world dims, a present entity departs early, veil falls back
// Difficult passage (never in gentle mode): λ = λ0·(1 + 0.1·surrender) + λhold·[space held] per second,
// one hazard draw per model second, hard cap 90 s, then a 15 s relief beat. Gentle mode: at most one
// fear flicker of at most 5 s (no challenge events).

import type { EntitySpec, TripScript } from './api';
import { deriveSeed, mulberry32, uniform, type Rng } from './rng';

export interface DirectorInput {
  tMin: number;         // model time since the hit, minutes
  visual: number;       // visual intensity 0–10
  latched: boolean;     // breakthrough latch (v ≥ 8, released below 6.5)
  letGo: boolean;       // space held
}

export interface DirectorEvent { t_min: number; type: string; payload: Record<string, unknown> }

export interface DirectorOptions {
  gentle: boolean;
  surrender: number;    // 0–10 from the intake
}

/** Section 11.7 constants. */
export const CHALLENGE = {
  lambda0: 1 / 60,      // per second
  surrenderGain: 0.1,   // λ0 · (1 + 0.1 · surrender)
  lambdaHold: 1 / 10,   // per second while space is held
  capS: 90,             // hard cap
  reliefS: 15,          // relief beat after resolution
  rampS: 5,
  gentleFlickerS: 3.5,  // gentle mode: one brief fear flicker; with its 1 s fall it stays under 5 s
  gentleFlickerMaxS: 5,
  gentleFlickerP: 0.35, // chance of the one flicker after a peak of v ≥ 6 (D-D3)
  gentleFlickerLevel: 0.3,
};
export const ENTITY_DELAY_S: [number, number] = [5, 20];
export const BEAT_INTERVAL_S: [number, number] = [8, 15];
export const MESSAGE_SHOW_S = 12;
export const MESSAGE_FADE_S = 2;
export const VEIL_S = 4;              // ≥ 2 s (BUILD.md 4.1 breakthrough transitions)
export const DESCENT_V = 7;           // 11.7 item 6
export const EARLY_DEPART_S = 6;      // a depart forced by the descent
export const ENTITY_FADE_IN_S = 3;
export const VARIANTS = 3;            // sprites a/b/c

/** Planned salience of each behaviour beat (1 = the entity's most intense moment). */
export const BEAT_LEVEL: Record<string, number> = {
  approach: 0.7, greet: 0.8, present_object: 0.85, show: 0.9, teach: 0.9, work_on: 1.0, transform: 0.95, depart: 0.45,
};
/** Depth target per beat: 0 = far away in the world, 1 = right in front of the viewer. */
const BEAT_DEPTH: Record<string, number> = {
  approach: 0.6, greet: 0.72, present_object: 0.8, show: 0.72, teach: 0.75, work_on: 0.95, transform: 0.85, depart: 0.05,
};
/** Position target per beat as [x × side, y]; side = ±1 per entity from the seeded stream. */
const BEAT_POS: Record<string, [number, number]> = {
  approach: [0.2, 0.06], greet: [0.1, 0.04], present_object: [0.16, 0.0], show: [-0.12, 0.05], teach: [-0.08, 0.04],
  work_on: [0, 0], transform: [0.05, 0.03], depart: [0.75, 0.4],
};
const START_POS: [number, number] = [0.65, 0.3];
const START_DEPTH = 0.12;

const S = 1 / 60; // one second in minutes

export type SequencePhase = 'none' | 'veil' | 'world' | 'encounter' | 'descent';

export interface EntityFields {
  present: boolean;
  index: number;
  type: string | null;
  behaviour: string | null;
  beat: number;
  since: number;
  intensity: number;
  variant: number;
  morph: number;
  depth: number;
  position: [number, number];
}

export interface MessageFields {
  active: boolean;
  t: number;
  present: boolean;
  intensity: number;
  glyphSeed: number;
  theme: string | null;
}

/** Message envelope at `t` seconds after it was shown: 2 s in, hold, 2 s out (0 after MESSAGE_SHOW_S). */
export function messageEnvelope(t: number): number {
  if (t < 0 || t >= MESSAGE_SHOW_S) return 0;
  return Math.min(1, t / MESSAGE_FADE_S, (MESSAGE_SHOW_S - t) / MESSAGE_FADE_S);
}

interface Focus {
  index: number;
  spec: EntitySpec;
  appearAt: number;      // min
  intervals: number[];   // s, one per beat (the last is the depart duration)
  beatTimes: number[];   // min, start of each beat
  beatIdx: number;       // index of the current beat (-1 before the first)
  side: number;
  departAt: number;      // min (Infinity until departing)
  departDur: number;     // s
  departFrom: number;    // intensity when the depart began
  morphPhase: number;
}

export class Director {
  readonly entity: EntityFields = { present: false, index: -1, type: null, behaviour: null, beat: 0, since: 0, intensity: 0,
    variant: 0, morph: 0, depth: 0, position: [0, 0] };
  readonly challenge = { active: false, level: 0, relief: 0 };
  readonly message: MessageFields = { active: false, t: 0, present: false, intensity: 0, glyphSeed: 0, theme: null };
  readonly sequence = { phase: 'none' as SequencePhase, sinceS: 0, veil: 0 };
  /** gentle-mode fear flickers (test/diagnostic record; no events by design) */
  readonly flickers: { t_min: number; duration_s: number }[] = [];

  private rng: Rng;
  private hazardRng: Rng;
  private wasLatched = false;
  private nextEntity = 0;                 // index of the next entity to arrive
  private arriveAt = Infinity;            // min
  private focus: Focus | null = null;
  private messageDone = false;
  private messageAt = Infinity;
  private messageShownAt = -1;            // min
  private maxV = 0;
  private challengeState: 'idle' | 'waiting' | 'active' | 'relief' | 'done' = 'idle';
  private challengeStartAt = Infinity;
  private challengeBegan = 0;
  private challengeResolvedAt = 0;
  private nextHazardTick = 0;
  private flickerState: 'idle' | 'decided' | 'on' | 'done' = 'idle';
  private flickerFrom = -1;
  private flickerUntil = -1;
  private lastT = 0;
  private offsetS = 0;
  private phaseStart = 0;
  private forcedEntity = false;
  private forcedMessage = false;
  private messageLoop = false;            // scrub: the forced message keeps cycling (no further events)

  constructor(private script: TripScript | null, seed: number, private opts: DirectorOptions) {
    this.rng = mulberry32(deriveSeed(seed, 'director'));
    this.hazardRng = mulberry32(deriveSeed(seed, 'challenge'));
    const msg = script?.breakthrough?.message;
    this.message.glyphSeed = Number.isFinite(msg?.glyph_seed as number) ? Number(msg!.glyph_seed) : (seed >>> 0) % 100000;
    const theme = (msg as { theme?: unknown } | null | undefined)?.theme;
    this.message.theme = typeof theme === 'string' ? theme : null;
    const ch = script?.challenge;
    if (ch?.occurs && !opts.gentle) {
      this.challengeState = 'waiting';
      // onset_offset_s: seconds after the predicted peak (trip_script schema). With predicted.peak_time_min
      // the start is fixed in advance; otherwise it is placed relative to the observed peak (first moment
      // the visual intensity falls from its maximum).
      this.offsetS = Number.isFinite(ch.onset_offset_s as number) ? (ch.onset_offset_s as number) : 0;
      const pk = (script?.predicted as { peak_time_min?: number } | undefined)?.peak_time_min;
      if (typeof pk === 'number' && Number.isFinite(pk)) this.challengeStartAt = Math.max(0, pk + this.offsetS * S);
    }
  }

  get entities(): EntitySpec[] {
    return this.script?.breakthrough?.entities ?? [];
  }

  private get messagePlanned(): boolean {
    return !!this.script?.breakthrough?.message?.present;
  }

  update(inp: DirectorInput): DirectorEvent[] {
    const out: DirectorEvent[] = [];
    const t = inp.tMin;
    const dtS = Math.max(0, (t - this.lastT) * 60);
    this.lastT = t;
    const pastPeak = this.maxV >= 0.5 && inp.visual < this.maxV - 0.02;
    this.maxV = Math.max(this.maxV, inp.visual);
    const forced = this.forcedEntity;
    const encounter = forced || (inp.latched && inp.visual >= DESCENT_V);

    // ---- breakthrough sequence: latch → veil → world; descent below v 7 ----
    const rising = inp.latched && !this.wasLatched;
    this.wasLatched = inp.latched;
    if (rising) {
      this.setPhase('veil', t);
      if (!this.focus && this.nextEntity < this.entities.length && this.arriveAt === Infinity) {
        this.arriveAt = t + this.arrivalDelayS(this.nextEntity) * S;
      }
    }
    const ph = this.sequence.phase;
    if (ph === 'veil' && (t - this.phaseStart) * 60 >= VEIL_S) this.setPhase(this.focus ? 'encounter' : 'world', t);
    if ((ph === 'veil' || ph === 'world' || ph === 'encounter') && !encounter && !(ph === 'veil' && inp.latched)) {
      this.setPhase('descent', t);
    }
    if (this.sequence.phase === 'descent' && encounter) this.setPhase(this.focus ? 'encounter' : 'world', t);
    if (this.sequence.phase === 'descent' && !inp.latched && !this.focus) this.setPhase('none', t);
    const veilTarget = this.sequence.phase === 'none' || this.sequence.phase === 'descent' ? 0 : 1;
    this.sequence.veil = approach(this.sequence.veil, veilTarget, dtS / VEIL_S);
    this.sequence.sinceS = (t - this.phaseStart) * 60;

    // ---- arrivals ----
    if (!this.focus && t >= this.arriveAt) {
      const at = this.arriveAt;
      this.arriveAt = Infinity;
      const n = this.entities.length;
      // a forced (scrub) entity wraps around the list; a natural one comes only while beings remain
      if (n > 0 && (forced || (encounter && this.nextEntity < n))) out.push(...this.appear(this.nextEntity++ % n, at, t));
    }

    // ---- beats, depart, fields of the focus entity ----
    const f = this.focus;
    if (f) {
      // scheduled beats (catch up in order if a frame spans several)
      while (f.departAt === Infinity && f.beatIdx + 1 < f.beatTimes.length && t >= f.beatTimes[f.beatIdx + 1]) {
        const i = ++f.beatIdx;
        const b = f.spec.behaviours[i] ?? 'depart';
        if (b === 'depart' && forced) {
          // a forced (scrub) entity stays: cycle back to the second beat instead of leaving
          if (f.spec.behaviours.length > 2) { f.beatIdx = 0; this.rebaseBeats(f, f.beatTimes[i]); }
          else { f.beatIdx = i - 1; f.beatTimes[i] = Infinity; }
          continue;
        }
        out.push(this.beatEvent(f, i, b, f.beatTimes[i]));
        if (b === 'depart') this.startDepart(f, f.beatTimes[i], f.intervals[i] ?? EARLY_DEPART_S);
      }
      // descent: a present entity departs early
      if (!encounter && f.departAt === Infinity) {
        out.push(this.beatEvent(f, f.beatIdx + 1, 'depart', t, true));
        this.startDepart(f, t, EARLY_DEPART_S);
      }
      this.advanceEntity(f, t, dtS);
      if (f.departAt !== Infinity && (t - f.departAt) * 60 >= f.departDur) {
        // gone; the next planned entity may arrive while the encounter lasts
        this.focus = null;
        Object.assign(this.entity, { present: false, intensity: 0, behaviour: null });
        if (encounter && this.nextEntity < this.entities.length) this.arriveAt = t + this.arrivalDelayS(this.nextEntity) * S;
        if (this.sequence.phase === 'encounter') this.setPhase('world', t);
      }
    }

    // ---- message at the entity's most intense moment ----
    if (!this.messageDone && this.focus && t >= this.messageAt) {
      this.showMessage(t, out);
    } else if (!this.messageDone && this.focus && this.messagePlanned && this.focus.departAt !== Infinity
      && (this.focus.departAt - this.focus.appearAt) * 60 >= 3 && t >= this.focus.departAt) {
      // the descent cut the encounter short before the planned peak beat: the message comes as the
      // entity turns away, its last intense moment (D-D2)
      this.showMessage(this.focus.departAt, out);
    }
    if (this.messageShownAt >= 0) {
      if (this.messageLoop && (t - this.messageShownAt) * 60 >= MESSAGE_SHOW_S + 3) this.messageShownAt = t;
      const ms = (t - this.messageShownAt) * 60;
      this.message.t = ms;
      this.message.intensity = messageEnvelope(ms);
      this.message.active = ms < MESSAGE_SHOW_S;
      this.message.present = this.message.active;
    }
    this.forcedMessage = false;

    // ---- difficult passage ----
    this.updateChallenge(inp, t, dtS, pastPeak, out);

    out.sort((a, b) => a.t_min - b.t_min);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // entities

  private arrivalDelayS(i: number): number {
    const planned = Number(this.entities[i]?.arrival_s);
    const r = uniform(this.rng, ENTITY_DELAY_S[0], ENTITY_DELAY_S[1]); // always drawn: keeps the stream aligned
    return Number.isFinite(planned) && planned > 0 ? clamp(planned, ENTITY_DELAY_S[0], ENTITY_DELAY_S[1]) : r;
  }

  private appear(i: number, at: number, now: number): DirectorEvent[] {
    const spec = this.entities[i];
    const behaviours = spec.behaviours?.length ? [...spec.behaviours] : ['approach', 'depart'];
    if (behaviours[0] !== 'approach') behaviours.unshift('approach');
    if (behaviours[behaviours.length - 1] !== 'depart') behaviours.push('depart');
    const planned = Array.isArray(spec.beats) ? spec.beats as { behaviour?: string; at_s?: number; duration_s?: number }[] : [];
    const intervals: number[] = [];
    for (let k = 0; k < behaviours.length; k++) {
      const r = uniform(this.rng, BEAT_INTERVAL_S[0], BEAT_INTERVAL_S[1]);
      const p = planned[k];
      let d = Number(p?.duration_s);
      if (!Number.isFinite(d) && planned[k + 1]) d = Number(planned[k + 1].at_s) - Number(p?.at_s);
      intervals.push(Number.isFinite(d) && d > 0 ? clamp(d, BEAT_INTERVAL_S[0], BEAT_INTERVAL_S[1]) : r);
    }
    const side = this.rng() < 0.5 ? -1 : 1;
    const f: Focus = { index: i, spec: { ...spec, behaviours }, appearAt: at, intervals, beatTimes: [], beatIdx: -1, side,
      departAt: Infinity, departDur: 0, departFrom: 0, morphPhase: this.rng() * VARIANTS };
    this.rebaseBeats(f, at);
    this.focus = f;
    Object.assign(this.entity, { present: true, index: i, type: spec.type ?? null, behaviour: null, beat: 0, since: at,
      intensity: 0, depth: START_DEPTH, position: [START_POS[0] * side, START_POS[1]] as [number, number] });
    this.entity.variant = Math.floor(f.morphPhase) % VARIANTS;
    this.entity.morph = 0;
    if (this.sequence.phase !== 'veil') this.setPhase('encounter', at);

    // the message belongs to the first entity met, at its most intense planned beat
    if (!this.messageDone && this.messagePlanned && this.messageAt === Infinity) {
      let best = 0;
      for (let k = 1; k < behaviours.length; k++) if ((BEAT_LEVEL[behaviours[k]] ?? 0.8) > (BEAT_LEVEL[behaviours[best]] ?? 0.8)) best = k;
      this.messageAt = Math.max(at + 3 * S, f.beatTimes[best] + Math.min(2, intervals[best] / 4) * S);
    }
    if (this.forcedMessage) this.messageAt = Math.min(this.messageAt, now);

    const ev: DirectorEvent[] = [{ t_min: at, type: 'entity_appear', payload: { index: i, type: spec.type, label: spec.label ?? null,
      disposition: spec.disposition ?? null, procedural: !!spec.procedural } }];
    // the first beat ('approach') starts with the appearance; later beats come from update()
    f.beatIdx = 0;
    ev.push(this.beatEvent(f, 0, behaviours[0], at));
    return ev;
  }

  /** Beat start times from `from` (the time of beat f.beatIdx + 1 … ) using the drawn intervals. */
  private rebaseBeats(f: Focus, from: number): void {
    const n = f.spec.behaviours.length;
    f.beatTimes = new Array(n).fill(0);
    let at = from;
    if (f.beatIdx < 0) {
      for (let k = 0; k < n; k++) { f.beatTimes[k] = at; at += f.intervals[k] * S; }
    } else {
      // forced entity cycling: beat beatIdx + 1 starts at `from`
      for (let k = 0; k < n; k++) f.beatTimes[k] = -Infinity;
      for (let k = f.beatIdx + 1; k < n; k++) { f.beatTimes[k] = at; at += f.intervals[k] * S; }
    }
  }

  private beatEvent(f: Focus, i: number, b: string, at: number, early = false): DirectorEvent {
    this.entity.behaviour = b;
    this.entity.beat = i + 1;
    const payload: Record<string, unknown> = { index: f.index, type: f.spec.type, behaviour: b, beat: i + 1 };
    if (early) payload.early = true;
    return { t_min: at, type: 'entity_behaviour', payload };
  }

  private startDepart(f: Focus, at: number, durS: number): void {
    f.departAt = at;
    f.departDur = Math.max(2, durS);
    f.departFrom = Math.max(this.entity.intensity, 0.3);
    this.entity.behaviour = 'depart';
  }

  /** Per-frame entity fields from model time (exponential smoothing, frame-rate independent). */
  private advanceEntity(f: Focus, t: number, dtS: number): void {
    const e = this.entity;
    const b = e.behaviour ?? 'approach';
    const sinceAppearS = (t - f.appearAt) * 60;
    const fadeIn = clamp(sinceAppearS / ENTITY_FADE_IN_S, 0, 1);
    // intensity: planned beat level × fade-in; the message makes the entity flare (it "speaks")
    let target = (BEAT_LEVEL[b] ?? 0.8) * fadeIn;
    if (this.messageShownAt >= 0 && this.message.active) target = Math.max(target, this.message.intensity * fadeIn);
    if (f.departAt !== Infinity) {
      const p = clamp(((t - f.departAt) * 60) / f.departDur, 0, 1);
      e.intensity = f.departFrom * (1 - p);
    } else {
      e.intensity = smoothTo(e.intensity, target, dtS, 1.5);
    }
    // depth and position
    const tau = b === 'approach' || b === 'depart' ? 4 : 3;
    e.depth = smoothTo(e.depth, BEAT_DEPTH[b] ?? 0.7, dtS, tau);
    const pt = BEAT_POS[b] ?? [0, 0];
    const sway = 0.03 * Math.sin(2 * Math.PI * 0.07 * t * 60 + f.index);
    const tx = clamp(pt[0] * f.side + sway, -1, 1);
    const ty = clamp(pt[1] + 0.5 * sway, -1, 1);
    e.position = [smoothTo(e.position[0], tx, dtS, tau), smoothTo(e.position[1], ty, dtS, tau)];
    // self-transforming: variants a → b → c by crossfade; faster while transforming
    const period = b === 'transform' ? 3.5 : 9;
    f.morphPhase = (f.morphPhase + dtS / period) % VARIANTS;
    e.variant = Math.floor(f.morphPhase) % VARIANTS;
    e.morph = smoothstep(0.6, 1, f.morphPhase - Math.floor(f.morphPhase));
  }

  private showMessage(at: number, out: DirectorEvent[]): void {
    this.messageDone = true;
    this.messageShownAt = at;
    const msg = this.script?.breakthrough?.message;
    out.push({ t_min: at, type: 'message_shown', payload: { index: this.focus?.index ?? 0,
      glyph_seed: msg?.glyph_seed ?? this.message.glyphSeed, theme: this.message.theme } });
  }

  private setPhase(p: SequencePhase, t: number): void {
    if (this.sequence.phase === p) return;
    this.sequence.phase = p;
    this.phaseStart = t;
    this.sequence.sinceS = 0;
  }

  // ---------------------------------------------------------------------------------------------
  // difficult passage

  /** Hazard rate per second (BUILD.md 11.7). */
  static hazard(surrender: number, held: boolean): number {
    return CHALLENGE.lambda0 * (1 + CHALLENGE.surrenderGain * surrender) + (held ? CHALLENGE.lambdaHold : 0);
  }

  private updateChallenge(inp: DirectorInput, t: number, dtS: number, pastPeak: boolean, out: DirectorEvent[]): void {
    if (this.opts.gentle) {
      // gentle mode: never a passage; at most one fear flicker after a strong peak (no events)
      if (this.flickerState === 'idle' && pastPeak && this.maxV >= 6) {
        this.flickerState = 'decided';
        if (this.hazardRng() < CHALLENGE.gentleFlickerP) {
          this.flickerFrom = t + 5 * S;
          this.flickerUntil = this.flickerFrom + CHALLENGE.gentleFlickerS * S;
          this.flickers.push({ t_min: this.flickerFrom, duration_s: CHALLENGE.gentleFlickerS });
        } else {
          this.flickerState = 'done';
        }
      }
      const on = this.flickerFrom >= 0 && t >= this.flickerFrom && t < this.flickerUntil;
      this.challenge.active = false;
      this.challenge.relief = 0;
      this.challenge.level = on ? approach(this.challenge.level, CHALLENGE.gentleFlickerLevel, dtS / 1.5)
        : approach(this.challenge.level, 0, dtS / 3);
      return;
    }
    if (this.challengeState === 'waiting') {
      if (this.challengeStartAt === Infinity && pastPeak) this.challengeStartAt = t + Math.max(0, this.offsetS) * S;
      if (t >= this.challengeStartAt) {
        const at = this.challengeStartAt;
        this.challengeState = 'active';
        this.challengeBegan = at;
        this.nextHazardTick = at + S;
        this.challenge.active = true;
        this.challenge.relief = 0;
        out.push({ t_min: at, type: 'challenge_start', payload: { flavour: this.script?.challenge?.flavour ?? null } });
      }
    }
    if (this.challengeState === 'active') {
      let resolvedAt: number | null = null;
      while (t >= this.nextHazardTick && resolvedAt === null) {
        const p = 1 - Math.exp(-Director.hazard(this.opts.surrender, inp.letGo));
        const elapsedS = (this.nextHazardTick - this.challengeBegan) * 60;
        if (this.hazardRng() < p || elapsedS >= CHALLENGE.capS - 1e-9) resolvedAt = this.nextHazardTick;
        this.nextHazardTick += S;
      }
      if (resolvedAt !== null) {
        this.challengeState = 'relief';
        this.challengeResolvedAt = resolvedAt;
        this.challenge.active = false;
        const durS = Math.round((resolvedAt - this.challengeBegan) * 60 * 10) / 10;
        out.push({ t_min: resolvedAt, type: 'challenge_resolve', payload: { duration_s: durS, capped: durS >= CHALLENGE.capS } });
      }
    }
    if (this.challengeState === 'active') {
      this.challenge.level = approach(this.challenge.level, 1, dtS / CHALLENGE.rampS);
    } else {
      this.challenge.level = approach(this.challenge.level, 0, dtS / 3);
    }
    if (this.challengeState === 'relief') {
      const sinceS = (t - this.challengeResolvedAt) * 60;
      this.challenge.relief = sinceS < CHALLENGE.reliefS ? 1 - Math.max(0, sinceS - (CHALLENGE.reliefS - 3)) / 3 : 0;
      if (sinceS >= CHALLENGE.reliefS) { this.challenge.relief = 0; this.challengeState = 'done'; }
    }
  }

  /** Session ends (fade or Escape): an active difficult passage always resolves. */
  endNow(tMin: number): DirectorEvent[] {
    if (this.challengeState !== 'active') return [];
    this.challengeState = 'done';
    this.challenge.active = false;
    this.challenge.level = 0;
    const durS = Math.round((tMin - this.challengeBegan) * 60 * 10) / 10;
    return [{ t_min: tMin, type: 'challenge_resolve', payload: { duration_s: durS, capped: false, ended: true } }];
  }

  // ---- debug forcing (scrubber); still deterministic given the same calls ----

  /** Bring the next entity in now and keep it (no depart) regardless of the intensity. */
  forceEntity(tMin: number): void {
    if (this.entities.length === 0 || this.focus) { this.forcedEntity = this.entities.length > 0; return; }
    this.forcedEntity = true;
    this.arriveAt = tMin;
    if (this.sequence.phase === 'none') this.setPhase('world', tMin);
  }

  /** Show the message now (bringing an entity if none is present). `loop` (scrub/galleries): keep it
   *  cycling, MESSAGE_SHOW_S shown and 3 s pause, with the entity flaring each time; logged once. */
  forceMessage(tMin: number, loop = false): void {
    if (!this.focus) this.forceEntity(tMin);
    if (loop) this.messageLoop = true;
    if (this.messageDone) return;
    this.messageAt = tMin;
    this.forcedMessage = true;
  }

  /** Force a difficult passage now. Never in gentle mode. */
  forceChallenge(tMin: number): void {
    if (this.opts.gentle) return;
    if (this.challengeState === 'active') return;
    this.challengeState = 'waiting';
    this.challengeStartAt = tMin;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function approach(x: number, target: number, step: number): number {
  if (x < target) return Math.min(target, x + step);
  return Math.max(target, x - step);
}

function smoothTo(x: number, target: number, dtS: number, tauS: number): number {
  return target + (x - target) * Math.exp(-dtS / tauS);
}

function smoothstep(a: number, b: number, x: number): number {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}
