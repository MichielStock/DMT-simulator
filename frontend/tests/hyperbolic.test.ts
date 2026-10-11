import { describe, expect, it } from 'vitest';
import {
  CROSSFADE_MIN_S, GroupScheduler, cabs, cabs2, cadd, commutatorTrace, compose, cx, diskDistance, diskRotation,
  diskTranslation, foldToFundamental, grandmaGenerators, inFundamental, invertCircle, isHyperbolic, maskitGenerators,
  maskitMu, maskitParams, mobius, reflectLine, sanitiseGroups, trace, triangleAngles, triangleMirrors, type Cx,
} from '../src/layers/mobius';
import { mulberry32 } from '../src/rng';

const GROUPS: [number, number, number][] = [[7, 3, 2], [5, 4, 2], [9, 3, 2], [4, 3, 3], [5, 5, 2], [4, 4, 4], [3, 3, 7], [2, 3, 7]];
const close = (a: Cx, b: Cx, eps = 1e-9) => cabs([a[0] - b[0], a[1] - b[1]]) < eps;

function randomDiskPoints(n: number, seed: number, rMax = 0.97): Cx[] {
  const rng = mulberry32(seed);
  const pts: Cx[] = [];
  for (let i = 0; i < n; i++) {
    const r = rMax * Math.sqrt(rng());
    const a = 2 * Math.PI * rng();
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

describe('triangle groups', () => {
  it('recognises hyperbolic triples', () => {
    expect(isHyperbolic(2, 3, 7)).toBe(true);
    expect(isHyperbolic(2, 3, 6)).toBe(false);   // Euclidean
    expect(isHyperbolic(2, 3, 5)).toBe(false);   // spherical
    expect(() => triangleMirrors(2, 3, 6)).toThrow();
  });

  it.each(GROUPS)('fundamental triangle (%i,%i,%i) has angles π/p, π/q, π/r', (p, q, r) => {
    const t = triangleMirrors(p, q, r);
    const [a, b, c] = triangleAngles(t);
    expect(a).toBeCloseTo(Math.PI / p, 9);
    expect(b).toBeCloseTo(Math.PI / q, 9);
    expect(c).toBeCloseTo(Math.PI / r, 9);
    // the circle mirror is a geodesic: orthogonal to the unit circle
    expect(cabs2(t.centre)).toBeCloseTo(t.radius * t.radius + 1, 9);
    // vertices inside the disk and on their mirrors
    for (const v of [t.B, t.C]) expect(cabs(v)).toBeLessThan(1);
    expect(cabs([t.B[0] - t.centre[0], t.B[1] - t.centre[1]])).toBeCloseTo(t.radius, 9);
    expect(cabs([t.C[0] - t.centre[0], t.C[1] - t.centre[1]])).toBeCloseTo(t.radius, 9);
  });

  it.each(GROUPS)('reflections of (%i,%i,%i) preserve the disk and are involutions', (p, q, r) => {
    const t = triangleMirrors(p, q, r);
    for (const z of randomDiskPoints(400, p * 100 + q * 10 + r)) {
      const z1 = reflectLine(z, [0, 1]);
      const z2 = reflectLine(z, t.n2);
      const z3 = invertCircle(z, t.centre, t.radius);
      for (const w of [z1, z2, z3]) expect(cabs(w)).toBeLessThan(1);
      expect(close(reflectLine(z2, t.n2), z)).toBe(true);
      expect(close(invertCircle(z3, t.centre, t.radius), z, 1e-8)).toBe(true);
      // isometries of the hyperbolic metric
      const w = randomDiskPoints(1, Math.floor(z[0] * 1e6) + 7)[0];
      const d = diskDistance(z, w);
      expect(diskDistance(invertCircle(z, t.centre, t.radius), invertCircle(w, t.centre, t.radius))).toBeCloseTo(d, 6);
    }
  });

  it.each(GROUPS)('folding (%i,%i,%i) lands in the fundamental triangle, preserving the disk', (p, q, r) => {
    const t = triangleMirrors(p, q, r);
    let maxIt = 0;
    for (const z of randomDiskPoints(2000, 11 * p + q + r, 0.95)) {
      const f = foldToFundamental(t, z, 64);
      expect(f.converged).toBe(true);
      expect(inFundamental(t, f.z, 1e-7)).toBe(true);
      expect(cabs(f.z)).toBeLessThan(1);
      // hyperbolic distance to the centre can only shrink or stay (the triangle contains the centre)
      expect(diskDistance(f.z, cx(0))).toBeLessThanOrEqual(diskDistance(z, cx(0)) + 1e-7);
      maxIt = Math.max(maxIt, f.iterations);
    }
    // the shader caps its loop at 32 iterations: points out to |z| = 0.95 must fit with margin
    expect(maxIt).toBeLessThan(28);
  });

  it('fold is invariant under the group: a point and its mirror image fold to the same place', () => {
    const t = triangleMirrors(7, 3, 2);
    for (const z of randomDiskPoints(300, 5, 0.9)) {
      const a = foldToFundamental(t, z);
      const b = foldToFundamental(t, invertCircle(z, t.centre, t.radius));
      expect(close(a.z, b.z, 1e-7)).toBe(true);
      expect((a.reflections - b.reflections) % 2 !== 0).toBe(true);   // parity flips
    }
  });

  it('sanitises trip-script groups (largest order at the centre, non-hyperbolic dropped)', () => {
    expect(sanitiseGroups([[2, 3, 7], [2, 3, 6], [4, 4, 4]])).toEqual([[7, 3, 2], [4, 4, 4]]);
    expect(sanitiseGroups(null).length).toBeGreaterThan(0);
  });
});

describe('Möbius maps', () => {
  it('disk translations and rotations preserve the disk and hyperbolic distance', () => {
    const T = compose(diskTranslation([0.3, -0.2]), diskRotation(0.7));
    const pts = randomDiskPoints(200, 3, 0.95);
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = mobius(T, pts[i]); const b = mobius(T, pts[i + 1]);
      expect(cabs(a)).toBeLessThan(1);
      expect(diskDistance(a, b)).toBeCloseTo(diskDistance(pts[i], pts[i + 1]), 7);
    }
    expect(close(mobius(diskTranslation([0.4, 0.1]), cx(0)), [0.4, 0.1])).toBe(true);
  });
});

describe('Kleinian groups', () => {
  it('Maskit generators: tr b = 2, tr a = −iμ, tr[a,b] = −2', () => {
    for (const mu of [[0, 2], [-0.1, 1.95], [0.15, 1.93]] as Cx[]) {
      const { a, b } = maskitGenerators(mu);
      expect(close(trace(b), [2, 0])).toBe(true);
      expect(close(trace(a), [mu[1], -mu[0]])).toBe(true);
      expect(close(commutatorTrace(a, b), [-2, 0], 1e-9)).toBe(true);
      // a(z) = μ + 1/z, b(z) = z + 2
      const z: Cx = [0.3, 0.7];
      expect(close(mobius(a, z), cadd(mu, [z[0] / cabs2(z), -z[1] / cabs2(z)]))).toBe(true);
      expect(close(mobius(b, z), [2.3, 0.7])).toBe(true);
    }
  });

  it("Grandma's recipe: traces ta, tb, and parabolic commutator (tr abAB = −2)", () => {
    for (const [ta, tb] of [[[2, 0], [2, 0]], [[1.95, 0.1], [2.1, 0.05]], [[2.3, 0.25], [1.9, 0]]] as [Cx, Cx][]) {
      for (const plus of [false, true]) {
        const g = grandmaGenerators(ta, tb, plus);
        expect(close(trace(g.a), ta, 1e-9)).toBe(true);
        expect(close(trace(g.b), tb, 1e-9)).toBe(true);
        expect(close(trace(compose(g.a, g.b)), g.tab, 1e-8)).toBe(true);
        expect(close(commutatorTrace(g.a, g.b), [-2, 0], 1e-7)).toBe(true);
      }
    }
  });

  it('maps trip-script traces into the renderable Maskit range', () => {
    for (const re of [1.9, 2.0, 2.1, 2.3]) {
      for (const im of [0, 0.1, 0.25]) {
        const p = maskitParams([re, im], [2.0, im]);
        expect(p.height).toBeGreaterThanOrEqual(1.93);
        expect(p.height).toBeLessThanOrEqual(2.0);
        expect(Math.abs(p.shift)).toBeLessThanOrEqual(0.15);
        const { a, b } = maskitGenerators(maskitMu(p));
        expect(close(commutatorTrace(a, b), [-2, 0], 1e-9)).toBe(true);
      }
    }
  });
});

describe('group crossfade scheduler', () => {
  function run(seed: number, timewarp: number, challenge: number, fps: number, seconds: number) {
    const s = new GroupScheduler(3, seed);
    const starts: number[] = [];
    let wall = 0; let lastChanges = 0; let lastMix = 1; let maxDmix = 0;
    const rng = mulberry32(seed + 1);
    while (wall < seconds) {
      const dt = (1 / fps) * (0.5 + rng());              // irregular frames
      wall += dt;
      const st = s.update(dt * timewarp, dt, challenge);
      if (st.changes !== lastChanges) { starts.push(wall); lastChanges = st.changes; lastMix = 0; }
      maxDmix = Math.max(maxDmix, Math.abs(st.mix - lastMix) / dt);
      lastMix = st.mix;
      expect(st.from).not.toBe(st.changes > 0 ? st.to : -1);
    }
    return { starts, maxDmix, s };
  }

  it('changes every 6–14 s of model time at real time', () => {
    const { starts } = run(42, 1, 0, 60, 300);
    expect(starts.length).toBeGreaterThan(300 / 14 - 3);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap).toBeGreaterThanOrEqual(6 - 0.05);
      expect(gap).toBeLessThanOrEqual(14 + 0.1);
    }
  });

  it.each([[1, 0], [10, 0], [100, 1], [1000, 1]])('never changes faster than the 300 ms crossfade (timewarp %i, challenge %i)',
    (tw, ch) => {
      const { starts, maxDmix, s } = run(7 + tw, tw, ch, 60, 120);
      expect(starts.length).toBeGreaterThan(1);
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CROSSFADE_MIN_S);
      expect(s.crossfadeLength(ch)).toBeGreaterThanOrEqual(CROSSFADE_MIN_S);
      // smoothstep over ≥ 0.3 s: the mix never moves faster than 1.5 / 0.3 per second
      expect(maxDmix).toBeLessThanOrEqual(1.5 / CROSSFADE_MIN_S + 1e-6);
    });

  it('is deterministic per seed', () => {
    expect(run(5, 1, 0, 60, 100).starts).toEqual(run(5, 1, 0, 60, 100).starts.map((x) => x));
    const a = new GroupScheduler(3, 9); const b = new GroupScheduler(3, 9);
    for (let i = 0; i < 2000; i++) expect(a.update(0.1, 0.1)).toEqual(b.update(0.1, 0.1));
  });
});

// ---- polish-chrysanthemum-r1 additions -------------------------------------------------------------
import * as THREE from 'three';
import { HARSH_COLOURS, contrastingColours, darkBaseColour, jewelColour, preparePalette } from '../src/layers/hyperbolic';

describe('cell centres (the shader tracks the inverse fold to give every cell a stable jewel)', () => {
  it.each([[7, 3, 2], [5, 4, 2], [4, 3, 3]])('(%i,%i,%i): the centre is an image of A and is shared by the whole cell', (p, q, r) => {
    const t = triangleMirrors(p, q, r);
    for (const z of randomDiskPoints(400, 3 * p + q, 0.9)) {
      const f = foldToFundamental(t, z, 64);
      expect(cabs(f.centre)).toBeLessThan(1);
      // the centre folds onto the centre vertex A = 0 of the fundamental triangle
      const fc = foldToFundamental(t, f.centre, 64);
      expect(cabs(fc.z)).toBeLessThan(1e-6);
      // z lies within the cell's circumradius (A to the farthest vertex of the fundamental triangle)
      const circum = Math.max(diskDistance(cx(0), t.B), diskDistance(cx(0), t.C));
      expect(diskDistance(z, f.centre)).toBeLessThanOrEqual(circum + 1e-6);
    }
  });

  it('two nearby points away from the cell edges share the centre; points across an edge do not', () => {
    const t = triangleMirrors(7, 3, 2);
    let same = 0; let diff = 0;
    for (const z of randomDiskPoints(600, 77, 0.85)) {
      const f = foldToFundamental(t, z, 64);
      const dEdge = cabs([f.z[0] - t.centre[0], f.z[1] - t.centre[1]]) - t.radius;   // folded distance to the cell edge
      const eps = 1e-5;
      const g = foldToFundamental(t, [z[0] + eps, z[1] - eps], 64);
      if (dEdge > 1e-3) { expect(close(f.centre, g.centre, 1e-6)).toBe(true); same++; }
      // the mirror image across the cell edge belongs to the neighbouring cell
      const m = foldToFundamental(t, invertCircle(z, t.centre, t.radius), 64);
      if (f.depth === 0 && dEdge > 1e-3) { expect(close(f.centre, m.centre, 1e-4)).toBe(false); diff++; }
    }
    expect(same).toBeGreaterThan(300);
    expect(diff).toBeGreaterThan(5);
  });
});

describe('chrysanthemum palette (docs/VISUAL_DIRECTION.md: jewel chroma, dark base, no grey)', () => {
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const PALETTES = [
    ['#1b0a3c', '#5b1a8f', '#c2187a', '#e8a33b', '#1f8f7a', '#3a5bd9'],
    ['#0d0221', '#ff2a6d', '#05d9e8', '#d1f7ff', '#7b2ff7', '#f9c80e'],
    ['#1a0505', '#7a1f0f', '#d9480f', '#f59f00', '#ffd43b', '#9c36b5'],
    ['#060b1f', '#1c2c5b', '#4361ee', '#7fd1ff', '#c8b6ff', '#e9d8a6'],
    ['#03140c', '#0b5d3b', '#2fbf71', '#c3f73a', '#f0a202', '#6a4c93'],
  ];

  it.each(PALETTES)('jewel colours keep luminance and hue, gain chroma, keep red < 0.75 of R+G+B (%s …)', (...hex) => {
    for (const c of preparePalette(hex)) {
      const j = jewelColour(c);
      expect(lum(j)).toBeCloseTo(lum(c), 6);
      const chroma = (x: THREE.Color) => Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b);
      expect(chroma(j)).toBeGreaterThanOrEqual(chroma(c) - 1e-9);
      expect(j.r / (j.r + j.g + j.b)).toBeLessThan(0.75);
      expect(Math.min(j.r, j.g, j.b)).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(PALETTES)('the dark base is the darkest palette colour, coloured (not grey) (%s …)', (...hex) => {
    const pal = preparePalette(hex).map(jewelColour);
    const d = darkBaseColour(hex, pal);
    expect(lum(d)).toBeCloseTo(0.2, 6);
    const darkest = new THREE.Color(hex[0]);
    const hsl = { h: 0, s: 0, l: 0 }; const hd = { h: 0, s: 0, l: 0 };
    darkest.getHSL(hsl); d.getHSL(hd, THREE.LinearSRGBColorSpace);
    const dh = Math.abs(hsl.h - hd.h);
    expect(Math.min(dh, 1 - dh)).toBeLessThan(0.08);                  // same hue family
    expect((Math.max(d.r, d.g, d.b) - Math.min(d.r, d.g, d.b)) / Math.max(d.r, d.g, d.b)).toBeGreaterThan(0.5);
  });

  it('contrasting colours pick a palette colour of distant hue; harsh colours stay clear of saturated red', () => {
    const pal = preparePalette(PALETTES[3]).map(jewelColour);
    const acc = contrastingColours(pal);
    expect(acc.length).toBe(pal.length);
    for (const a of acc) expect(pal.some((c) => c.equals(a))).toBe(true);
    for (let i = 0; i < pal.length; i++) expect(acc[i].equals(pal[i])).toBe(false);
    for (const h of HARSH_COLOURS) {
      expect(lum(h)).toBeCloseTo(0.2, 6);
      expect(h.r / (h.r + h.g + h.b)).toBeLessThan(0.75);
    }
  });

  it('group crossfades last 2 s by default for this layer (≥ 1.2 s under a difficult passage)', () => {
    const s = new GroupScheduler(3, 1, { crossfade: 2.0 });
    expect(s.crossfadeLength(0)).toBeCloseTo(2.0, 9);
    expect(s.crossfadeLength(1)).toBeCloseTo(1.2, 9);
    // the shader's outward melt gives each pixel 0.6 of the mix range; with smoothstep slope ≤ 1.5 that is
    // ≥ 0.4 of the crossfade: ≥ 0.48 s even in a difficult passage
    expect(0.4 * s.crossfadeLength(1)).toBeGreaterThanOrEqual(CROSSFADE_MIN_S);
  });
});

// ---- polish-chrysanthemum-r2 additions -------------------------------------------------------------
import { accentColours, carryLuminance, chrysPalette, escalation, groupZoom, vividColour } from '../src/layers/hyperbolic';

describe('chrysanthemum r2: vivid jewel palette, accents, escalation, group zoom', () => {
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const chroma = (c: THREE.Color) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const PALETTES = [
    ['#1b0a3c', '#5b1a8f', '#c2187a', '#e8a33b', '#1f8f7a', '#3a5bd9'],
    ['#0d0221', '#ff2a6d', '#05d9e8', '#d1f7ff', '#7b2ff7', '#f9c80e'],
    ['#1a0505', '#7a1f0f', '#d9480f', '#f59f00', '#ffd43b', '#9c36b5'],
    ['#060b1f', '#1c2c5b', '#4361ee', '#7fd1ff', '#c8b6ff', '#e9d8a6'],
    ['#03140c', '#0b5d3b', '#2fbf71', '#c3f73a', '#f0a202', '#6a4c93'],
  ];

  it.each(PALETTES)('vivid colours keep luminance, never lose chroma, keep red < 0.75 of R+G+B (%s …)', (...hex) => {
    for (const c of preparePalette(hex).map(jewelColour)) {
      const v = vividColour(c);
      expect(lum(v)).toBeCloseTo(lum(c), 6);
      expect(chroma(v)).toBeGreaterThanOrEqual(chroma(c) - 1e-9);
      expect(v.r / (v.r + v.g + v.b)).toBeLessThan(0.75);
      expect(Math.min(v.r, v.g, v.b)).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(PALETTES)('the chrysanthemum palette keeps each colour\'s hue family (%s …)', (...hex) => {
    const pal = chrysPalette(hex);
    const lit = hex.filter((h) => lum(new THREE.Color(h)) > 0.012);
    pal.forEach((c, i) => {
      expect(lum(c)).toBeCloseTo(0.2, 6);
      expect(c.r / (c.r + c.g + c.b)).toBeLessThan(0.75);
      const src = new THREE.Color(lit[i % lit.length]);
      const hs = { h: 0, s: 0, l: 0 }, hc = { h: 0, s: 0, l: 0 };
      src.getHSL(hs, THREE.LinearSRGBColorSpace); c.getHSL(hc, THREE.LinearSRGBColorSpace);
      const dh = Math.abs(hs.h - hc.h);
      if (hs.s > 0.3) expect(Math.min(dh, 1 - dh)).toBeLessThan(0.07);   // red-dominant hues may turn ≤ 0.07
    });
  });

  it('hot magenta #ff2a6d stays magenta (blue raised), not rose (green and blue raised toward grey)', () => {
    const pal = chrysPalette(PALETTES[1]);
    const m = pal[0];                                  // #ff2a6d (the near-black #0d0221 is skipped)
    expect(m.b).toBeGreaterThan(m.g * 10);
    expect(Math.min(m.r, m.g, m.b) / Math.max(m.r, m.g, m.b)).toBeLessThan(0.02);
    // the jewel-only version was much greyer
    const j = preparePalette(PALETTES[1]).map(jewelColour)[0];
    expect(Math.min(j.r, j.g, j.b) / Math.max(j.r, j.g, j.b)).toBeGreaterThan(0.05);
    // orange-red (#d9480f) turns toward orange (green raised), not magenta
    const o = chrysPalette(PALETTES[2])[1];
    expect(o.g).toBeGreaterThan(o.b);
  });

  it("accent colours: the brightest-carrying palette colour and the brightest of a different hue", () => {
    const pal = chrysPalette(PALETTES[1]);
    const [a, b] = accentColours(pal);
    const ks = pal.map(carryLuminance).sort((x, y) => y - x);
    expect(carryLuminance(a)).toBeCloseTo(ks[0], 9);
    expect(carryLuminance(b)).toBeGreaterThan(ks[3]);
    const ha = { h: 0, s: 0, l: 0 }, hb = { h: 0, s: 0, l: 0 };
    a.getHSL(ha, THREE.LinearSRGBColorSpace); b.getHSL(hb, THREE.LinearSRGBColorSpace);
    const dh = Math.abs(ha.h - hb.h);
    expect(Math.min(dh, 1 - dh)).toBeGreaterThan(0.08);
    // neon: the yellow (#f9c80e) is one of them (the brief's fourth hue)
    const hsl = { h: 0, s: 0, l: 0 };
    const hues = [a, b].map((c) => { c.getHSL(hsl, THREE.LinearSRGBColorSpace); return hsl.h; });
    expect(hues.some((h) => h > 0.1 && h < 0.18)).toBe(true);
    // violet carries far less than yellow at full chroma
    expect(carryLuminance(new THREE.Color(0.198, 0.028, 0.93))).toBeLessThan(0.15);
  });

  it('escalation rises monotonically from v 5 to v 9.5 and separates v 7.5 from v 9', () => {
    expect(escalation(5)).toBe(0);
    expect(escalation(9.5)).toBe(1);
    let prev = -1;
    for (let v = 0; v <= 10; v += 0.25) { const e = escalation(v); expect(e).toBeGreaterThanOrEqual(prev); prev = e; }
    expect(escalation(9) - escalation(7.5)).toBeGreaterThan(0.3);
  });

  it('group zoom: 1 for (7,3,2), larger for big-celled groups, at most 1.35', () => {
    expect(groupZoom(triangleMirrors(7, 3, 2))).toBeCloseTo(1, 2);
    const z444 = groupZoom(triangleMirrors(4, 4, 4));
    expect(z444).toBeGreaterThan(1.2);
    for (const g of GROUPS) {
      const z = groupZoom(triangleMirrors(...g));
      expect(z).toBeGreaterThanOrEqual(1);
      expect(z).toBeLessThanOrEqual(1.35);
    }
  });
});

// ---- waiting room (layers/waitingRoom.ts): palette lights and safety-relevant rates ----
import { flowRate, jewelise, waitingRoomLights } from '../src/layers/waitingRoom';
import * as THREE_WR from 'three';

const WR_PALETTES: Record<string, string[]> = {   // backend/planner/priors.yaml
  jewel: ['#1b0a3c', '#5b1a8f', '#c2187a', '#e8a33b', '#1f8f7a', '#3a5bd9'],
  neon: ['#0d0221', '#ff2a6d', '#05d9e8', '#d1f7ff', '#7b2ff7', '#f9c80e'],
  ember: ['#1a0505', '#7a1f0f', '#d9480f', '#f59f00', '#ffd43b', '#9c36b5'],
  lunar: ['#060b1f', '#1c2c5b', '#4361ee', '#7fd1ff', '#c8b6ff', '#e9d8a6'],
  verdant: ['#03140c', '#0b5d3b', '#2fbf71', '#c3f73a', '#f0a202', '#6a4c93'],
};
const wrLum = (c: THREE_WR.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const wrHue = (c: THREE_WR.Color) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
  if (d < 1e-9) return 0;
  const h = mx === c.r ? ((c.g - c.b) / d + 6) % 6 : mx === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return h / 6;
};

describe('waiting room lights', () => {
  for (const [name, hex] of Object.entries(WR_PALETTES)) {
    it(`${name}: two distinct full-chroma light colours, none near the saturated-red rule`, () => {
      const { a, b, c, deep, spillB } = waitingRoomLights(hex);
      for (const col of [a, b, c, spillB]) {
        expect(Math.max(col.r, col.g, col.b)).toBeCloseTo(1, 6);         // max channel 1 (never washes to white)
        expect(col.r / (col.r + col.g + col.b)).toBeLessThan(0.76);         // red rule starts at 0.8 (§4.1)
      }
      expect(wrLum(deep)).toBeCloseTo(1, 4);
      expect(deep.r / (deep.r + deep.g + deep.b)).toBeLessThan(0.8);        // the red rule concerns red only
      const dh = Math.abs(wrHue(a) - wrHue(b));
      expect(Math.min(dh, 1 - dh)).toBeGreaterThan(0.08);                  // A and B are different hues
      // the light thrown on (dim) surfaces is never a yellow / orange / lime (dim, those read as brown / olive)
      const hs = wrHue(spillB);
      expect(hs > 0.035 && hs < 0.27).toBe(false);
    });
  }
  it('falls back gracefully without a palette', () => {
    const { a, b, deep } = waitingRoomLights(undefined);
    for (const col of [a, b, deep]) expect([col.r, col.g, col.b].every(Number.isFinite)).toBe(true);
  });
  it('jewelise keeps luminance and the red-rule margin', () => {
    for (const hex of Object.values(WR_PALETTES).flat()) {
      const c = new THREE_WR.Color(hex);
      const j = jewelise(c);
      expect(wrLum(j)).toBeCloseTo(wrLum(c), 5);
      expect(j.r / (j.r + j.g + j.b)).toBeLessThanOrEqual(Math.max(0.72, c.r / (c.r + c.g + c.b)) + 1e-6);
    }
  });
});

describe('waiting room motion', () => {
  it('the light flowing along the ornament stays slow (≤ 0.3 Hz, far below the 2 Hz cap)', () => {
    for (let v = -0.5; v <= 1.5; v += 0.25) for (let ch = -0.5; ch <= 1.5; ch += 0.25) {
      const r = flowRate(v, ch);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(0.3);
    }
    expect(flowRate(1, 0)).toBeGreaterThan(flowRate(0.2, 0));             // intensity speeds it up
  });
});

// ---- waiting room r2 (polish-waiting_room-r2): pure palette light colours, hue-keeping red cap ----
import { capRedHue } from '../src/layers/waitingRoom';

describe('waiting room r2: light colours are the palette\'s own hues', () => {
  const hueDeg = (c: THREE_WR.Color) => wrHue(c) * 360;
  const near = (a: number, b: number, tol: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= tol;
  it('neon glows hot pink (#ff2a6d) and cyan (#05d9e8), not softened surface hues', () => {
    const { a, b, spillB } = waitingRoomLights(WR_PALETTES.neon);
    const cyan = new THREE_WR.Color('#05d9e8'), pink = new THREE_WR.Color('#ff2a6d');
    const ab = [a, b];
    expect(ab.some((c) => near(hueDeg(c), hueDeg(cyan), 6))).toBe(true);
    // pink after the red cap: same family (crimson-magenta), red share kept below the rule
    expect(ab.some((c) => near(hueDeg(c), hueDeg(pink), 14))).toBe(true);
    for (const c of [a, b, spillB]) {
      const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
      expect((mx - mn) / mx).toBeGreaterThan(0.9);                        // full chroma (no grey part)
    }
  });
  it('a gold accent (lunar) never becomes a block colour: both block colours are cool', () => {
    const { a, spillB } = waitingRoomLights(WR_PALETTES.lunar);
    for (const c of [a, spillB]) { const h = hueDeg(c); expect(h > 150 && h < 270).toBe(true); }
  });
  it('capRedHue keeps red share ≤ 0.74 by raising the larger of G/B (hue family kept, chroma kept)', () => {
    for (const hex of ['#ff2a6d', '#ff0000', '#d9480f', '#7a1f0f', '#c2187a', '#ff00ff', '#05d9e8']) {
      const c = new THREE_WR.Color(hex);
      const r = capRedHue(c);
      expect(r.r / (r.r + r.g + r.b)).toBeLessThanOrEqual(0.74 + 1e-9);
      expect(r.r).toBeCloseTo(c.r, 9);                                     // red channel untouched
      if (c.r / (c.r + c.g + c.b) <= 0.74) { expect(r.g).toBeCloseTo(c.g, 9); expect(r.b).toBeCloseTo(c.b, 9); }
      else if (c.b > c.g) expect(r.g).toBeCloseTo(c.g, 9);                 // pink → magenta-pink, not grey
      else expect(r.b).toBeCloseTo(c.b, 9);                                // orange-red → orange, not grey
    }
  });
  it('every palette: lights stay off the saturated-red rule with margin', () => {
    for (const hex of Object.values(WR_PALETTES)) {
      const L = waitingRoomLights(hex);
      for (const c of [L.a, L.b, L.c, L.spillB]) expect(c.r / (c.r + c.g + c.b)).toBeLessThan(0.75);
    }
  });
});

// ---- waiting room r3 (polish-waiting_room-r3): kifs shading, difficult-passage bloom, source-side caps ----
import { bloomGain } from '../src/layers/waitingRoom';
import wrFrag from '../src/layers/glsl/waitingRoom.frag.glsl?raw';

describe('waiting room r3', () => {
  it('bloom gain rises with intensity and the difficult passage, bounded', () => {
    expect(bloomGain(0, 0)).toBeCloseTo(0.95, 6);
    expect(bloomGain(1, 0)).toBeCloseTo(1.0, 6);
    expect(bloomGain(1, 1)).toBeCloseTo(1.4, 6);
    for (let v = 0; v <= 1; v += 0.1) {
      for (let c = 0; c <= 1; c += 0.1) {
        const g = bloomGain(v, c);
        expect(g).toBeGreaterThanOrEqual(0.95 - 1e-9);
        expect(g).toBeLessThanOrEqual(1.4 + 1e-9);
        expect(bloomGain(v, Math.min(1, c + 0.1))).toBeGreaterThanOrEqual(g - 1e-9);
      }
    }
    // out-of-range inputs are clamped
    expect(bloomGain(-3, 7)).toBeCloseTo(bloomGain(0, 1), 9);
  });
  it('the shader keeps its source-side safety caps (no near-white, dim near band, slow flow)', () => {
    // luminance ceiling 0.9 in the shader
    expect(wrFrag).toMatch(/if \(L > 0\.9\) col \*= 0\.9 \/ L;/);
    // fast-streaming (near) surfaces soft-clipped to a dim band of 0.09 (below the 0.1 flash step)
    expect(wrFrag).toMatch(/0\.09 \* \(1\.0 - exp\(-L0 \/ 0\.09\)\)/);
    // kifs near walls: their dark mosaic stays below the pattern guard's 0.02 range floor
    expect(wrFrag).toMatch(/min\(0\.4 \* dot\(surf, LUMA\), 0\.018\)/);
  });
  it('the difficult passage keeps the light flow far below 2 Hz', () => {
    for (let v = 0; v <= 1; v += 0.25) expect(flowRate(v, 1)).toBeLessThanOrEqual(0.3);
  });
});
