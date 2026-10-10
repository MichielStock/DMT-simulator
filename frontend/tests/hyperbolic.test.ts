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
