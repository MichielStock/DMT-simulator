// Room layer: pure geometry and parameter helpers (BUILD.md 11.3, 8.1). No WebGL here, so everything
// is unit-tested in frontend/tests/room.test.ts. The GLSL in glsl/room*.glsl implements the same
// formulas; the constants it needs are passed in as uniforms from these definitions.

import * as THREE from 'three';

export type RoomSource = 'photo' | 'panorama' | 'default';
/** plane: depth-displaced photo; sphere: displaced inward-facing panorama; procedural: built-in interior. */
export type RoomGeometryKind = 'plane' | 'sphere' | 'procedural';

/** A panorama must be 2:1 equirectangular (± this tolerance), otherwise it is shown as a photo (§0.6). */
export const PANORAMA_ASPECT = 2;
export const PANORAMA_ASPECT_TOL = 0.15;

export function selectRoomGeometry(source: string | null | undefined, hasImage: boolean,
  width = 0, height = 0): RoomGeometryKind {
  if (!hasImage) return 'procedural';
  if (source === 'panorama' && height > 0 && Math.abs(width / height - PANORAMA_ASPECT) <= PANORAMA_ASPECT_TOL) return 'sphere';
  return 'plane';
}

// ------------------------------------------------------------------------------------ depth

/** Depth map convention: grey PNG, white = near (synthetic depth and Depth Anything's relative inverse
 *  depth both satisfy this). `amount` is the displacement range in units of the rest distance, `pivot`
 *  the depth that stays on the rest surface, `gamma` shapes relative-inverse depth. */
export interface DepthMapping { amount: number; pivot: number; gamma: number; edgeFade: number }

export const PLANE_DEPTH: DepthMapping = Object.freeze({ amount: 0.42, pivot: 0.45, gamma: 1.0, edgeFade: 0.04 });
export const SPHERE_DEPTH: DepthMapping = Object.freeze({ amount: 0.3, pivot: 0.4, gamma: 1.0, edgeFade: 0 });

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** Signed displacement TOWARDS the viewer, as a fraction of the rest distance: near (white) > 0.
 *  Bounded to [-amount*pivot, amount*(1-pivot)] so geometry never passes the camera. */
export function depthToDisplacement(depth: number, m: DepthMapping = PLANE_DEPTH): number {
  const d = Math.pow(clamp01(depth), m.gamma);
  return m.amount * (d - m.pivot);
}

/** Scale applied to a rest-surface vertex (camera at the origin): the vertex slides along its view ray,
 *  so the image is undistorted from the rest viewpoint and parallax appears only when the eye moves. */
export function depthRayScale(depth: number, m: DepthMapping = PLANE_DEPTH): number {
  return 1 - depthToDisplacement(depth, m);
}

/** Displacement fades to zero within `edgeFade` (uv units) of the image border so the mesh rim stays put. */
export function edgeAttenuation(u: number, v: number, fade: number): number {
  if (fade <= 0) return 1;
  const e = Math.min(u, v, 1 - u, 1 - v);
  const t = clamp01(e / fade);
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------------------------ framing

export const CAMERA_FOV_DEG = 50;
export const PLANE_DISTANCE = 1;
/** Extra coverage so that the comfort-clamped mouse look never shows the mesh border. */
export const PLANE_OVERSCAN = 1.22;

/** Size of the photo plane at distance `dist` so it covers the view (cover fit) with overscan. */
export function coverFit(imageAspect: number, viewAspect: number, fovDeg = CAMERA_FOV_DEG,
  dist = PLANE_DISTANCE, overscan = PLANE_OVERSCAN): { width: number; height: number } {
  const viewH = 2 * dist * Math.tan((fovDeg * Math.PI) / 360);
  const viewW = viewH * viewAspect;
  const ia = imageAspect > 0 && Number.isFinite(imageAspect) ? imageAspect : 4 / 3;
  const width = Math.max(viewW, viewH * ia) * overscan;
  return { width, height: width / ia };
}

/** Comfort mapping of state.look (already clamped in main.ts, yaw ±0.35 / pitch ±0.2) to the camera:
 *  a small eye translation (parallax) plus a partial rotation towards the look direction. */
export const LOOK_TRANSLATE = 0.13;   // world units per radian (plane at distance 1)
export const LOOK_ROTATE = 0.15;      // fraction of the look angle applied as rotation (photo)
export const PANO_LOOK_ROTATE = 1.0;  // a panorama is looked around in for real
export const PANO_TRANSLATE = 0.05;

export function cameraPose(kind: RoomGeometryKind, yaw: number, pitch: number):
  { x: number; y: number; yaw: number; pitch: number } {
  if (kind === 'sphere') return { x: yaw * PANO_TRANSLATE, y: pitch * PANO_TRANSLATE, yaw: yaw * PANO_LOOK_ROTATE, pitch: pitch * PANO_LOOK_ROTATE };
  return { x: yaw * LOOK_TRANSLATE, y: pitch * LOOK_TRANSLATE, yaw: yaw * LOOK_ROTATE, pitch: pitch * LOOK_ROTATE };
}

export function buildPlaneGeometry(width: number, height: number, segX = 256, segY = 192): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, segX, segY);
  g.translate(0, 0, -PLANE_DISTANCE);
  return g;
}

/** Inward-facing sphere for an equirectangular panorama; uv.x = longitude, uv.y = latitude (three's convention,
 *  mirrored in x so the panorama is not reversed when seen from inside, centre of the image ahead). */
export function buildSphereGeometry(radius = 10, segW = 192, segH = 96): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, segW, segH);
  g.scale(-1, 1, 1);
  g.rotateY(-Math.PI / 2);   // the panorama's centre (u = 0.5) straight ahead (-z)
  return g;
}

// ------------------------------------------------------------------------------------ wallpaper folds

/** Wallpaper groups used for symmetrical texture repetition. `id` is the shader constant (uGroup). Only
 *  reflection (kaleidoscopic) groups: their fold is continuous across every cell edge, so the repeated
 *  texture has no seams inside a repetition block. */
export const WALLPAPER_GROUPS = Object.freeze([
  { name: 'pmm', id: 0, lattice: 'rect' },
  { name: 'p4m', id: 1, lattice: 'square' },
  { name: 'p6m', id: 2, lattice: 'hex' },
] as const);
export type WallpaperName = (typeof WALLPAPER_GROUPS)[number]['name'];

export function wallpaperForSeed(seed: number): (typeof WALLPAPER_GROUPS)[number] {
  const i = Math.abs(Math.floor(Number.isFinite(seed) ? seed : 0)) % WALLPAPER_GROUPS.length;
  return WALLPAPER_GROUPS[i];
}

/** Triangle wave, period 1, range [0, 0.5], mirrors at integers and half-integers. */
export function tri(x: number): number {
  return Math.abs(x - Math.floor(x + 0.5));
}

export type V2 = [number, number];

/** pmm: two perpendicular mirror families. Fundamental domain [0,.5]^2. */
export function foldPmm(x: number, y: number): V2 {
  return [tri(x), tri(y)];
}

/** p4m: pmm plus the diagonal mirror. Fundamental domain 0 <= y <= x <= 0.5. */
export function foldP4m(x: number, y: number): V2 {
  const a = tri(x), b = tri(y);
  return b > a ? [b, a] : [a, b];
}

const SQ3 = Math.sqrt(3);

/** Nearest point of the hexagonal lattice a1 = (1,0), a2 = (1/2, sqrt3/2). */
export function hexCentre(x: number, y: number): V2 {
  // two candidate rectangular sub-lattices; pick the nearer centre
  const ry = SQ3;
  const ax = Math.round(x), ay = Math.round(y / ry) * ry;
  const bx = Math.round(x - 0.5) + 0.5, by = Math.round((y - ry / 2) / ry) * ry + ry / 2;
  const da = (x - ax) ** 2 + (y - ay) ** 2, db = (x - bx) ** 2 + (y - by) ** 2;
  return da <= db ? [ax, ay] : [bx, by];
}

/** p6m: hexagonal cell, dihedral D6 fold about the cell centre (mirrors every 30 degrees).
 *  Returns local coordinates in the fundamental wedge 0 <= angle <= 30 degrees. */
export function foldP6m(x: number, y: number): V2 {
  const [cx, cy] = hexCentre(x, y);
  const lx = x - cx, ly = y - cy;
  const r = Math.hypot(lx, ly);
  let th = Math.atan2(ly, lx);
  const w = Math.PI / 3;
  th = th - w * Math.floor(th / w);
  if (th > w / 2) th = w - th;
  return [r * Math.cos(th), r * Math.sin(th)];
}

export function foldWallpaper(id: number, x: number, y: number): V2 {
  switch (id) {
    case 1: return foldP4m(x, y);
    case 2: return foldP6m(x, y);
    default: return foldPmm(x, y);
  }
}

// ------------------------------------------------------------------------------------ effect amounts

/** Temporal frequencies (Hz) of every periodic or quasi-periodic modulation the room layer applies.
 *  BUILD.md 4.1 allows 2 Hz; the room stays at or below 0.5 Hz at source. */
export const ROOM_FREQS = Object.freeze({
  breathNoise: 0.07,      // speed of the 3-D breathing noise along its time axis (cycles/s)
  driftField: 0.02,       // evolution of the curl-noise flow field
  tileCrawl: 0.04,        // lattice crawl, in cells per second
  hueWander: 0.03,        // hue rotation wander
  phosphene: 0.05,        // eyes-closed field evolution when no neural field is present
  challengeBoost: 1.6,    // multiplier during a difficult passage (all of the above stay <= 0.5 Hz)
});

/** Drift: advected texture-coordinate offsets relax back to zero with this time constant (s); the flow
 *  speed at full drift is DRIFT_SPEED image heights per second, so offsets stay below ~SPEED x TAU. */
export const DRIFT_TAU_S = 5;
export const DRIFT_SPEED = 0.006;

/** Tracer feedback time constant (s): decays to < 2 % within 0.5 s. */
export const TRACER_TAU_S = 0.08;

export interface RoomFx {
  breathe: number;   // 0–1 breathing displacement
  drift: number;     // 0–1 curl-noise drift of texture coordinates
  warp: number;      // 0–1 texture-space breathing warp
  tile: number;      // 0–1 symmetrical texture repetition (before the field mask)
  tileScale: number; // repetition cell size (uv units of the image height)
  sat: number;       // saturation multiplier (1 = unchanged)
  hue: number;       // max hue rotation (radians)
  tracer: number;    // 0–1 tracer strength when the camera moves
  palette: number;   // 0–1 tint toward the trip palette
  speed: number;     // time-scale of all modulations (≤ ROOM_FREQS.challengeBoost)
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Effect amounts from the visual intensity v (0–10), the room distortion amount (0–1, hysteretic, from
 *  computeLayerWeights) and the difficult-passage level (0–1). Pure; tested. */
export function roomEffects(v: number, distortion: number, challenge = 0): RoomFx {
  const d = clamp01(distortion);
  const c = clamp01(challenge);
  const hi = smoothstep(2, 7, v);
  const fxv = d * (0.45 + 0.55 * hi);
  return {
    breathe: clamp01(d * (0.55 + 0.45 * hi) * (1 + 0.3 * c)),
    drift: clamp01(fxv * (1 + 0.4 * c)),
    warp: clamp01(d * (0.4 + 0.6 * hi)),
    tile: clamp01(d * smoothstep(1.2, 3.8, v)),
    tileScale: (0.12 - 0.045 * hi) * (1 - 0.2 * c),
    sat: 1 + 0.25 * d + 0.7 * hi - 0.35 * c,
    hue: 0.06 * d + 0.4 * hi,
    tracer: d * (0.3 + 0.4 * hi),
    palette: clamp01(0.1 * d + 0.14 * hi),   // vivid by v 3 (docs/VISUAL_DIRECTION.md)
    speed: 1 + (ROOM_FREQS.challengeBoost - 1) * c,
  };
}

/** Effective tracer feedback for one frame: blend factor of the previous output. Zero when the camera
 *  is still; at most exp(-dt/TRACER_TAU_S), so a trail decays within ~0.5 s. */
export function tracerFeedback(lookSpeedRadPerS: number, tracer: number, dtS: number): number {
  if (!(dtS > 0)) return 0;
  const move = smoothstep(0.02, 0.4, Math.abs(lookSpeedRadPerS));
  return clamp01(tracer) * move * Math.exp(-dtS / TRACER_TAU_S);
}

/** Hex colour → linear RGB triple (palette colours are sRGB hex strings). */
export function hexToLinear(hex: string): [number, number, number] {
  const c = new THREE.Color();
  try { c.set(hex); } catch { c.setRGB(1, 0.7, 0.3); }
  return [c.r, c.g, c.b];   // THREE.Color stores linear components with ColorManagement enabled
}

/** The palette colours the room uses for tints and the eyes-closed phosphenes: the three most vivid
 *  (chroma x brightness) colours of the trip palette, skipping near-black background colours. */
export function vividColours(hexes: readonly string[] | null | undefined, n = 3): [number, number, number][] {
  const cols = (hexes ?? []).map(hexToLinear);
  const score = (c: [number, number, number]) => {
    const mx = Math.max(...c), mn = Math.min(...c);
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum < 0.01 ? -1 : (mx - mn + 0.05) * Math.sqrt(mx);
  };
  const ranked = cols.map((c, i) => ({ c, s: score(c), i })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const fallback: [number, number, number][] = [hexToLinear('#ffb000'), hexToLinear('#4fe3ff'), hexToLinear('#ff4fd8')];
  const out = ranked.slice(0, n).map((x) => x.c);
  while (out.length < n) out.push(fallback[out.length % fallback.length]);
  return out;
}
