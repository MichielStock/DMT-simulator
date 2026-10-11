// Pins the periodicity score used by the SafetyLimiter's contrast guard (NOTES.md S8): periodic
// patterns at Michelson 0.9 must score >= GUARD_PERIODICITY_MIN, aperiodic high-contrast content well
// below it.
import { describe, expect, it } from 'vitest';
import {
  COARSE_STEP_TILES, FINE_STEP_TILES, PROFILE_N, SPECTRAL_N, SPECTRAL_TOP3_MIN, STRIPE_CENTRAL_N, centralStart,
  countTransitions, dilateMask, dilatePeriodic, fillEnclosed, gridPeriodicity, gridStripe, periodicityScore, pixelPeriodicity,
  pixelStripe, sampleProfile, spectralOrigin, spectralPeaks, spectralTop3, stripeTransitions, tensorOrientation,
  tilePeriodicity, type LumaFn,
} from '../src/safety/periodicity';
import { GUARD_PERIODICITY_MIN } from '../src/safety/safetyLimiter';

const LO = 0.05;
const HI = 0.95;            // Michelson (0.95 - 0.05) / (0.95 + 0.05) = 0.9
const NEG = 0.35;           // aperiodic content must stay below this

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 2-D test patterns (pixel coordinates), luminance in [LO, HI] -------------------------------
const sq = (u: number, T: number): number => (((u % T) + T) % T < T / 2 ? HI : LO);
const cosw = (u: number, T: number): number => LO + (HI - LO) * (0.5 + 0.5 * Math.cos((2 * Math.PI * u) / T));
const PATTERNS: Record<string, (T: number, W: number, H: number) => LumaFn> = {
  stripes: (T) => (x) => sq(x, T),
  hstripes: (T) => (_x, y) => sq(y, T),
  sinestripes: (T) => (x) => cosw(x, T),
  rings: (T, W, H) => (x, y) => cosw(Math.hypot(x - W / 2, y - H / 2), T),
  hex: (T) => (x, y) => {
    const k = (2 * Math.PI) / T;
    let s = 0;
    for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) s += Math.cos(k * (x * Math.cos(a) + y * Math.sin(a)));
    return LO + ((HI - LO) * (s + 1.5)) / 4.5;
  },
  checker: (T) => (x, y) => ((Math.floor(x / (T / 2)) + Math.floor(y / (T / 2))) % 2 === 0 ? HI : LO),
  diag: (T) => (x, y) => cosw((x + y) * Math.SQRT1_2, T),
  thinlines: (T) => (x) => ((((x % T) + T) % T) < 2 ? HI : LO),
};

/** Bilinear sampling of a pixel-grid function (texel centres at +0.5, clamp to edge), like the GPU. */
function bilinear(f: LumaFn, W: number, H: number): LumaFn {
  const px = (i: number, j: number): number =>
    f(Math.min(W - 1, Math.max(0, i)) + 0.5, Math.min(H - 1, Math.max(0, j)) + 0.5);
  return (x, y) => {
    const u = x - 0.5; const v = y - 0.5;
    const i = Math.floor(u); const j = Math.floor(v);
    const fx = u - i; const fy = v - j;
    return (px(i, j) * (1 - fx) + px(i + 1, j) * fx) * (1 - fy) + (px(i, j + 1) * (1 - fx) + px(i + 1, j + 1) * fx) * fy;
  };
}

/** Area means of the 64x36 tiles (approximates the GPU luminance pyramid level 3: 8x8 texels of 4x4 taps each). */
function tileMeans(f: LumaFn, W: number, H: number): (c: number, r: number) => number {
  const m = new Float64Array(64 * 36);
  for (let r = 0; r < 36; r++) for (let c = 0; c < 64; c++) {
    let s = 0;
    for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) s += f(((c + (i + 0.5) / 12) * W) / 64, ((r + (j + 0.5) / 12) * H) / 36);
    m[r * 64 + c] = s / 144;
  }
  return (c, r) => m[r * 64 + c];
}

const TILES: Array<[number, number]> = [[3, 2], [17, 9], [31, 17], [32, 18], [45, 30], [60, 33], [8, 27], [52, 5]];

describe('periodicityScore: periodic profiles', () => {
  // The two pixel scales at 1920x1080 (tile 30 px): coarse 30/7 px steps (2-tap box), fine 0.5 px steps.
  const coarse = COARSE_STEP_TILES * 30; const fine = FINE_STEP_TILES * 30;
  const prof = (f: (u: number) => number, step: number, taps: 1 | 2, ph: number): Float64Array => {
    const a = new Float64Array(PROFILE_N);
    for (let i = 0; i < PROFILE_N; i++) {
      const u = i * step + ph;
      a[i] = taps === 1 ? f(u) : 0.5 * (f(u - step / 4) + f(u + step / 4));
    }
    return a;
  };
  const best = (f: (u: number) => number, ph: number): number =>
    Math.max(periodicityScore(prof(f, coarse, 2, ph)), periodicityScore(prof(f, fine, 1, ph)));
  for (const T of [6, 8, 10, 12, 17, 24, 30, 45, 60, 75, 90]) {
    it(`square and sine stripes of period ${T} px score >= 0.5`, () => {
      for (const ph of [0, 0.37, 0.5, 1.3, 7.9]) {
        expect(best((u) => sq(u, T), ph), `square T=${T} ph=${ph}`).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
        expect(best((u) => cosw(u, T), ph), `sine T=${T} ph=${ph}`).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
      }
    });
  }
  it('low-duty-cycle pulse trains (2 px lines every 40 px) score >= 0.5', () => {
    const a = new Float64Array(PROFILE_N);
    for (let i = 0; i < PROFILE_N; i++) a[i] = ((i * 2 + 1) % 40) < 2 ? HI : LO;
    expect(periodicityScore(a)).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
  });
});

describe('periodicityScore: aperiodic profiles stay below 0.35', () => {
  const n = PROFILE_N;
  it('a linear gradient and a smooth vignette', () => {
    const g = new Float64Array(n); const v = new Float64Array(n);
    for (let i = 0; i < n; i++) { g[i] = LO + ((HI - LO) * i) / (n - 1); v[i] = LO + (HI - LO) * Math.sin((Math.PI * i) / (n - 1)) ** 2; }
    expect(periodicityScore(g)).toBe(0);
    expect(periodicityScore(v)).toBeLessThan(NEG);
  });
  it('a flat profile', () => { expect(periodicityScore(new Float64Array(n).fill(0.4))).toBe(0); });
  it('white noise (200 seeds)', () => {
    const r = rng(11); let worst = 0;
    for (let s = 0; s < 200; s++) {
      const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = LO + (HI - LO) * r();
      worst = Math.max(worst, periodicityScore(a));
    }
    expect(worst).toBeLessThan(NEG);
  });
  it('a single bright blob on black', () => {
    for (const c of [20, 64, 100]) {
      const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = LO + (HI - LO) * Math.exp(-(((i - c) / 8) ** 2));
      expect(periodicityScore(a)).toBeLessThan(NEG);
    }
  });
  it('photo-like 1/f profiles (100 seeds)', () => {
    const r = rng(5); let worst = 0;
    for (let s = 0; s < 100; s++) {
      // sum of random-phase sinusoids with 1/f amplitudes, normalised to [LO, HI]
      const a = new Float64Array(n);
      for (let f = 1; f <= 200; f++) {
        const ph = 2 * Math.PI * r();
        for (let i = 0; i < n; i++) a[i] += Math.cos((2 * Math.PI * f * i) / (4 * n) + ph) / f;
      }
      let mn = Infinity; let mx = -Infinity;
      for (const x of a) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
      for (let i = 0; i < n; i++) a[i] = LO + ((HI - LO) * (a[i] - mn)) / (mx - mn);
      worst = Math.max(worst, periodicityScore(a));
    }
    expect(worst).toBeLessThan(NEG);
  });
  it('a dark base with 3 bright filaments (irregular spacing) and with 2 filaments', () => {
    const fil = (pos: number[]): Float64Array => {
      const a = new Float64Array(n).fill(LO);
      for (const p of pos) for (let i = 0; i < n; i++) a[i] += (HI - LO) * Math.exp(-(((i - p) / 1.2) ** 2));
      return a;
    };
    expect(periodicityScore(fil([22, 53, 107]))).toBeLessThan(NEG);
    expect(periodicityScore(fil([15, 70, 96]))).toBeLessThan(NEG);
    expect(periodicityScore(fil([40, 70]))).toBeLessThan(NEG);       // one exact spacing, no repeat
  });
});

describe('tile periodicity on 2-D patterns (the per-tile analysis of the GPU pass)', () => {
  for (const [W, H, periods] of [[1920, 1080, [6, 12, 16, 24, 30, 48, 80, 90]], [1280, 720, [6, 12, 16, 24, 30, 48, 60, 80, 90]]] as const) {
    for (const [name, mk] of Object.entries(PATTERNS)) {
      it(`${name} at ${W}x${H}, periods ${periods.join('/')} px: every probed tile >= 0.5 (Michelson 0.9)`, () => {
        for (const T of periods) {
          const lum = bilinear(mk(T, W, H), W, H);
          const means = tileMeans(lum, W, H);
          for (const [tx, ty] of TILES) {
            expect(tilePeriodicity(lum, means, W, H, tx, ty), `${name} T=${T} tile ${tx},${ty}`).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
          }
        }
      });
    }
  }

  it('curved large-period rings (120 px everywhere, 160 px mostly, at 1280x720) are caught by the grid profiles', () => {
    const W = 1280; const H = 720;
    for (const T of [120, 160]) {
      const lum = bilinear(PATTERNS.rings(T, W, H), W, H);
      const means = tileMeans(lum, W, H);
      const hits = TILES.filter(([tx, ty]) => tilePeriodicity(lum, means, W, H, tx, ty) >= GUARD_PERIODICITY_MIN).length;
      // 160 px = 8 tiles is the grid profiles' longest period: most, not all, tiles (dilation fills holes)
      expect(hits, `rings T=${T}`).toBeGreaterThanOrEqual(T === 120 ? TILES.length : TILES.length - 2);
    }
  });

  it('large periods (up to 1/5.3 of the width) are caught on the tile-mean grid', () => {
    const cols = 64; const rows = 36;
    for (const Ttiles of [4, 6, 8, 12]) {
      const mean = (c: number): number => sq(c + 0.5, Ttiles);
      for (const [tx, ty] of TILES) expect(gridPeriodicity(mean, tx, ty, cols, rows)).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
    }
    for (const Ttiles of [4, 6, 8]) {
      const mean = (_c: number, r: number): number => sq(r + 0.5, Ttiles);
      for (const [tx, ty] of TILES) expect(gridPeriodicity(mean, tx, ty, cols, rows)).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
    }
  });

  it('aperiodic 2-D content (bright blooms and filaments on a dark base, white noise) stays below 0.5', () => {
    const W = 1280; const H = 720; const r = rng(7);
    const blooms = Array.from({ length: 40 }, () => [r() * W, r() * H, 15 + 55 * r(), 0.2 + 0.5 * r()]);
    const fils = Array.from({ length: 4 }, () => [r() * W, r() * H, r() * Math.PI]);
    const lumBlobs: LumaFn = (x, y) => {
      let L = 0.05;
      for (const [cx, cy, s, a] of blooms) L += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      for (const [fx, fy, ang] of fils) {
        const d = Math.abs((x - fx) * Math.sin(ang) - (y - fy) * Math.cos(ang));
        L += 0.8 * Math.exp(-((d / 1.5) ** 2));
      }
      return Math.min(1, L);
    };
    const noise = new Float32Array(W * H); for (let i = 0; i < noise.length; i++) noise[i] = LO + (HI - LO) * r();
    const lumNoise = bilinear((x, y) => noise[Math.floor(y) * W + Math.floor(x)], W, H);
    const meansBlobs = tileMeans(lumBlobs, W, H); const meansNoise = tileMeans(lumNoise, W, H);
    let periodicBlobs = 0; let periodicNoise = 0; let probed = 0;
    for (let ty = 1; ty < 36; ty += 5) {
      for (let tx = 1; tx < 64; tx += 7) {
        probed++;
        if (tilePeriodicity(lumBlobs, meansBlobs, W, H, tx, ty) >= GUARD_PERIODICITY_MIN) periodicBlobs++;
        if (tilePeriodicity(lumNoise, meansNoise, W, H, tx, ty) >= GUARD_PERIODICITY_MIN) periodicNoise++;
      }
    }
    expect(periodicBlobs).toBe(0);
    expect(periodicNoise / probed).toBeLessThan(0.05);
  });

  it('coarse profiles are box-filtered so 2 px lines between sample points are still seen', () => {
    const W = 1920; const H = 1080; const step = COARSE_STEP_TILES * (W / 64);
    const lum = bilinear(PATTERNS.thinlines(41, W, H), W, H);
    const prof = sampleProfile(lum, W, H, 500, 500, 1, 0, step, PROFILE_N, 2);
    expect(Math.max(...prof)).toBeGreaterThan(0.3);
    expect(periodicityScore(prof)).toBeGreaterThanOrEqual(GUARD_PERIODICITY_MIN);
  });
});

describe('dilatePeriodic', () => {
  it('marks the 3x3 neighbourhood of each periodic tile and counts the raw periodic tiles', () => {
    const cols = 6; const rows = 4; const p = new Float32Array(cols * rows); p[1 * cols + 1] = 0.9; p[3 * cols + 5] = 0.6; p[0] = 0.49;
    const out = new Uint8Array(cols * rows);
    expect(dilatePeriodic(p, cols, rows, 0.5, out)).toBe(2);
    const set = [...out].reduce((s, v) => s + v, 0);
    expect(set).toBe(9 + 4);
    expect(out[0]).toBe(1); expect(out[2 * cols + 2]).toBe(1); expect(out[2 * cols + 4]).toBe(1); expect(out[3 * cols + 3]).toBe(0);
  });
});

describe('fillEnclosed', () => {
  it('fills holes enclosed by the mask (4-connected background) and leaves open regions alone', () => {
    const cols = 8; const rows = 6;
    const m = new Uint8Array(cols * rows);
    // a closed ring around (2..4, 1..3) and an open "U" on the right
    for (let c = 1; c <= 5; c++) { m[0 * cols + c] = 1; m[4 * cols + c] = 1; }
    for (let r = 0; r <= 4; r++) { m[r * cols + 1] = 1; m[r * cols + 5] = 1; }
    m[2 * cols + 7] = 1;
    const filled = fillEnclosed(m, cols, rows);
    expect(filled).toBe(9);
    for (let r = 1; r <= 3; r++) for (let c = 2; c <= 4; c++) expect(m[r * cols + c]).toBe(1);
    expect(m[5 * cols + 3]).toBe(0); expect(m[2 * cols + 6]).toBe(0); expect(m[0]).toBe(0);
  });
});

// ---- S8b: stripe detection (chirps, FM bar trains, bar codes) -------------------------------------
/** Box-filtered luminance at 8x8 texels per tile (the GPU's LUMA_DOWN level 0: 4x4 taps per texel), memoised. */
function level0Of(f: LumaFn, W: number, H: number): (i: number, j: number) => number {
  const cw = 512; const ch = 288; const cache = new Map<number, number>();
  return (i, j) => {
    const k = j * cw + i; const hit = cache.get(k); if (hit !== undefined) return hit;
    let s = 0;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) s += f(((i + (a + 0.5) / 4) * W) / cw, ((j + (b + 0.5) / 4) * H) / ch);
    cache.set(k, s / 16); return s / 16;
  };
}
const W0 = 1280; const H0 = 720;
const zone = (k: number, cx = W0 / 2, cy = H0 / 2, lo = LO, hi = HI): LumaFn => (x, y) =>
  lo + (hi - lo) * (0.5 + 0.5 * Math.cos(((x - cx) ** 2 + (y - cy) ** 2) * k));
/** strictly 2-D periodic lattice of zone-plate cells (period 640 x 360) */
const zoneLattice: LumaFn = (x, y) => {
  const qx = (((x % 640) + 640) % 640) - 320; const qy = (((y % 360) + 360) % 360) - 180;
  return LO + (HI - LO) * (0.5 + 0.5 * Math.cos((qx * qx + qy * qy) * 0.0006));
};
/** FM square bar train: carrier 24 px, deviation 0.025 * 2pi... (local period 15-60 px), repeats every 480 px */
const fmBars = (deg: number): LumaFn => (x, y) => {
  const a = (deg * Math.PI) / 180; const u = Math.cos(a) * x + Math.sin(a) * y;
  return Math.cos(2 * Math.PI * (u / 24 + 1.90986 * Math.sin((2 * Math.PI * u) / 480))) >= 0 ? HI : LO;
};
/** irregular bar code: 8-px cells along x, each black or white from an integer hash */
const barcode: LumaFn = (x) => {
  let h = Math.floor(x / 8) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) % 2 === 0 ? HI : LO;
};
/** rings in hyperbolic distance inside a Poincare disc of radius 380 px (black outside) */
const poincare: LumaFn = (x, y) => {
  const r = Math.hypot(x - W0 / 2, y - H0 / 2) / 380; if (r >= 1) return 0;
  const rho = Math.log((1 + r) / (1 - Math.min(r, 0.999)));
  return LO + (HI - LO) * (0.5 + 0.5 * Math.cos((2 * Math.PI * rho) / 0.35));
};
const stripeAt = (f: LumaFn, tx: number, ty: number): boolean => pixelStripe(bilinear(f, W0, H0), level0Of(f, W0, H0), W0, H0, tx, ty);
const tileMeanOf = (f: LumaFn) => tileMeans(f, W0, H0);

describe('countTransitions / stripeTransitions / tensorOrientation', () => {
  it('counts full-range swings: 5 sine cycles give 9-10, partial swings and flat profiles give 0', () => {
    const a = Float64Array.from({ length: 128 }, (_, i) => cosw(i, 25.6));
    const n = countTransitions(a); expect(n).toBeGreaterThanOrEqual(9); expect(n).toBeLessThanOrEqual(10);
    expect(countTransitions(new Float64Array(64).fill(0.3))).toBe(0);
    // one large swing then small wiggles (30% of the range): only the large swing counts
    const b = Float64Array.from({ length: 128 }, (_, i) => (i < 20 ? LO : HI - 0.3 * (HI - LO) * (0.5 + 0.5 * Math.cos(i))));
    expect(countTransitions(b)).toBe(1);
  });
  it('a zone-plate (chirp) profile is not periodic for the NSDF but has the swings of a stripe pattern', () => {
    const prof = Float64Array.from({ length: 128 }, (_, i) => zone(0.0003)(W0 / 2 + 120 + i * (20 / 7), H0 / 2));
    expect(periodicityScore(prof)).toBeLessThan(GUARD_PERIODICITY_MIN);
    const [all, mid] = stripeTransitions(prof, STRIPE_CENTRAL_N);
    expect(all).toBeGreaterThanOrEqual(8); expect(mid).toBeGreaterThanOrEqual(5);
  });
  it('the central window follows the tile position in a shifted profile and is clamped to it', () => {
    expect(centralStart(128, 64, 63.5)).toBe(32);
    expect(centralStart(128, 64, 10)).toBe(0);
    expect(centralStart(128, 64, 120)).toBe(64);
    expect(centralStart(32, 12, 15.5)).toBe(10);
  });
  it('orientation: vertical stripes are coherent across x (direction 0), isotropic content is not coherent', () => {
    expect(tensorOrientation(1, 0, 0)).toEqual({ coherence: 1, dir: 0 });
    expect(tensorOrientation(0, 1, 0).dir).toBe(4);
    expect(tensorOrientation(0.5, 0.5, 0.5).dir).toBe(2);          // gradient along 45 degrees
    expect(tensorOrientation(1, 1, 0).coherence).toBe(0);
  });
});

describe('pixelStripe: chirped and irregular stripe patterns (Michelson 0.9 unless noted) at 1280x720', () => {
  const outer: Array<[number, number]> = [[3, 2], [60, 33], [52, 5], [8, 30], [45, 30], [20, 4]];
  it('full-screen zone plates (k = 0.0002 / 0.0003 / 0.0004 / 0.0006): outer tiles are stripes', () => {
    for (const k of [0.0002, 0.0003, 0.0004, 0.0006]) {
      for (const [tx, ty] of outer) expect(stripeAt(zone(k), tx, ty), `k=${k} tile ${tx},${ty}`).toBe(true);
    }
  });
  it('a red-only zone plate (luminance 0 / 0.2126) and a zone plate off-centre are stripes', () => {
    for (const [tx, ty] of outer) expect(stripeAt(zone(0.0003, W0 / 2, H0 / 2, 0, 0.2126), tx, ty), `red ${tx},${ty}`).toBe(true);
    for (const [tx, ty] of [[40, 20], [60, 30], [30, 30]] as Array<[number, number]>) {
      expect(stripeAt(zone(0.00025, 0, 0), tx, ty), `corner-centred ${tx},${ty}`).toBe(true);
    }
  });
  it('a 2x2 lattice of zone-plate cells, FM bar trains at 0/11.25/90 degrees, a bar code and Poincare rings', () => {
    for (const [tx, ty] of [[3, 2], [28, 16], [36, 20], [60, 33]] as Array<[number, number]>) expect(stripeAt(zoneLattice, tx, ty), `lattice ${tx},${ty}`).toBe(true);
    for (const deg of [0, 11.25, 90]) {
      for (const [tx, ty] of [[10, 10], [32, 18], [55, 25]] as Array<[number, number]>) expect(stripeAt(fmBars(deg), tx, ty), `fm ${deg} ${tx},${ty}`).toBe(true);
    }
    for (const [tx, ty] of TILES) expect(stripeAt(barcode, tx, ty), `barcode ${tx},${ty}`).toBe(true);
    for (const [tx, ty] of [[32, 4], [46, 18], [18, 18], [32, 31]] as Array<[number, number]>) expect(stripeAt(poincare, tx, ty), `poincare ${tx},${ty}`).toBe(true);
  });
  it('aperiodic content is not: blooms and filaments on a dark base, white noise, dense dots, a smooth vignette', () => {
    const r = rng(7);
    const blooms = Array.from({ length: 40 }, () => [r() * W0, r() * H0, 15 + 55 * r(), 0.2 + 0.5 * r()]);
    const fils = Array.from({ length: 4 }, () => [r() * W0, r() * H0, r() * Math.PI]);
    const lumBlobs: LumaFn = (x, y) => {
      let L = 0.05;
      for (const [cx, cy, s, a] of blooms) L += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      for (const [fx, fy, ang] of fils) L += 0.8 * Math.exp(-((Math.abs((x - fx) * Math.sin(ang) - (y - fy) * Math.cos(ang)) / 1.5) ** 2));
      return Math.min(1, L);
    };
    const noise = new Float32Array(W0 * H0); for (let i = 0; i < noise.length; i++) noise[i] = LO + (HI - LO) * r();
    const lumNoise: LumaFn = (x, y) => noise[Math.min(H0 - 1, Math.floor(y)) * W0 + Math.min(W0 - 1, Math.floor(x))];
    const dots: LumaFn = (x, y) => {
      const cx = Math.floor(x / 5); const cy = Math.floor(y / 5);
      let h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0; h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      return (h ^ (h >>> 15)) % 7 === 0 ? 0.95 : 0.02;
    };
    const vignette: LumaFn = (x, y) => LO + (HI - LO) * Math.exp(-(((x - W0 / 2) / 500) ** 2 + ((y - H0 / 2) / 300) ** 2));
    let hits = 0; let probed = 0;
    for (let ty = 1; ty < 36; ty += 5) {
      for (let tx = 1; tx < 64; tx += 7) {
        probed++;
        for (const f of [lumBlobs, lumNoise, dots, vignette]) if (stripeAt(f, tx, ty)) hits++;
      }
    }
    expect(hits, `${hits} stripe tiles of ${probed * 4}`).toBe(0);
  });
});

describe('gridStripe: large rings over the whole screen ("more than five light-dark pairs" along a row)', () => {
  it('a slow zone plate (about 4 rings from the centre to the corner) is caught on the tile-mean grid', () => {
    const vslow: LumaFn = (x, y) => LO + (HI - LO) * (0.5 + 0.5 * Math.cos(2 * Math.PI * 0.8e-5 * ((x - W0 / 2) ** 2 + (y - H0 / 2) ** 2)));
    const m = tileMeanOf(vslow); let hits = 0;
    const probe: Array<[number, number]> = [[4, 18], [10, 10], [54, 26], [60, 18], [8, 30], [56, 6]];
    for (const [tx, ty] of probe) if (gridStripe(m, tx, ty)) hits++;
    expect(hits).toBeGreaterThanOrEqual(probe.length - 1);
  });
  it('but not 3.6 cycles of 200-px stripes, a vignette or blooms', () => {
    const big: LumaFn = (_x, y) => sq(y, 200);
    const vignette: LumaFn = (x, y) => LO + (HI - LO) * Math.exp(-(((x - W0 / 2) / 500) ** 2 + ((y - H0 / 2) / 300) ** 2));
    for (const f of [big, vignette]) {
      const m = tileMeanOf(f);
      for (const [tx, ty] of TILES) expect(gridStripe(m, tx, ty)).toBe(false);
    }
  });
});

describe('dilateMask', () => {
  it('dilates by the given radius', () => {
    const cols = 9; const rows = 7; const m = new Uint8Array(cols * rows); m[3 * cols + 4] = 1;
    const out = new Uint8Array(cols * rows);
    dilateMask(m, cols, rows, 2, out); expect(out.reduce((a, b) => a + b, 0)).toBe(25);
    dilateMask(m, cols, rows, 1, out); expect(out.reduce((a, b) => a + b, 0)).toBe(9);
  });
});

// ---- S8c: local spectrum (2-D lattices, crossed chirps, plaids; NOTES.md S8c) -----------------------------
/** The N x N window (pyramid level `level`: 2.5 * 2^level px per texel at 1280x720) of window (wx, wy),
 *  each texel the mean of (4 * 2^level)^2 point samples, like the GPU's box-filtered luminance pyramid. */
function spectralBlock(f: LumaFn, wx: number, wy: number, level: number): Float64Array {
  const tpt = 8 >> level; const wt = SPECTRAL_N / tpt;
  const ox = spectralOrigin(wx, wt, 64) * tpt; const oy = spectralOrigin(wy, wt, 36) * tpt;
  const texel = (W0 / 512) * (1 << level); const sps = 4 << level;
  const b = new Float64Array(SPECTRAL_N * SPECTRAL_N);
  for (let j = 0; j < SPECTRAL_N; j++) {
    for (let i = 0; i < SPECTRAL_N; i++) {
      let acc = 0;
      for (let v = 0; v < sps; v++) for (let u = 0; u < sps; u++) acc += f((ox + i + (u + 0.5) / sps) * texel, (oy + j + (v + 0.5) / sps) * texel);
      b[j * SPECTRAL_N + i] = acc / (sps * sps);
    }
  }
  return b;
}
const top3At = (f: LumaFn, wx: number, wy: number): number =>
  Math.max(spectralTop3(spectralBlock(f, wx, wy, 0)), spectralTop3(spectralBlock(f, wx, wy, 1)));
const lv = (s: number): number => LO + (HI - LO) * Math.min(1, Math.max(0, s));
// crossed chirps: two families of rings around centres off screen, balanced (sw2_a190_p2.75_D1200_T24)
const biChirp = (p: number, D: number, T0: number, a0: number, a1: number, square = false): LumaFn => (x, y) => {
  const cx = x - W0 / 2; const cy = y - H0 / 2; const R = 1.2 * D;
  const fam = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180; const d = Math.hypot(cx - R * Math.cos(a), cy - R * Math.sin(a)) / D;
    return [((2 * Math.PI) / T0) * (D / p) * d ** p, 1 / d ** (p - 1)];
  };
  const [f0, i0] = fam(a0); const [f1, i1] = fam(a1);
  let s = (i0 * Math.cos(f0) + i1 * Math.cos(f1)) / (i0 + i1);
  s = (s + 1) / 2;
  return lv(square ? (s > 0.5 ? 1 : 0) : s);
};
const logPolarPlaid = (N: number, ox: number, oy: number): LumaFn => (x, y) => {
  const r = Math.max(1, Math.hypot(x - ox, y - oy)); const th = Math.atan2(y - oy, x - ox);
  return lv(0.5 + 0.25 * Math.cos(N * Math.log(r)) + 0.25 * Math.cos(N * th));
};
const z2hex = (k: number): LumaFn => (x, y) => {
  const cx = x - W0 / 2; const cy = y - H0 / 2; const wx = k * (cx * cx - cy * cy); const wy = k * 2 * cx * cy;
  const s = Math.cos(wx) + Math.cos(-0.5 * wx + 0.866 * wy) + Math.cos(-0.5 * wx - 0.866 * wy);
  return lv((s + 1.5) / 4.5);
};

describe('spectralPeaks: sparse local spectra', () => {
  const grid = (f: LumaFn): Float64Array => {
    const b = new Float64Array(SPECTRAL_N * SPECTRAL_N);
    for (let j = 0; j < SPECTRAL_N; j++) for (let i = 0; i < SPECTRAL_N; i++) b[j * SPECTRAL_N + i] = f(i, j);
    return b;
  };
  it('one grating puts its energy in one peak; an egg-crate in two; a hexagonal lattice in three', () => {
    const g = spectralPeaks(grid((x, y) => cosw(x * Math.cos(0.5) + y * Math.sin(0.5), 6.4)));
    expect(g.fractions[0]).toBeGreaterThan(0.8);
    const egg = spectralPeaks(grid((x, y) => lv(0.5 + 0.25 * Math.cos(x * 0.9) + 0.25 * Math.cos(y * 0.9))));
    expect(egg.fractions[0]).toBeLessThan(0.6);
    expect(egg.fractions[0] + egg.fractions[1]).toBeGreaterThan(0.85);
    const hex = PATTERNS.hex(7, 0, 0);
    const h = spectralPeaks(grid(hex));
    expect(h.fractions[0]).toBeLessThan(0.45);
    expect(spectralTop3(grid(hex))).toBeGreaterThan(0.85);
  });
  it('a flat window and pure white noise are not sparse', () => {
    expect(spectralTop3(new Float64Array(SPECTRAL_N * SPECTRAL_N).fill(0.3))).toBe(0);
    const r = rng(5); let worst = 0;
    for (let s = 0; s < 20; s++) worst = Math.max(worst, spectralTop3(grid(() => r())));
    expect(worst).toBeLessThan(0.3);
  });
  // as in flashcheck, a candidate's 3x3 neighbourhood still reaches radius 2, so a 2-cycle grating counts
  it('peaks below SPECTRAL_MIN_CYCLES are not candidates: one cycle per window is not a pattern', () => {
    expect(spectralTop3(grid((x) => cosw(x, SPECTRAL_N)))).toBeLessThan(0.2);
    expect(spectralTop3(grid((x, y) => cosw(x + y, SPECTRAL_N)))).toBeLessThan(0.2);
  });
  it('window origins follow the tile corners and stay on the grid', () => {
    expect(spectralOrigin(0, 8, 64)).toBe(0); expect(spectralOrigin(5, 8, 64)).toBe(7); expect(spectralOrigin(31, 8, 64)).toBe(56);
    expect(spectralOrigin(5, 4, 64)).toBe(9); expect(spectralOrigin(17, 8, 36)).toBe(28);
  });
});

describe('spectral windows at 1280x720: S8c evasions are sparse, aperiodic content is not', () => {
  const sweep = (f: LumaFn, cols = [1, 6, 11, 16, 21, 26, 31], rows = [1, 5, 9, 13, 17]): number => {
    let hit = 0; let n = 0;
    for (const wy of rows) for (const wx of cols) { n++; if (top3At(f, wx, wy) >= SPECTRAL_TOP3_MIN) hit++; }
    return hit / n;
  };
  it('crossed chirps (egg-crate rings; sine and square profile, 24 and 28 px carriers)', () => {
    expect(sweep(biChirp(2.75, 1200, 24, 190, 280))).toBeGreaterThanOrEqual(0.9);
    expect(sweep(biChirp(3.0, 1100, 28, 210, 300))).toBeGreaterThanOrEqual(0.9);
    expect(sweep(biChirp(2.75, 1200, 24, 190, 280, true))).toBeGreaterThanOrEqual(0.9);
  });
  it('a conformal z^2 hexagonal lattice and a log-polar plaid (full screen and its 30 % corner)', () => {
    expect(sweep(z2hex(0.0003), [1, 6, 26, 31], [1, 5, 13, 17])).toBeGreaterThanOrEqual(0.9);
    expect(sweep(logPolarPlaid(100, W0 / 2, H0 / 2), [1, 6, 26, 31], [1, 5, 13, 17])).toBeGreaterThanOrEqual(0.8);
    // corner: the plaid around the top-left corner fills x < 0.5477 W, y < 0.5477 H (black elsewhere)
    const corner: LumaFn = (x, y) => (x < 0.5477 * W0 && y < 0.5477 * H0 ? logPolarPlaid(100, 0, 0)(x, y) : 0);
    expect(sweep(corner, [4, 8, 12, 15], [3, 6, 8])).toBeGreaterThanOrEqual(0.8);
  });
  it('three light-dark pairs of 48-px bands along the top and bottom edges', () => {
    const bands: LumaFn = (_x, y) => (Math.abs(y / H0 - 0.5) < 0.3 ? 0 : sq(y, 48));
    for (const wx of [2, 15, 29]) {
      expect(top3At(bands, wx, 1), `top ${wx}`).toBeGreaterThanOrEqual(SPECTRAL_TOP3_MIN);
      expect(top3At(bands, wx, 16), `bottom ${wx}`).toBeGreaterThanOrEqual(SPECTRAL_TOP3_MIN);
    }
  });
  it('blooms and filaments on a dark base, 1/f value noise and white noise stay below SPECTRAL_TOP3_MIN', () => {
    const r = rng(9);
    const blooms = Array.from({ length: 40 }, () => [r() * W0, r() * H0, 15 + 55 * r(), 0.2 + 0.5 * r()]);
    const blobs: LumaFn = (x, y) => {
      let L = 0.05;
      for (const [cx, cy, s, a] of blooms) L += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      return Math.min(1, L);
    };
    // value noise, octaves 160 .. 5 px with amplitude ~ size (1/f), smoothstep-interpolated lattice hashes
    const hash = (i: number, j: number, o: number): number => {
      let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(o, 2147483647)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const vnoise = (x: number, y: number, o: number): number => {
      const i = Math.floor(x); const j = Math.floor(y); const fx = x - i; const fy = y - j;
      const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
      const a = hash(i, j, o) + (hash(i + 1, j, o) - hash(i, j, o)) * sx;
      const b = hash(i, j + 1, o) + (hash(i + 1, j + 1, o) - hash(i, j + 1, o)) * sx;
      return a + (b - a) * sy;
    };
    const fbm: LumaFn = (x, y) => {
      let s = 0; let w = 0;
      for (let o = 0; o < 6; o++) { const size = 160 / 2 ** o; s += size * vnoise(x / size, y / size, o); w += size; }
      return lv((s / w - 0.5) * 3 + 0.5);
    };
    const white: LumaFn = (x, y) => hash(Math.floor(x), Math.floor(y), 99);
    for (const [name, f] of [['blobs', blobs], ['fbm', fbm], ['white', white]] as Array<[string, LumaFn]>) {
      expect(sweep(f), name).toBeLessThanOrEqual(0.06);
    }
  });
});
