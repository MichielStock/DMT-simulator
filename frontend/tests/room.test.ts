// Room layer pure parts (BUILD.md 11.3, 8.1): geometry selection, depth → displacement, framing,
// wallpaper folds, effect amounts and their safety limits.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PLANE_DEPTH, SPHERE_DEPTH, ROOM_FREQS, TRACER_TAU_S, WALLPAPER_GROUPS, buildPlaneGeometry, buildSphereGeometry,
  cameraPose, coverFit, depthRayScale, depthToDisplacement, edgeAttenuation, foldP4m, foldP6m, foldPmm,
  foldWallpaper, hexCentre, roomEffects, selectRoomGeometry, tracerFeedback, tri, wallpaperForSeed,
} from '../src/layers/roomGeometry';
import { NOISE_GLSL } from '../src/layers/noise';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('geometry selection', () => {
  it('no image → procedural interior', () => {
    expect(selectRoomGeometry('default', false)).toBe('procedural');
    expect(selectRoomGeometry('photo', false, 1024, 768)).toBe('procedural');
    expect(selectRoomGeometry(null, false)).toBe('procedural');
  });
  it('photo → plane; default room with the sample photo → plane', () => {
    expect(selectRoomGeometry('photo', true, 1024, 768)).toBe('plane');
    expect(selectRoomGeometry('default', true, 1024, 768)).toBe('plane');
    expect(selectRoomGeometry('photo', true, 2048, 1024)).toBe('plane');
  });
  it('2:1 panorama → sphere; a non-2:1 "panorama" falls back to a plane', () => {
    expect(selectRoomGeometry('panorama', true, 2048, 1024)).toBe('sphere');
    expect(selectRoomGeometry('panorama', true, 4000, 1950)).toBe('sphere');
    expect(selectRoomGeometry('panorama', true, 1600, 1000)).toBe('plane');
    expect(selectRoomGeometry('panorama', true, 1024, 1024)).toBe('plane');
  });
});

describe('depth → displacement', () => {
  it('white is near (towards the viewer), monotonic, bounded', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 1.0001; d += 0.05) {
      const x = depthToDisplacement(d);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
    expect(depthToDisplacement(1)).toBeGreaterThan(0);
    expect(depthToDisplacement(0)).toBeLessThan(0);
    expect(close(depthToDisplacement(PLANE_DEPTH.pivot), 0)).toBe(true);
    for (const m of [PLANE_DEPTH, SPHERE_DEPTH]) {
      expect(depthToDisplacement(1, m)).toBeLessThan(0.5);      // never passes the eye
      expect(depthRayScale(1, m)).toBeGreaterThan(0.5);
      expect(depthToDisplacement(-3, m)).toBe(depthToDisplacement(0, m));   // clamped input
      expect(depthToDisplacement(NaN, m)).toBe(depthToDisplacement(0, m));
    }
  });
  it('vertices slide along their view rays (rest view undistorted)', () => {
    const p = new THREE.Vector3(0.3, -0.2, -1);
    const s = depthRayScale(0.9);
    const q = p.clone().multiplyScalar(s);
    expect(close(q.x / -q.z, p.x / -p.z, 1e-12)).toBe(true);
    expect(close(q.y / -q.z, p.y / -p.z, 1e-12)).toBe(true);
    expect(-q.z).toBeLessThan(1);
  });
  it('edge attenuation keeps the mesh rim fixed', () => {
    expect(edgeAttenuation(0, 0.5, 0.04)).toBe(0);
    expect(edgeAttenuation(0.5, 0.5, 0.04)).toBe(1);
    expect(edgeAttenuation(0.02, 0.5, 0.04)).toBeCloseTo(0.5, 6);
    expect(edgeAttenuation(0.5, 0.5, 0)).toBe(1);
  });
});

describe('framing and look', () => {
  it('cover fit covers the view with overscan for any aspect', () => {
    for (const [ia, va] of [[4 / 3, 16 / 9], [16 / 9, 4 / 3], [1, 1], [3, 16 / 9]]) {
      const { width, height } = coverFit(ia, va, 50, 1, 1.14);
      const viewH = 2 * Math.tan((50 * Math.PI) / 360);
      expect(height).toBeGreaterThanOrEqual(viewH * 1.14 - 1e-9);
      expect(width).toBeGreaterThanOrEqual(viewH * va * 1.14 - 1e-9);
      expect(close(width / height, ia, 1e-9)).toBe(true);
    }
  });
  it('the clamped look never reveals the plane border', () => {
    // worst case of main.ts's clamp: yaw 0.35, pitch 0.2; check the four view corners hit the plane
    const va = 16 / 9;
    const { width, height } = coverFit(4 / 3, va);
    const pose = cameraPose('plane', 0.35, 0.2);
    const cam = new THREE.PerspectiveCamera(50, va, 0.01, 10);
    cam.position.set(pose.x, pose.y, 0);
    cam.rotation.set(pose.pitch, -pose.yaw, 0, 'YXZ');
    cam.updateMatrixWorld();
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const dir = new THREE.Vector3(x, y, 0.5).unproject(cam).sub(cam.position).normalize();
      // the rim of the mesh stays at the rest distance (edge attenuation), so the view corners must hit
      // the rest plane inside the rim
      for (const zPlane of [1]) {
        const t = (zPlane + cam.position.z) / -dir.z;
        const hit = cam.position.clone().addScaledVector(dir, t);
        // rest-plane coordinates of the vertex that sits there (vertices slide along rays from the origin)
        const rx = hit.x / zPlane, ry = hit.y / zPlane;
        expect(Math.abs(rx)).toBeLessThan(width / 2);
        expect(Math.abs(ry)).toBeLessThan(height / 2);
      }
    }
  });
  it('the panorama looks around for real; the photo only partly', () => {
    expect(cameraPose('sphere', 0.3, 0.1).yaw).toBeCloseTo(0.3);
    expect(Math.abs(cameraPose('plane', 0.3, 0.1).yaw)).toBeLessThan(0.3);
    expect(cameraPose('plane', 0, 0)).toEqual({ x: 0, y: 0, yaw: 0, pitch: 0 });
  });
  it('geometries', () => {
    const p = buildPlaneGeometry(2, 1.5, 8, 6);
    const pos = p.getAttribute('position');
    expect(pos.count).toBe(9 * 7);
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBe(-1);
    const s = buildSphereGeometry(10, 16, 8);
    const sp = s.getAttribute('position');
    const uv = s.getAttribute('uv');
    // u = 0.5 at the equator faces straight ahead (-z)
    let best = -1, bestZ = 0;
    for (let i = 0; i < sp.count; i++) {
      if (Math.abs(uv.getY(i) - 0.5) < 1e-6 && Math.abs(uv.getX(i) - 0.5) < 1e-6) { best = i; bestZ = sp.getZ(i); }
    }
    expect(best).toBeGreaterThanOrEqual(0);
    expect(bestZ).toBeCloseTo(-10, 4);
  });
});

describe('wallpaper folds', () => {
  const pts: [number, number][] = [];
  for (let i = 0; i < 400; i++) pts.push([Math.sin(i * 12.9898) * 7.3, Math.cos(i * 78.233) * 5.1]);

  it('triangle wave', () => {
    expect(tri(0)).toBe(0);
    expect(tri(0.5)).toBe(0.5);
    expect(tri(0.25)).toBe(0.25);
    expect(tri(0.75)).toBeCloseTo(0.25);
    expect(tri(-0.25)).toBeCloseTo(0.25);
    expect(tri(3.1)).toBeCloseTo(0.1);
  });
  it('pmm and p4m: periodic, mirror-invariant, inside the fundamental domain', () => {
    for (const [x, y] of pts) {
      const a = foldPmm(x, y);
      expect(a[0]).toBeGreaterThanOrEqual(0); expect(a[0]).toBeLessThanOrEqual(0.5);
      expect(a[1]).toBeGreaterThanOrEqual(0); expect(a[1]).toBeLessThanOrEqual(0.5);
      expect(foldPmm(-x, y)[0]).toBeCloseTo(a[0], 9);          // mirror x = 0
      expect(foldPmm(1 - x, y)[0]).toBeCloseTo(a[0], 9);       // mirror x = 0.5
      expect(foldPmm(x + 3, y - 2)[1]).toBeCloseTo(a[1], 9);   // translation
      const b = foldP4m(x, y);
      expect(b[1]).toBeLessThanOrEqual(b[0] + 1e-12);
      const c = foldP4m(y, x);                                  // diagonal mirror
      expect(c[0]).toBeCloseTo(b[0], 9); expect(c[1]).toBeCloseTo(b[1], 9);
      const r = foldP4m(-y, x);                                 // 4-fold rotation
      expect(r[0]).toBeCloseTo(b[0], 9); expect(r[1]).toBeCloseTo(b[1], 9);
    }
  });
  it('p6m: hex lattice translations, 6-fold rotation and mirrors; wedge domain', () => {
    const R = Math.PI / 3;
    for (const [x, y] of pts) {
      const a = foldP6m(x, y);
      const ang = Math.atan2(a[1], a[0]);
      expect(ang).toBeGreaterThanOrEqual(-1e-9);
      expect(ang).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
      expect(Math.hypot(a[0], a[1])).toBeLessThanOrEqual(1 / Math.sqrt(3) + 1e-9);
      const [cx, cy] = hexCentre(x, y);
      const lx = x - cx, ly = y - cy;
      const rot = foldP6m(cx + lx * Math.cos(R) - ly * Math.sin(R), cy + lx * Math.sin(R) + ly * Math.cos(R));
      expect(rot[0]).toBeCloseTo(a[0], 6); expect(rot[1]).toBeCloseTo(a[1], 6);
      const mir = foldP6m(cx + lx, cy - ly);
      expect(mir[0]).toBeCloseTo(a[0], 6); expect(mir[1]).toBeCloseTo(a[1], 6);
      const tr = foldP6m(x + 0.5, y + Math.sqrt(3) / 2);
      expect(tr[0]).toBeCloseTo(a[0], 6); expect(tr[1]).toBeCloseTo(a[1], 6);
    }
  });
  it('folds are continuous (no seams inside a repetition block)', () => {
    for (const g of WALLPAPER_GROUPS) {
      let maxJump = 0;
      const h = 1e-4;
      for (const [x, y] of pts) {
        const a = foldWallpaper(g.id, x, y), b = foldWallpaper(g.id, x + h, y + h * 0.7);
        maxJump = Math.max(maxJump, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      expect(maxJump).toBeLessThan(5 * h);
    }
  });
  it('group per trip seed; ids match the shader constants', () => {
    expect(WALLPAPER_GROUPS.map((g) => g.id)).toEqual([0, 1, 2]);
    expect(wallpaperForSeed(0).name).toBe('pmm');
    expect(wallpaperForSeed(4).name).toBe('p4m');
    expect(wallpaperForSeed(-5).name).toBe('p6m');
    const frag = readFileSync(resolve(__dirname, '../src/layers/glsl/roomMesh.frag.glsl'), 'utf8');
    expect(frag).toMatch(/uGroup == 2/);
    expect(frag).toMatch(/uGroup == 1/);
  });
});

describe('effect amounts and safety at source', () => {
  it('calm room below the distortion window, rising with v', () => {
    const calm = roomEffects(0, 0, 0);
    expect(calm.breathe).toBe(0); expect(calm.drift).toBe(0); expect(calm.tile).toBe(0);
    expect(calm.sat).toBe(1); expect(calm.hue).toBe(0); expect(calm.tracer).toBe(0);
    const v1 = roomEffects(1, 0.16, 0), v3 = roomEffects(3, 1, 0), v5 = roomEffects(5, 1, 0);
    expect(v1.breathe).toBeLessThan(0.15);
    expect(v1.tile).toBe(0);
    expect(v3.breathe).toBeGreaterThan(0.5);
    expect(v3.tile).toBeGreaterThan(0.4);
    expect(v5.sat).toBeGreaterThan(v3.sat);
    expect(v5.hue).toBeGreaterThan(v3.hue);
    expect(v5.hue).toBeLessThan(0.5);   // "slight" hue rotation
    for (const v of [0, 2, 5, 9]) for (const d of [0, 0.5, 1]) for (const c of [0, 1]) {
      const f = roomEffects(v, d, c);
      for (const k of ['breathe', 'drift', 'warp', 'tile', 'tracer', 'palette', 'deep', 'shoulder', 'fringe', 'glow', 'bloom'] as const) {
        expect(f[k]).toBeGreaterThanOrEqual(0); expect(f[k]).toBeLessThanOrEqual(1);
      }
      expect(f.tileScale).toBeGreaterThan(0.04);
    }
  });
  it('all modulation frequencies stay at or below 0.5 Hz, also during a difficult passage', () => {
    for (const [k, hz] of Object.entries(ROOM_FREQS)) {
      if (k === 'challengeBoost') continue;
      expect(hz * ROOM_FREQS.challengeBoost).toBeLessThanOrEqual(0.5);
    }
    expect(roomEffects(9, 1, 1).speed).toBeLessThanOrEqual(ROOM_FREQS.challengeBoost);
  });
  it('tracer feedback: none when still, decays within 0.5 s when moving', () => {
    expect(tracerFeedback(0, 1, 1 / 60)).toBe(0);
    const k = tracerFeedback(1, 1, 1 / 60);
    expect(k).toBeGreaterThan(0.8);
    expect(Math.pow(k, 0.5 * 60)).toBeLessThan(0.02);
    expect(TRACER_TAU_S).toBeLessThanOrEqual(0.13);
    expect(tracerFeedback(1, 1, 0)).toBe(0);
  });
  it('shared noise snippets are include-guarded and prefixed', () => {
    expect(NOISE_GLSL).toMatch(/#ifndef HS_NOISE_GLSL/);
    for (const fn of ['hs_snoise3', 'hs_snoise2', 'hs_fbm3', 'hs_curl2', 'hs_curl3', 'hs_hash12']) expect(NOISE_GLSL).toContain(fn);
  });
});

describe('visual direction (docs/VISUAL_DIRECTION.md)', () => {
  it('v 1: the room is itself, slightly richer; vivid by v 3; jewelled by v 5; a passage never desaturates', () => {
    const v1 = roomEffects(1, 0.26, 0), v3 = roomEffects(3, 1, 0), v5 = roomEffects(5, 1, 0), v9 = roomEffects(9, 1, 0);
    expect(v1.sat).toBeGreaterThan(1.05); expect(v1.sat).toBeLessThan(1.15);   // ≈ +10 %
    expect(v1.deep).toBeLessThan(0.1); expect(v1.palette).toBeLessThan(0.05); expect(v1.glow).toBeLessThan(0.05);
    expect(v3.sat).toBeGreaterThan(1.6); expect(v3.palette).toBeGreaterThan(0.2); expect(v3.fringe).toBeGreaterThan(0.3);
    expect(v5.sat).toBeGreaterThan(v3.sat); expect(v5.deep).toBeGreaterThan(v3.deep); expect(v5.glow).toBeGreaterThan(v3.glow);
    expect(v9.palette).toBeGreaterThanOrEqual(v5.palette);
    const c = roomEffects(9, 1, 1);
    expect(c.sat).toBeGreaterThanOrEqual(v9.sat);
    expect(c.palette).toBeGreaterThan(v9.palette);
  });
  it('jewel stops: chromatic palette colours, dark → bright, no background black or pastel', async () => {
    const { jewelStops, lumOf, hexToLinear } = await import('../src/layers/roomGeometry');
    const neon = jewelStops(['#0d0221', '#ff2a6d', '#05d9e8', '#d1f7ff', '#7b2ff7', '#f9c80e']);
    expect(neon).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(lumOf(neon[i])).toBeGreaterThanOrEqual(lumOf(neon[i - 1]));
    const near = (a: number[], hex: string) => hexToLinear(hex).every((x, i) => Math.abs(x - a[i]) < 1e-6);
    expect(neon.some((c) => near(c, '#d1f7ff'))).toBe(false);   // pastel skipped
    expect(neon.some((c) => near(c, '#0d0221'))).toBe(false);   // background skipped
    for (const pal of [[], null, ['#808080', '#ffffff']]) {
      const s = jewelStops(pal as string[] | null);
      expect(s).toHaveLength(4);
      for (const c of s) expect(Math.max(...c) - Math.min(...c)).toBeGreaterThan(0.3);
    }
  });
  it('broad-area colours stay below the saturated-red share (BUILD.md 4.1)', async () => {
    const { jewelStops, limitRedShare, RED_SHARE_MAX, ACID_COLOURS } = await import('../src/layers/roomGeometry');
    const share = (c: number[]) => c[0] / (c[0] + c[1] + c[2]);
    for (const pal of [['#1a0505', '#7a1f0f', '#d9480f', '#f59f00', '#ffd43b', '#9c36b5'], ['#ff0000', '#cc0000', '#ff2200']]) {
      for (const c of jewelStops(pal)) expect(share(c)).toBeLessThanOrEqual(RED_SHARE_MAX + 1e-9);
    }
    expect(share(limitRedShare([1, 0, 0]))).toBeCloseTo(RED_SHARE_MAX, 9);
    expect(limitRedShare([0.2, 0.5, 0.1])).toEqual([0.2, 0.5, 0.1]);
    for (const c of ACID_COLOURS) expect(share(c)).toBeLessThan(0.8);
  });
});

describe('palette', () => {
  it('vivid colours skip near-black background colours', async () => {
    const { vividColours } = await import('../src/layers/roomGeometry');
    const v = vividColours(['#03140c', '#0b5d3b', '#2fbf71', '#c3f73a', '#f0a202', '#6a4c93']);
    expect(v).toHaveLength(3);
    for (const c of v) expect(Math.max(...c)).toBeGreaterThan(0.1);
    expect(vividColours([])).toHaveLength(3);
    expect(vividColours(null)).toHaveLength(3);
  });
});

describe('polish r2: progression, phosphene field, passage (docs/VISUAL_DIRECTION.md, NOTES D-P-room-r2)', () => {
  it('the room folds only at the highest intensities, and visibly more at v 9 than at v 7.5', () => {
    expect(roomEffects(5, 1, 0).fold).toBe(0);
    expect(roomEffects(6.4, 1, 0).fold).toBe(0);
    const f75 = roomEffects(7.5, 1, 0).fold, f9 = roomEffects(9, 1, 0).fold;
    expect(f75).toBeGreaterThan(0.1);
    expect(f9 - f75).toBeGreaterThan(0.4);
    expect(roomEffects(9, 0, 0).fold).toBe(0);   // no distortion amount → no fold
  });
  it('tunnel flow of the eyes-closed field stays slow, and within 2 Hz in a passage (BUILD.md 4.1)', async () => {
    const { phospheneZoomRate, FIELD_MIN_PERIOD_X } = await import('../src/layers/roomGeometry');
    expect(phospheneZoomRate(0) / FIELD_MIN_PERIOD_X).toBeLessThanOrEqual(0.13);
    expect(phospheneZoomRate(1)).toBeGreaterThan(phospheneZoomRate(0));
    // worst case: the flow plus the neural field's own drift cap (0.3 Hz)
    expect(phospheneZoomRate(1) / FIELD_MIN_PERIOD_X + 0.3).toBeLessThanOrEqual(1.0);
  });
  it('phosphene colours: the two most different darkable hues (neon: hot magenta against cyan)', async () => {
    const { jewelStops, phospheneColours, yiqHue, darkable, hexToLinear } = await import('../src/layers/roomGeometry');
    const neon = phospheneColours(jewelStops(['#0d0221', '#ff2a6d', '#05d9e8', '#d1f7ff', '#7b2ff7', '#f9c80e']));
    const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 0.12);
    expect(neon.some((c) => near(c, hexToLinear('#05d9e8')))).toBe(true);
    expect(neon.some((c) => c[0] > 0.9 && c[1] < 0.15)).toBe(true);   // hot magenta (red share limited)
    for (const pal of [['#060b1f', '#1c2c5b', '#4361ee', '#7fd1ff', '#c8b6ff', '#e9d8a6'], ['#1b0a3c', '#5b1a8f', '#c2187a', '#e8a33b', '#1f8f7a', '#3a5bd9']]) {
      const [a, b] = phospheneColours(jewelStops(pal));
      const d = Math.abs(yiqHue(a) - yiqHue(b)) % (2 * Math.PI);
      expect(Math.min(d, 2 * Math.PI - d)).toBeGreaterThanOrEqual(1.0);
      expect(darkable(a) && darkable(b)).toBe(true);
      for (const c of [a, b]) expect(c[0] / (c[0] + c[1] + c[2])).toBeLessThan(0.8);
    }
  });
  it('a passage: two acid complementaries (cyan against magenta), never a saturated red', async () => {
    const { ACID_COLOURS, yiqHue } = await import('../src/layers/roomGeometry');
    const d = Math.abs(yiqHue(ACID_COLOURS[0]) - yiqHue(ACID_COLOURS[1])) % (2 * Math.PI);
    expect(Math.min(d, 2 * Math.PI - d)).toBeGreaterThan(2.5);
    for (const c of ACID_COLOURS) expect(c[0] / (c[0] + c[1] + c[2])).toBeLessThan(0.8);
  });
  it('shaders keep the safety-at-source budget of the periodic lace and the aperiodic blooms', () => {
    const fin = readFileSync(resolve(__dirname, '../src/layers/glsl/roomFinal.frag.glsl'), 'utf8');
    const floor = Number(/const float L_FLOOR = ([0-9.]+);/.exec(fin)![1]);
    const ratio = Number(/const float LACE_RATIO = ([0-9.]+);/.exec(fin)![1]);
    expect(floor).toBeLessThanOrEqual(0.02);
    expect((ratio - 1) / (ratio + 1)).toBeLessThan(0.45);   // bare lace under the guard's 0.45 tile test
    expect(fin).toMatch(/1\.0 - 0\.6 \* uChallenge/);       // a passage darkens the base, never lifts it
  });
});
