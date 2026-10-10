// Layer-weight windows, hysteresis and breakthrough latch (BUILD.md §11.2).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BREAKTHROUGH_FADE_IN_S, BREAKTHROUGH_FADE_OUT_S, LAYER_ORDER, WEIGHT_KEYS, advanceFade, computeLayerWeights,
  deepestLayer, initialLayerWeights, layerRank, smoothstep, type LayerWeights,
} from '../src/layerWeights';

/** Feed a sequence of v values through computeLayerWeights, returning the last result. */
function sweep(values: number[], start: LayerWeights | null = null): LayerWeights {
  let w = start;
  for (const v of values) w = computeLayerWeights(v, w);
  return w!;
}
const ramp = (a: number, b: number, step = 0.01) => {
  const out: number[] = [];
  const n = Math.round(Math.abs(b - a) / step);
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
};

describe('windows (rising)', () => {
  it('calm room at v = 0', () => {
    const w = initialLayerWeights();
    expect(w.room).toBe(1);
    for (const k of ['formConstants', 'chrysanthemum', 'waitingRoom', 'breakthrough'] as const) expect(w[k]).toBe(0);
    expect(w.roomDistortion).toBe(0);
  });

  it('smoothstep midpoints of each entry window', () => {
    expect(computeLayerWeights(1.25).roomDistortion).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(2.4).formConstants).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(4.7).chrysanthemum).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(7.2).waitingRoom).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(1.8).formConstants).toBe(0);
    expect(computeLayerWeights(3.0).formConstants).toBe(1);
    expect(computeLayerWeights(5.2).chrysanthemum).toBe(1);
    expect(computeLayerWeights(7.6).waitingRoom).toBe(1);
  });

  it('exit windows on the way up', () => {
    expect(computeLayerWeights(5.5).formConstants).toBe(1);
    expect(computeLayerWeights(6.25).formConstants).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(7.0).formConstants).toBe(0);
    expect(computeLayerWeights(7.0).fieldModulation).toBe(1); // stays as modulation
    expect(computeLayerWeights(7.7).chrysanthemum).toBeCloseTo(0.5, 9);
    expect(computeLayerWeights(8.2).chrysanthemum).toBe(0);
    expect(computeLayerWeights(6.8).room).toBe(1);
    expect(computeLayerWeights(7.5).room).toBe(0);
  });

  it('a slow rise visits the layers in order', () => {
    let w: LayerWeights | null = null;
    const firstFull: Record<string, number> = {};
    for (const v of ramp(0, 9)) {
      w = computeLayerWeights(v, w);
      for (const k of ['formConstants', 'chrysanthemum', 'waitingRoom', 'breakthrough'] as const) {
        if (w[k] >= 1 && firstFull[k] === undefined) firstFull[k] = v;
      }
    }
    expect(firstFull.formConstants).toBeLessThan(firstFull.chrysanthemum);
    expect(firstFull.chrysanthemum).toBeLessThan(firstFull.waitingRoom);
    expect(firstFull.waitingRoom).toBeLessThan(firstFull.breakthrough);
    expect(firstFull.breakthrough).toBeCloseTo(8.0, 6);
  });
});

describe('hysteresis (0.5 on exit)', () => {
  it('weights hold while v drops by less than 0.5', () => {
    const top = sweep(ramp(0, 3.0));
    expect(top.formConstants).toBe(1);
    const w = sweep(ramp(3.0, 2.55), top);
    expect(w.formConstants).toBe(1);
  });

  it('on the way down every threshold is 0.5 lower', () => {
    const up = sweep(ramp(0, 9));
    for (const v of [7.0, 6.0, 4.5, 3.2, 1.9, 1.0, 0.6]) {
      const down = sweep(ramp(9, v), up);
      const ref = computeLayerWeights(v + 0.5);
      for (const k of ['room', 'formConstants', 'chrysanthemum', 'waitingRoom', 'roomDistortion'] as const) {
        expect(down[k]).toBeCloseTo(ref[k], 9);
      }
    }
  });

  it('room distortion lingers mildly and is gone at v = 0', () => {
    const up = sweep(ramp(0, 6));
    const at05 = sweep(ramp(6, 0.5), up);
    expect(at05.roomDistortion).toBeGreaterThan(0.1);
    expect(at05.roomDistortion).toBeLessThan(0.5);
    expect(sweep(ramp(0.5, 0), at05).roomDistortion).toBe(0);
  });

  it('weights are continuous for small changes of v (no cuts)', () => {
    let w: LayerWeights | null = null;
    const seq = [...ramp(0, 9.5), ...ramp(9.5, 3), ...ramp(3, 7), ...ramp(7, 0)];
    for (const v of seq) {
      const n = computeLayerWeights(v, w);
      if (w) for (const k of ['room', 'formConstants', 'chrysanthemum', 'waitingRoom'] as const) {
        expect(Math.abs(n[k] - w[k])).toBeLessThan(0.05);
      }
      w = n;
    }
  });

  it('vEff stays within [v, v + 0.5]', () => {
    let w: LayerWeights | null = null;
    for (const v of [0, 3, 2.8, 2.2, 5, 4.9, 0]) {
      w = computeLayerWeights(v, w);
      expect(w.vEff).toBeGreaterThanOrEqual(v);
      expect(w.vEff).toBeLessThanOrEqual(v + 0.5 + 1e-12);
    }
  });
});

describe('breakthrough latch', () => {
  it('latches at v >= 8 and only releases below 6.5', () => {
    let w = sweep(ramp(0, 7.99));
    expect(w.breakthroughLatched).toBe(false);
    w = computeLayerWeights(8.0, w);
    expect(w.breakthroughLatched).toBe(true);
    expect(w.breakthrough).toBe(1);
    w = sweep(ramp(8.0, 6.5), w);
    expect(w.breakthroughLatched).toBe(true);
    w = computeLayerWeights(6.49, w);
    expect(w.breakthroughLatched).toBe(false);
    expect(w.breakthrough).toBe(0);
    w = sweep(ramp(6.49, 7.99), w);
    expect(w.breakthroughLatched).toBe(false);
  });

  it('is never latched without prior state below 8', () => {
    expect(computeLayerWeights(7.99).breakthroughLatched).toBe(false);
    expect(computeLayerWeights(Number.NaN).breakthroughLatched).toBe(false);
  });
});

describe('advanceFade', () => {
  const run = (prev: LayerWeights, target: LayerWeights, seconds: number, dt = 1 / 60) => {
    let w = prev;
    for (let t = 0; t < seconds - 1e-9; t += dt) w = advanceFade(w, target, dt);
    return w;
  };

  it('breakthrough fades in over at least 2 s and replaces the waiting room', () => {
    const before = sweep(ramp(0, 7.9));
    let shown = advanceFade(null, before, 1 / 60);
    shown = run(shown, before, 2);
    expect(shown.waitingRoom).toBeGreaterThan(0.9);
    const target = computeLayerWeights(8.1, before);
    const after1s = run(shown, target, 1.0);
    expect(after1s.breakthrough).toBeLessThan(0.5);
    expect(after1s.breakthrough).toBeGreaterThan(0.3);
    const after2s = run(after1s, target, 1.0);
    expect(after2s.breakthrough).toBeLessThan(1); // at least 2 s
    const full = run(after2s, target, BREAKTHROUGH_FADE_IN_S);
    expect(full.breakthrough).toBe(1);
    expect(full.waitingRoom).toBe(0);
  });

  it('release fades out over 20 s', () => {
    let target = sweep([...ramp(0, 8.5), ...ramp(8.5, 6.4)]);
    expect(target.breakthroughLatched).toBe(false);
    const shown: LayerWeights = { ...target, breakthrough: 1 };
    const half = run(shown, target, BREAKTHROUGH_FADE_OUT_S / 2);
    expect(half.breakthrough).toBeCloseTo(0.5, 2);
    const done = run(half, target, BREAKTHROUGH_FADE_OUT_S / 2 + 0.1);
    expect(done.breakthrough).toBe(0);
    target = computeLayerWeights(6.4, target);
    expect(target.breakthrough).toBe(0);
  });

  it('other layers never cut: at most 1 per 0.3 s', () => {
    const a = computeLayerWeights(0);
    const b = computeLayerWeights(9, computeLayerWeights(8.5));
    const one = advanceFade(a, b, 1 / 60);
    for (const k of WEIGHT_KEYS) expect(Math.abs(one[k] - a[k])).toBeLessThanOrEqual((1 / 60) / 0.3 + 1e-12);
  });

  it('zero or invalid dt changes nothing', () => {
    const a = computeLayerWeights(3);
    const b = computeLayerWeights(9);
    expect(advanceFade(a, b, 0).formConstants).toBe(a.formConstants);
    expect(advanceFade(a, b, Number.NaN).room).toBe(a.room);
  });
});

describe('deepestLayer mirrors backend/pharmacology.py', () => {
  const py = readFileSync(resolve(__dirname, '../../backend/pharmacology.py'), 'utf8');

  it('same LAYER_ORDER', () => {
    const m = py.match(/LAYER_ORDER = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const list = m![1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
    expect(list).toEqual([...LAYER_ORDER]);
  });

  it('same thresholds', () => {
    const pairs = [...py.matchAll(/if peak_visual >= ([\d.]+):\s*\n\s*return "(\w+)"/g)].map((x) => [Number(x[1]), x[2]] as const);
    expect(pairs.length).toBe(5);
    for (const [thr, name] of pairs) {
      expect(deepestLayer(thr)).toBe(name);
      expect(deepestLayer(thr - 1e-9)).not.toBe(name);
    }
    expect(deepestLayer(0)).toBe('none');
    expect(deepestLayer(10)).toBe('breakthrough');
    expect(layerRank('waiting_room')).toBeGreaterThan(layerRank('chrysanthemum'));
  });

  it('smoothstep basics', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });
});
