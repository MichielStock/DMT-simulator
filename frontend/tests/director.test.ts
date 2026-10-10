// Director: event order for fixed seeds with a synthetic intensity trajectory (BUILD.md 16.2).
import { describe, expect, it } from 'vitest';
import { Director, CHALLENGE, type DirectorEvent } from '../src/director';
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
        "message_shown",
        "entity_behaviour",
        "challenge_start",
        "entity_behaviour",
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
