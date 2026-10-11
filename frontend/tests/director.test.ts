// Director: event order for fixed seeds with a synthetic intensity trajectory (BUILD.md 16.2).
import { describe, expect, it } from 'vitest';
import { Director, CHALLENGE, BEAT_LEVEL, MESSAGE_SHOW_S, VEIL_S, messageEnvelope, type DirectorEvent } from '../src/director';
import type { TripScript } from '../src/api';

function script(over: Partial<TripScript> = {}): TripScript {
  return {
    version: 1,
    seed: 1,
    pharmacology: { dose_step: 'breakthrough', dose_rel: 4, hold_fraction: 1, sensitivity: 1, clearance: 1,
      params: { ka: 4, k10: 0.12, k12: 0.2, k21: 0.03, ke0: [2.5, 1.2, 0.6], h: 2 } },
    predicted: { peak_visual: 8.6, deepest_layer: 'breakthrough', minutes_above_8: 1.5 },
    palette: { name: 'jewel', colours: ['#ffb000', '#4fe3ff'] },
    room: { source: 'default', image: null, depth: null },
    layers: {},
    breakthrough: {
      reached: true,
      world: null,
      entities: [{ type: 'jester', label: 'guide', behaviours: ['approach', 'greet', 'present_object', 'transform', 'depart'] }],
      message: { present: true, sealed_text: 'attention is a kind of play', glyph_seed: 42 },
    },
    challenge: { occurs: false, onset_offset_s: null, flavour: null },
    ...over,
  };
}

/** Synthetic trajectory: rise to 9 at 1.8 min, fall to 0 by 12 min. */
function v(t: number): number {
  if (t < 1.8) return 9 * Math.sin((t / 1.8) * (Math.PI / 2));
  return Math.max(0, 9 * (1 - (t - 1.8) / 10.2));
}

function run(sc: TripScript, seed: number, opts = { gentle: false, surrender: 5 }, letGo = false, dt = 1 / 600): DirectorEvent[] {
  const d = new Director(sc, seed, opts);
  const out: DirectorEvent[] = [];
  let latched = false;
  for (let t = 0; t <= 12; t += dt) {
    const x = v(t);
    if (x >= 8) latched = true;
    else if (x < 6.5) latched = false;
    out.push(...d.update({ tMin: t, visual: x, latched, letGo }));
  }
  return out;
}

const types = (e: DirectorEvent[]) => e.map((x) => x.type);

describe('director', () => {
  it('emits entity_appear 5–20 s after the latch, then behaviour beats, then the message', () => {
    const ev = run(script(), 123);
    const latchT = (() => { for (let t = 0; t < 12; t += 1 / 600) if (v(t) >= 8) return t; return NaN; })();
    const appear = ev.find((e) => e.type === 'entity_appear')!;
    expect(appear).toBeDefined();
    const dS = (appear.t_min - latchT) * 60;
    expect(dS).toBeGreaterThanOrEqual(5 - 0.2);
    expect(dS).toBeLessThanOrEqual(20 + 0.2);
    expect(ev[0].type).toBe('entity_appear');
    const beats = ev.filter((e) => e.type === 'entity_behaviour');
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0].payload.behaviour).toBe('approach');
    for (let i = 1; i < beats.length; i++) {
      const gap = (beats[i].t_min - beats[i - 1].t_min) * 60;
      expect(gap).toBeGreaterThanOrEqual(8 - 1e-6);
      expect(gap).toBeLessThanOrEqual(15 + 1e-6);
    }
    expect(types(ev).filter((t) => t === 'message_shown')).toHaveLength(1);
    const msg = ev.find((e) => e.type === 'message_shown')!;
    expect(msg.t_min).toBeGreaterThan(appear.t_min);
    expect(msg.payload.glyph_seed).toBe(42);
    expect(JSON.stringify(ev)).not.toContain('attention is a kind of play'); // words only in the report
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const a = run(script(), 7), b = run(script(), 7), c = run(script(), 8);
    expect(a).toEqual(b);
    expect(a.map((e) => e.t_min)).not.toEqual(c.map((e) => e.t_min));
  });

  it('is independent of the update step (frame rate)', () => {
    const a = run(script(), 99, undefined, false, 1 / 600);
    const b = run(script(), 99, undefined, false, 1 / 150);
    expect(types(a)).toEqual(types(b));
    a.filter((e) => e.type !== 'message_shown').forEach((e, i) => {
      const f = b.filter((x) => x.type !== 'message_shown')[i];
      expect(Math.abs(e.t_min - f.t_min)).toBeLessThanOrEqual(1 / 150 + 1e-9); // latch seen one step later at most
    });
  });

  it('fixed seed event order snapshot', () => {
    const ev = run(script({ challenge: { occurs: true, onset_offset_s: 10, flavour: 'pressure' } }), 2026);
    expect(types(ev)).toMatchInlineSnapshot(`
      [
        "entity_appear",
        "entity_behaviour",
        "entity_behaviour",
        "entity_behaviour",
        "entity_behaviour",
        "message_shown",
        "challenge_start",
        "entity_behaviour",
        "challenge_resolve",
      ]
    `);
  });

  it('starts a challenge near the peak, resolves it within 90 s', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const ev = run(script({ challenge: { occurs: true, onset_offset_s: 10, flavour: 'pressure' } }), seed, { gentle: false, surrender: 0 });
      const s = ev.find((e) => e.type === 'challenge_start')!;
      const r = ev.find((e) => e.type === 'challenge_resolve')!;
      expect(s).toBeDefined();
      expect(r).toBeDefined();
      expect(r.t_min).toBeGreaterThan(s.t_min);
      expect((r.t_min - s.t_min) * 60).toBeLessThanOrEqual(CHALLENGE.capS + 1e-6);
      // near the peak (1.8 min) + 10 s offset
      expect(Math.abs(s.t_min - (1.8 + 10 / 60))).toBeLessThan(0.05);
    }
  });

  it('uses predicted.peak_time_min when present', () => {
    const sc = script({ challenge: { occurs: true, onset_offset_s: -20, flavour: 'dissolution' } });
    (sc.predicted as any).peak_time_min = 1.8;
    const ev = run(sc, 5);
    const s = ev.find((e) => e.type === 'challenge_start')!;
    expect(s.t_min).toBeCloseTo(1.8 - 20 / 60, 6);
  });

  it('letting go (space held) resolves faster on average', () => {
    const sc = script({ challenge: { occurs: true, onset_offset_s: 0, flavour: 'pursuit' } });
    const dur = (letGo: boolean) => {
      let sum = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const ev = run(sc, seed, { gentle: false, surrender: 5 }, letGo, 1 / 120);
        const s = ev.find((e) => e.type === 'challenge_start')!;
        const r = ev.find((e) => e.type === 'challenge_resolve')!;
        sum += r.t_min - s.t_min;
      }
      return sum / 30;
    };
    expect(dur(true)).toBeLessThan(dur(false));
  });

  it('gentle mode never emits challenge events', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const ev = run(script({ challenge: { occurs: true, onset_offset_s: 0, flavour: 'pressure' } }), seed, { gentle: true, surrender: 5 });
      expect(types(ev)).not.toContain('challenge_start');
      expect(types(ev)).not.toContain('challenge_resolve');
    }
  });

  it('no breakthrough latch, no entity', () => {
    const d = new Director(script(), 1, { gentle: false, surrender: 5 });
    const ev: DirectorEvent[] = [];
    for (let t = 0; t < 10; t += 1 / 60) ev.push(...d.update({ tMin: t, visual: Math.min(6, t * 3), latched: false, letGo: false }));
    expect(ev).toHaveLength(0);
  });

  it('endNow resolves an active challenge', () => {
    const d = new Director(script({ challenge: { occurs: true, onset_offset_s: 0, flavour: 'pressure' } }), 3, { gentle: false, surrender: 0 });
    let started = false;
    let t = 0;
    for (; t < 3 && !started; t += 1 / 600) {
      started = d.update({ tMin: t, visual: v(t), latched: v(t) >= 8, letGo: false }).some((e) => e.type === 'challenge_start');
    }
    expect(started).toBe(true);
    const r = d.endNow(t);
    expect(r.map((e) => e.type)).toEqual(['challenge_resolve']);
  });
});

// ---------------------------------------------------------------------------------------------
// M9 director (BUILD.md 11.7): schedule bounds, hazard expectation, cap, gentle mode, determinism

const BEHAVIOURS7 = ['approach', 'greet', 'present_object', 'show', 'work_on', 'transform', 'depart'];

function scriptN(n: number, over: Partial<TripScript> = {}): TripScript {
  const sc = script(over);
  sc.breakthrough.entities = Array.from({ length: n }, (_, i) => ({ type: i ? 'elf' : 'jester', label: 'being', behaviours: [...BEHAVIOURS7] }));
  return sc;
}

/** Long plateau above 8 (latched for ~4.5 min) then a slow fall. */
function plateau(t: number): number {
  if (t < 1) return 9 * t;
  if (t < 5.5) return 9;
  return Math.max(0, 9 - (t - 5.5) * 1.5);
}

function drive(d: Director, traj: (t: number) => number, until: number, dt = 1 / 600, letGo: (t: number) => boolean = () => false) {
  const out: DirectorEvent[] = [];
  let latched = false;
  const samples: { t: number; e: ReturnType<typeof snapshotEntity>; level: number; msg: number; phase: string; veil: number }[] = [];
  for (let i = 0; ; i++) {
    const t = i * dt;
    if (t > until + 1e-9) break;
    const x = traj(t);
    if (x >= 8) latched = true;
    else if (x < 6.5) latched = false;
    out.push(...d.update({ tMin: t, visual: x, latched, letGo: letGo(t) }));
    samples.push({ t, e: snapshotEntity(d), level: d.challenge.level, msg: d.message.intensity, phase: d.sequence.phase, veil: d.sequence.veil });
  }
  return { out, samples };
}

function snapshotEntity(d: Director) {
  const e = d.entity;
  return { present: e.present, intensity: e.intensity, depth: e.depth, x: e.position[0], y: e.position[1], variant: e.variant, morph: e.morph, behaviour: e.behaviour };
}

/** Durations (s) of difficult passages forced at t = 0.5 min with a constant intensity. */
function passageDurations(seeds: number, surrender: number, held: boolean): number[] {
  const out: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const d = new Director(script(), seed, { gentle: false, surrender });
    d.forceChallenge(0.5);
    let start = NaN;
    for (let i = 0; i < 1000; i++) {
      const t = 0.5 + i / 120;
      const ev = d.update({ tMin: t, visual: 6, latched: false, letGo: held });
      const s = ev.find((e) => e.type === 'challenge_start');
      if (s) start = s.t_min;
      const r = ev.find((e) => e.type === 'challenge_resolve');
      if (r) { out.push((r.t_min - start) * 60); break; }
    }
  }
  return out;
}

/** E[min(T, cap)] for one hazard draw per second with rate λ: Σ_{k=0}^{cap−1} q^k, q = e^−λ. */
function expectedPassage(lambda: number): number {
  const q = Math.exp(-lambda);
  return (1 - q ** CHALLENGE.capS) / (1 - q);
}

describe('director M9: breakthrough sequence', () => {
  it('entity arrives 5–20 s after the latch for every seed; first beat is approach at arrival', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { out } = drive(new Director(scriptN(1), seed, { gentle: false, surrender: 5 }), plateau, 3);
      const latchT = 8 / 9;
      const a = out.find((e) => e.type === 'entity_appear')!;
      expect(a, `seed ${seed}`).toBeDefined();
      const dS = (a.t_min - latchT) * 60;
      expect(dS).toBeGreaterThanOrEqual(5 - 0.11);
      expect(dS).toBeLessThanOrEqual(20 + 0.11);
      const b0 = out.find((e) => e.type === 'entity_behaviour')!;
      expect(b0.payload.behaviour).toBe('approach');
      expect(b0.t_min).toBeCloseTo(a.t_min, 9);
    }
  });

  it('uses the planner arrival_s (clamped to 5–20 s) when present', () => {
    const sc = scriptN(1);
    (sc.breakthrough.entities[0] as any).arrival_s = 31;
    const { out } = drive(new Director(sc, 3, { gentle: false, surrender: 5 }), plateau, 3);
    const a = out.find((e) => e.type === 'entity_appear')!;
    expect((a.t_min - 8 / 9) * 60).toBeCloseTo(20, 0);
  });

  it('behaviour beats follow the script order at 8–15 s intervals (all seeds), depart last', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { out } = drive(new Director(scriptN(1), seed, { gentle: false, surrender: 5 }), plateau, 5);
      const beats = out.filter((e) => e.type === 'entity_behaviour');
      expect(beats.map((b) => b.payload.behaviour)).toEqual(BEHAVIOURS7);
      for (let i = 1; i < beats.length; i++) {
        const gap = (beats[i].t_min - beats[i - 1].t_min) * 60;
        expect(gap, `seed ${seed} beat ${i}`).toBeGreaterThanOrEqual(8 - 1e-6);
        expect(gap).toBeLessThanOrEqual(15 + 1e-6);
      }
    }
  });

  it('planner beat durations are honoured but clamped to 8–15 s', () => {
    const sc = scriptN(1);
    (sc.breakthrough.entities[0] as any).beats = BEHAVIOURS7.map((b, i) => ({ behaviour: b, at_s: i * 5, duration_s: i === 2 ? 12 : 5 }));
    const { out } = drive(new Director(sc, 9, { gentle: false, surrender: 5 }), plateau, 5);
    const beats = out.filter((e) => e.type === 'entity_behaviour');
    const gaps = beats.slice(1).map((b, i) => Math.round((b.t_min - beats[i].t_min) * 60 * 1000) / 1000);
    expect(gaps).toEqual([8, 8, 12, 8, 8, 8]);
  });

  it('the message comes once, at the most intense planned beat, and lasts MESSAGE_SHOW_S', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const d = new Director(scriptN(1), seed, { gentle: false, surrender: 5 });
      const { out, samples } = drive(d, plateau, 5);
      const msgs = out.filter((e) => e.type === 'message_shown');
      expect(msgs).toHaveLength(1);
      const beats = out.filter((e) => e.type === 'entity_behaviour');
      const peak = beats.reduce((a, b) => (BEAT_LEVEL[String(b.payload.behaviour)] > BEAT_LEVEL[String(a.payload.behaviour)] ? b : a));
      expect(peak.payload.behaviour).toBe('work_on');
      const next = beats[beats.indexOf(peak) + 1];
      expect(msgs[0].t_min).toBeGreaterThanOrEqual(peak.t_min);
      expect(msgs[0].t_min).toBeLessThan(next.t_min);
      // on screen for MESSAGE_SHOW_S, with the entity at full intensity while it speaks
      const on = samples.filter((s) => s.msg > 0);
      const span = (on[on.length - 1].t - on[0].t) * 60;
      expect(span).toBeGreaterThan(MESSAGE_SHOW_S - 0.3);
      expect(span).toBeLessThanOrEqual(MESSAGE_SHOW_S);
      const mid = samples.find((s) => s.t >= msgs[0].t_min + 6 / 60)!;
      expect(mid.e.intensity).toBeGreaterThan(0.95);
      expect(msgs[0].payload.glyph_seed).toBe(42);
    }
    expect(messageEnvelope(1)).toBeCloseTo(0.5, 9);
    expect(messageEnvelope(MESSAGE_SHOW_S)).toBe(0);
  });

  it('entity fields stay in range and evolve (depth rises on approach, falls on depart)', () => {
    const { samples } = drive(new Director(scriptN(1), 4, { gentle: false, surrender: 5 }), plateau, 5);
    const pres = samples.filter((s) => s.e.present);
    expect(pres.length).toBeGreaterThan(100);
    for (const s of pres) {
      expect(s.e.intensity).toBeGreaterThanOrEqual(0); expect(s.e.intensity).toBeLessThanOrEqual(1);
      expect(s.e.depth).toBeGreaterThanOrEqual(0); expect(s.e.depth).toBeLessThanOrEqual(1);
      expect(Math.abs(s.e.x)).toBeLessThanOrEqual(1); expect(Math.abs(s.e.y)).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(s.e.variant);
      expect(s.e.morph).toBeGreaterThanOrEqual(0); expect(s.e.morph).toBeLessThanOrEqual(1);
    }
    const maxDepth = Math.max(...pres.map((s) => s.e.depth));
    expect(maxDepth).toBeGreaterThan(0.85); // work_on comes close
    expect(new Set(pres.map((s) => s.e.variant)).size).toBe(3); // self-transforming through a/b/c
    const last = pres[pres.length - 1];
    expect(last.e.behaviour).toBe('depart');
    expect(last.e.intensity).toBeLessThan(0.05);
  });

  it('veil lifts over ≥ 2 s after the latch; descent below v 7 makes a present entity depart early', () => {
    const d = new Director(scriptN(1), 5, { gentle: false, surrender: 5 });
    // latched at 8/9 min, falls below 7 at 1.6 min (the entity is mid-encounter)
    const traj = (t: number) => (t < 1 ? 9 * t : t < 1.5 ? 9 : Math.max(0, 9 - (t - 1.5) * 20));
    const { out, samples } = drive(d, traj, 2.5);
    const latch = samples.find((s) => s.phase === 'veil')!;
    const full = samples.find((s) => s.veil >= 0.999)!;
    expect((full.t - latch.t) * 60).toBeGreaterThanOrEqual(2);
    expect((full.t - latch.t) * 60).toBeLessThanOrEqual(VEIL_S + 0.2);
    const early = out.find((e) => e.type === 'entity_behaviour' && e.payload.early)!;
    expect(early).toBeDefined();
    expect(early.payload.behaviour).toBe('depart');
    expect(traj(early.t_min)).toBeLessThan(7);
    expect(samples.some((s) => s.phase === 'descent')).toBe(true);
    expect(samples[samples.length - 1].phase).toBe('none');
    expect(samples[samples.length - 1].e.present).toBe(false);
  });

  it('several beings arrive one after the other while the encounter lasts', () => {
    const traj = (t: number) => (t < 1 ? 9 * t : t < 6 ? 9 : Math.max(0, 9 - (t - 6) * 2));
    const { out } = drive(new Director(scriptN(3), 12, { gentle: false, surrender: 5 }), traj, 10);
    const app = out.filter((e) => e.type === 'entity_appear');
    expect(app.map((e) => e.payload.index)).toEqual([0, 1, 2]);
    const departs = out.filter((e) => e.type === 'entity_behaviour' && e.payload.behaviour === 'depart');
    for (let i = 1; i < app.length; i++) {
      const gapS = (app[i].t_min - departs[i - 1].t_min) * 60;
      expect(gapS).toBeGreaterThanOrEqual(5); // depart duration + 5–20 s arrival delay
    }
  });

  it('a forced (scrub) entity never departs', () => {
    const d = new Director(scriptN(1), 2, { gentle: false, surrender: 5 });
    d.forceEntity(0);
    const { out, samples } = drive(d, () => 3, 4);
    expect(out.filter((e) => e.type === 'entity_appear')).toHaveLength(1);
    expect(out.some((e) => e.type === 'entity_behaviour' && e.payload.behaviour === 'depart')).toBe(false);
    expect(samples[samples.length - 1].e.present).toBe(true);
    expect(samples[samples.length - 1].e.intensity).toBeGreaterThan(0.6);
  });
});

describe('director M9: scrub forcing', () => {
  it('a forced looping message cycles (12 s shown, 3 s pause), is logged once, and the entity flares each time', () => {
    const d = new Director(scriptN(1), 6, { gentle: false, surrender: 5 });
    d.forceMessage(0, true);
    const { out, samples } = drive(d, () => 9, 1);
    expect(out.filter((e) => e.type === 'message_shown')).toHaveLength(1);
    const at = (s: number) => samples.find((x) => x.t >= s / 60)!;
    expect(at(6).msg).toBe(1);
    expect(at(13.5).msg).toBe(0);
    expect(at(21).msg).toBe(1);   // second cycle (15 s period)
    expect(at(21).e.intensity).toBeGreaterThan(0.95);
  });
});

describe('director M9: difficult passages', () => {
  it('hazard rate matches the formula', () => {
    expect(Director.hazard(0, false)).toBeCloseTo(1 / 60, 12);
    expect(Director.hazard(5, false)).toBeCloseTo((1 / 60) * 1.5, 12);
    expect(Director.hazard(5, true)).toBeCloseTo((1 / 60) * 1.5 + 1 / 10, 12);
    expect(Director.hazard(10, true)).toBeCloseTo((1 / 60) * 2 + 1 / 10, 12);
  });

  it('mean passage length matches the hazard expectation (Monte Carlo over seeds), with and without space held', () => {
    for (const [surrender, held] of [[5, false], [5, true], [0, false], [10, true]] as [number, boolean][]) {
      const d = passageDurations(600, surrender, held);
      expect(d).toHaveLength(600);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const want = expectedPassage(Director.hazard(surrender, held));
      expect(Math.abs(mean - want) / want, `surrender ${surrender} held ${held}: mean ${mean.toFixed(2)} want ${want.toFixed(2)}`).toBeLessThan(0.1);
    }
    const free = passageDurations(300, 5, false), hold = passageDurations(300, 5, true);
    const m = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    expect(m(hold)).toBeLessThan(m(free) / 3); // ≈ 8.5 s vs ≈ 36 s
  });

  it('never exceeds the 90 s cap; capped passages say so and are followed by a 15 s relief beat', () => {
    let capped = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const d = new Director(script(), seed, { gentle: false, surrender: 0 });
      d.forceChallenge(0.5);
      let start = NaN, end = NaN;
      const relief: { t: number; r: number; active: boolean }[] = [];
      for (let i = 0; i < 300; i++) {
        const t = 0.5 + i / 120;
        for (const e of d.update({ tMin: t, visual: 6, latched: false, letGo: false })) {
          if (e.type === 'challenge_start') start = e.t_min;
          if (e.type === 'challenge_resolve') {
            end = e.t_min;
            const dur = (end - start) * 60;
            expect(dur).toBeLessThanOrEqual(CHALLENGE.capS + 1e-6);
            expect(e.payload.capped).toBe(dur >= CHALLENGE.capS - 1e-6);
            if (e.payload.capped) capped++;
          }
        }
        if (!Number.isNaN(end)) relief.push({ t: (t - end) * 60, r: d.challenge.relief, active: d.challenge.active });
      }
      expect(Number.isNaN(end)).toBe(false);
      expect(relief.find((x) => x.t > 1 && x.t < 10)!.r).toBe(1);
      expect(relief.find((x) => x.t > 15.5)!.r).toBe(0);
      expect(relief.every((x) => !x.active)).toBe(true);
    }
    expect(capped).toBeGreaterThan(5); // P(T > 90 s) = e^−1.5 ≈ 0.22 at surrender 0
  });

  it('gentle mode never starts a passage (not even forced), and has at most one fear flicker ≤ 5 s', () => {
    let withFlicker = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const d = new Director(scriptN(1, { challenge: { occurs: true, onset_offset_s: 10, flavour: 'pressure' } }), seed, { gentle: true, surrender: 5 });
      d.forceChallenge(1);
      const { out, samples } = drive(d, v, 8, 1 / 300);
      expect(types(out)).not.toContain('challenge_start');
      expect(types(out)).not.toContain('challenge_resolve');
      expect(samples.every((s) => s.level <= CHALLENGE.gentleFlickerLevel + 1e-9)).toBe(true);
      expect(d.flickers.length).toBeLessThanOrEqual(1);
      // measured: contiguous time with a visible fear level
      let runs = 0, longest = 0, cur = 0;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].level > 1e-6) { if (cur === 0) runs++; cur += 1 / 300 * 60; longest = Math.max(longest, cur); } else cur = 0;
      }
      expect(runs).toBeLessThanOrEqual(1);
      expect(longest).toBeLessThanOrEqual(CHALLENGE.gentleFlickerMaxS);
      if (runs) withFlicker++;
    }
    expect(withFlicker).toBeGreaterThan(20);
    expect(withFlicker).toBeLessThan(120);
  });
});

describe('director M9: determinism', () => {
  it('a replay with the same seed and the same intensity / input trajectory yields the same events and fields', () => {
    const sc = scriptN(2, { challenge: { occurs: true, onset_offset_s: 15, flavour: 'pursuit' } });
    const letGo = (t: number) => t > 2.2 && t < 2.4;
    const a = drive(new Director(sc, 777, { gentle: false, surrender: 3 }), plateau, 9, 1 / 600, letGo);
    const b = drive(new Director(structuredClone(sc), 777, { gentle: false, surrender: 3 }), plateau, 9, 1 / 600, letGo);
    expect(a.out).toEqual(b.out);
    expect(a.samples).toEqual(b.samples);
    const c = drive(new Director(sc, 778, { gentle: false, surrender: 3 }), plateau, 9, 1 / 600, letGo);
    expect(c.out).not.toEqual(a.out);
    // a different frame rate gives the same event sequence with times within one frame
    const f = drive(new Director(sc, 777, { gentle: false, surrender: 3 }), plateau, 9, 1 / 240, letGo);
    expect(types(f.out)).toEqual(types(a.out));
    f.out.forEach((e, i) => expect(Math.abs(e.t_min - a.out[i].t_min)).toBeLessThanOrEqual(1 / 240 + 1e-9));
  });
});
