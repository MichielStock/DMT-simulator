// Director (skeleton): drives entities, behaviour beats, the message and difficult passages from
// the trip script (BUILD.md section 11.7). Deterministic for a seed and an intensity trajectory:
// all randomness comes from a seeded mulberry32 stream and every timed decision uses model time.
// It emits events (to be logged by the caller) and keeps entity/message/challenge fields that
// main.ts copies into the shared state for the layers.

import type { TripScript } from './api';
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
  lambdaHold: 1 / 10,   // per second while space is held
  capS: 90,             // hard cap
  reliefS: 15,          // relief beat after resolution
  rampS: 5,
  gentleFlickerS: 4,    // gentle mode: brief fear flicker only, at most 5 s, no challenge events
};
export const ENTITY_DELAY_S: [number, number] = [5, 20];
export const BEAT_INTERVAL_S: [number, number] = [8, 15];
export const MESSAGE_SHOW_S = 12;

const S = 1 / 60; // one second in minutes

export class Director {
  readonly entity = { present: false, index: -1, type: null as string | null, behaviour: null as string | null,
    beat: 0, since: 0, intensity: 0 };
  readonly challenge = { active: false, level: 0, relief: 0 };
  readonly message = { active: false, t: 0 };

  private rng: Rng;
  private hazardRng: Rng;
  private latchedOnce = false;
  private appearAt: number[] = [];       // scheduled appearance times (min), one per entity
  private appeared = 0;
  private nextBeatAt = Infinity;
  private beatIdx = 0;
  private messageDone = false;
  private messageAt = Infinity;
  private maxV = 0;
  private maxVSinceAppear = 0;
  private challengeState: 'idle' | 'waiting' | 'active' | 'relief' | 'done' = 'idle';
  private challengeStartAt = Infinity;
  private challengeBegan = 0;
  private challengeResolvedAt = 0;
  private nextHazardTick = 0;
  private flickerUntil = -1;
  private lastT = 0;
  private offsetS = 0;

  constructor(private script: TripScript | null, seed: number, private opts: DirectorOptions) {
    this.rng = mulberry32(deriveSeed(seed, 'director'));
    this.hazardRng = mulberry32(deriveSeed(seed, 'challenge'));
    const ch = script?.challenge;
    if (ch?.occurs) {
      this.challengeState = 'waiting';
      // onset_offset_s: seconds relative to the predicted peak (trip_script schema). With
      // predicted.peak_time_min the start is fixed in advance; otherwise it is placed relative to
      // the observed peak (first moment the visual intensity falls from its maximum).
      this.offsetS = Number.isFinite(ch.onset_offset_s as number) ? (ch.onset_offset_s as number) : 0;
      const pk = (script?.predicted as { peak_time_min?: number } | undefined)?.peak_time_min;
      if (typeof pk === 'number' && Number.isFinite(pk)) this.challengeStartAt = Math.max(0, pk + this.offsetS * S);
    }
  }

  get entities() {
    return this.script?.breakthrough?.entities ?? [];
  }

  update(inp: DirectorInput): DirectorEvent[] {
    const out: DirectorEvent[] = [];
    const t = inp.tMin;
    const dtS = Math.max(0, (t - this.lastT) * 60);
    this.lastT = t;
    const pastPeak = this.maxV >= 0.5 && inp.visual < this.maxV - 0.02;
    this.maxV = Math.max(this.maxV, inp.visual);

    // ---- breakthrough latch → schedule entity appearances ----
    if (inp.latched && !this.latchedOnce) {
      this.latchedOnce = true;
      let at = t;
      for (let i = 0; i < this.entities.length; i++) {
        at += uniform(this.rng, ENTITY_DELAY_S[0], ENTITY_DELAY_S[1]) * S;
        this.appearAt.push(at);
      }
    }
    while (this.appeared < this.appearAt.length && t >= this.appearAt[this.appeared] && (inp.latched || this.appeared === 0 && this.forcedEntity)) {
      const i = this.appeared++;
      const ent = this.entities[i];
      const at = this.appearAt[i];
      out.push({ t_min: at, type: 'entity_appear', payload: { index: i, type: ent.type, label: ent.label ?? null,
        disposition: ent.disposition ?? null, procedural: !!ent.procedural } });
      if (i === 0) {
        Object.assign(this.entity, { present: true, index: 0, type: ent.type, behaviour: null, beat: 0, since: at });
        this.nextBeatAt = at + uniform(this.rng, BEAT_INTERVAL_S[0], BEAT_INTERVAL_S[1]) * S;
        this.maxVSinceAppear = inp.visual;
        if (this.script?.breakthrough?.message?.present) this.messageAt = at + 3 * S; // earliest
      }
    }

    // ---- behaviour beats for the first (focus) entity ----
    if (this.entity.present && t >= this.nextBeatAt) {
      const ent = this.entities[this.entity.index];
      const beats = ent?.behaviours ?? [];
      if (this.beatIdx < beats.length && (inp.latched || this.forcedEntity)) {
        const b = beats[this.beatIdx++];
        out.push({ t_min: this.nextBeatAt, type: 'entity_behaviour', payload: { index: this.entity.index, type: ent.type, behaviour: b, beat: this.beatIdx } });
        this.entity.behaviour = b;
        this.entity.beat = this.beatIdx;
        this.nextBeatAt += uniform(this.rng, BEAT_INTERVAL_S[0], BEAT_INTERVAL_S[1]) * S;
      } else {
        this.nextBeatAt = Infinity;
      }
    }
    if (this.entity.present) {
      this.maxVSinceAppear = Math.max(this.maxVSinceAppear, inp.visual);
      const target = inp.latched || this.forcedEntity ? 1 : 0;
      this.entity.intensity = approach(this.entity.intensity, target, dtS / 3);
      if (!inp.latched && !this.forcedEntity && this.entity.intensity <= 0) this.entity.present = false;
    }

    // ---- message at the most intense moment of the encounter ----
    if (!this.messageDone && this.entity.present && t >= this.messageAt) {
      const declining = inp.visual < this.maxVSinceAppear - 0.02;
      const leaving = !inp.latched;
      if (declining || leaving || this.forcedMessage) {
        this.messageDone = true;
        const msg = this.script?.breakthrough?.message;
        out.push({ t_min: t, type: 'message_shown', payload: { index: this.entity.index, glyph_seed: msg?.glyph_seed ?? null } });
        this.message.active = true;
        this.message.t = 0;
      }
    }
    if (this.message.active) {
      this.message.t += dtS;
      if (this.message.t > MESSAGE_SHOW_S) this.message.active = false;
    }

    // ---- difficult passage ----
    if (this.challengeState === 'waiting') {
      if (this.opts.gentle) {
        // gentle mode: never a challenge; a brief fear flicker at the peak instead (no events)
        if (pastPeak && this.flickerUntil < 0) this.flickerUntil = t + CHALLENGE.gentleFlickerS * S;
      } else {
        if (this.challengeStartAt === Infinity && pastPeak) this.challengeStartAt = t + Math.max(0, this.offsetS) * S;
      }
      if (!this.opts.gentle && t >= this.challengeStartAt) {
        const at = this.challengeStartAt;
        this.challengeState = 'active';
        this.challengeBegan = at;
        this.nextHazardTick = at + S;
        this.challenge.active = true;
        out.push({ t_min: at, type: 'challenge_start', payload: { flavour: this.script?.challenge?.flavour ?? null } });
      }
    }
    if (this.challengeState === 'active') {
      let resolvedAt: number | null = null;
      while (t >= this.nextHazardTick && resolvedAt === null) {
        const lam = CHALLENGE.lambda0 * (1 + 0.1 * this.opts.surrender) + (inp.letGo ? CHALLENGE.lambdaHold : 0);
        const p = 1 - Math.exp(-lam);
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
    } else if (this.flickerUntil >= 0 && t < this.flickerUntil) {
      this.challenge.level = approach(this.challenge.level, 0.3, dtS / 1.5);
    } else {
      this.challenge.level = approach(this.challenge.level, 0, dtS / 3);
    }
    if (this.challengeState === 'relief') {
      const sinceS = (t - this.challengeResolvedAt) * 60;
      this.challenge.relief = sinceS < CHALLENGE.reliefS ? 1 - Math.max(0, sinceS - (CHALLENGE.reliefS - 3)) / 3 : 0;
      if (sinceS >= CHALLENGE.reliefS) { this.challenge.relief = 0; this.challengeState = 'done'; }
    }

    out.sort((a, b) => a.t_min - b.t_min);
    this.forcedMessage = false;
    return out;
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
  private forcedEntity = false;
  private forcedMessage = false;

  forceEntity(tMin: number): void {
    if (this.entities.length === 0 || this.appeared > 0) return;
    this.forcedEntity = true;
    this.latchedOnce = true;
    this.appearAt = [tMin];
  }

  forceMessage(tMin: number): void {
    if (!this.entity.present) this.forceEntity(tMin);
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

function approach(x: number, target: number, step: number): number {
  if (x < target) return Math.min(target, x + step);
  return Math.max(target, x - step);
}
