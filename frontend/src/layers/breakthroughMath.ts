// Pure arithmetic of the breakthrough layer (no WebGL): world crossfade schedule, veil timing, frame
// aperture / luminance budget / rotation caps, entity echo counts and behaviour envelopes. Tested in
// frontend/tests/breakthrough.test.ts; the shader (glsl/breakthrough.frag.glsl) uses the values.

import { deriveSeed, mulberry32 } from '../rng';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------------------------------
// World schedule: hold each world 25-45 s (seeded), crossfade to the next over WORLD_XFADE_S (>= 2 s);
// never a cut: at a segment boundary the outgoing crossfade has reached 1 and the next segment starts
// at 0 with the same image.
export const WORLD_HOLD_S: [number, number] = [25, 45];
export const WORLD_XFADE_S = 4;

export interface WorldMix { a: number; b: number; mix: number; segment: number }

/** Segment boundaries (seconds) up to time t. Segment i spans [bounds[i], bounds[i+1]). */
function segmentBounds(seed: number, t: number): number[] {
  const rng = mulberry32(deriveSeed(seed >>> 0, 'breakthrough-worlds'));
  const out = [0];
  while (out[out.length - 1] <= t) {
    out.push(out[out.length - 1] + WORLD_HOLD_S[0] + (WORLD_HOLD_S[1] - WORLD_HOLD_S[0]) * rng());
  }
  return out;
}

export function worldSchedule(tS: number, count: number, seed: number): WorldMix {
  if (count <= 1 || !(tS >= 0)) return { a: 0, b: 0, mix: 0, segment: 0 };
  const bounds = segmentBounds(seed, tS);
  const i = Math.max(0, bounds.length - 2);
  const end = bounds[i + 1];
  const a = i % count;
  const b = (i + 1) % count;
  const x = (tS - (end - WORLD_XFADE_S)) / WORLD_XFADE_S;
  return { a, b, mix: smoothstep(0, 1, x), segment: i };
}

/** Per-pixel crossfade window as a fraction of the global mix range (the shader's flow-warped melt). */
export const WORLD_PIXEL_SPAN = 0.4;
/** Shortest per-pixel transition, seconds (must be >= 0.3 s, BUILD.md 4.1). Smoothstep's steepest slope is 1.5. */
export function worldPixelTransitionS(): number {
  return (WORLD_PIXEL_SPAN * WORLD_XFADE_S) / 1.5;
}

// ---------------------------------------------------------------------------------------------------
// Veil: on latch the frame thins into a membrane and lifts over VEIL_S (>= 2 s).
export const VEIL_S = 3.2;
export function veilProgress(sinceLatchS: number): number {
  return smoothstep(0, VEIL_S, sinceLatchS);
}

// ---------------------------------------------------------------------------------------------------
// Frame: aperture (in screen half-heights) opens with v and the veil, closes on descent and tightens
// under a difficult passage.
/** Cells around the membrane (constant: a count that changed with v or the challenge would re-lay every
 *  cell at once, a full-frame pop). */
export const MEMBRANE_CELLS = 26;
/** Membrane cell fill luminance (linear, palette colour 0): near-black glass. */
export const MEMBRANE_FILL: readonly [number, number] = [0.006, 0.014];
export const APERTURE_MIN = 0.8;
export const APERTURE_MAX = 1.8;   // polygon circumradius in half-heights: the world covers >= 80 % of a 16:9 screen
export function aperture(v: number, veil: number, challenge: number): number {
  const open = smoothstep(4.5, 7.5, v);
  const r = APERTURE_MIN + (APERTURE_MAX - APERTURE_MIN) * open;
  return r * (0.06 + 0.94 * veil) * (1 - 0.3 * clamp01(challenge));
}

/** Broad-structure luminance budget of the frame (linear). Panel fills live in [lMin, lMax]; the
 *  iso-luminant seams sit at SEAM_GAIN·lMax and the jewel studs at STUD_GAIN·lMax, so the whole
 *  periodic frame stays within lMin..FRAME_RATIO_MAX·lMin (2.4 → Michelson 0.41: under the 1:3 cap of
 *  4.1 and under the limiter's 0.45 tile test). Only the single aperture rim line reaches `edge`
 *  (0.6-0.9, a thin non-periodic curve: small area). */
export const FRAME_RATIO_MAX = 2.4;
export const FRAME_FILL_RATIO_MAX = 2.0;
export const SEAM_GAIN = 1.12;
export const STUD_GAIN = 1.2;
export function frameLuminance(v: number, challenge: number): { lMin: number; lMax: number; edge: number; ratio: number; seam: number; stud: number } {
  const vi = smoothstep(4, 9.5, v);
  const lMin = 0.034 + 0.016 * vi;
  const ratio = Math.min(FRAME_FILL_RATIO_MAX, 1.8 + 0.2 * vi);
  const lMax = lMin * ratio;
  const edge = Math.min(0.9, 0.6 + 0.24 * vi + 0.06 * clamp01(challenge));
  return { lMin, lMax, edge, ratio, seam: lMax * SEAM_GAIN, stud: lMax * STUD_GAIN };
}
export function michelson(lMin: number, lMax: number): number {
  return (lMax - lMin) / (lMax + lMin);
}

/** n-fold symmetry of the frame (seeded, 7-12). */
export function frameFold(seed: number): number {
  const rng = mulberry32(deriveSeed(seed >>> 0, 'breakthrough-frame'));
  return 7 + Math.floor(rng() * 6);
}

/** Highest temporal frequency of edges passing a pixel, Hz: calm <= 0.35, difficult <= 1.6 (< 2 Hz). */
export const FRAME_EDGE_HZ_CALM = 0.35;
export const FRAME_EDGE_HZ_CHALLENGE = 1.6;
/** Rotation (revolutions per second) of the fastest frame band for a fold count with `cells` panels per
 *  revolution: the edge-passing frequency cells·rev never exceeds the caps above. */
export function frameRotationRev(cells: number, v: number, challenge: number): number {
  const hz = FRAME_EDGE_HZ_CALM * (0.5 + 0.5 * smoothstep(5, 9, v)) + (FRAME_EDGE_HZ_CHALLENGE - FRAME_EDGE_HZ_CALM) * clamp01(challenge);
  return Math.min(hz, FRAME_EDGE_HZ_CHALLENGE) / Math.max(1, cells);
}

// ---------------------------------------------------------------------------------------------------
// Camera drift (comfort 4.5: slow constant yaw, <= 2 deg/s)
export const DRIFT_YAW_DEG_S = 1.1;

// ---------------------------------------------------------------------------------------------------
// Entities
export function echoCount(seed: number, index = 0): number {
  const rng = mulberry32(deriveSeed((seed >>> 0) + index * 7919, 'breakthrough-echo'));
  return 3 + Math.floor(rng() * 5);   // 3..7
}

/** Behaviour envelopes: scale multiplier, sway amplitude (rad), object presence, sparks, morph speed,
 *  recede (0-1) as a function of the behaviour and the seconds since it began. */
export interface BehaviourLook { scale: number; sway: number; object: number; sparks: number; morphSpeed: number; recede: number }
export function behaviourLook(behaviour: string | null | undefined, sinceS: number): BehaviourLook {
  const k = smoothstep(0, 4, sinceS);
  const base: BehaviourLook = { scale: 1, sway: 0.03, object: 0, sparks: 0, morphSpeed: 1, recede: 0 };
  switch (behaviour) {
    case 'approach': return { ...base, scale: 0.75 + 0.3 * k };
    case 'greet': return { ...base, scale: 1.05, sway: 0.03 + 0.07 * k };
    case 'present_object': return { ...base, scale: 1.05, object: k };
    case 'show': return { ...base, scale: 1.05, object: 0.6 * k, sparks: 0.5 * k };
    case 'work_on': return { ...base, scale: 1.12, sparks: k };
    case 'transform': return { ...base, scale: 1.05, morphSpeed: 1 + 3 * k, sparks: 0.3 * k };
    case 'depart': return { ...base, scale: 1.05 - 0.55 * k, recede: k };
    default: return base;
  }
}

/** Morph cycle when the shared state carries no variant/morph: a slow 0..3 walk through a→b→c→a.
 *  A crossfade lasts 0.4 of a third: 3.2 s at speed 1, 0.8 s at the transform speed-up x4 (>= 0.3 s). */
export const MORPH_PERIOD_S = 24;
export function morphFromPhase(phase: number): { variant: number; morph: number } {
  const x = ((phase % 3) + 3) % 3;
  const variant = Math.floor(x);
  const f = x - variant;
  // hold, then crossfade over the last 40 % of each third
  return { variant, morph: smoothstep(0.6, 1, f) };
}

// ---------------------------------------------------------------------------------------------------
// Message rings
export function ringCount(glyphSeed: number): number {
  const rng = mulberry32(deriveSeed(glyphSeed >>> 0, 'breakthrough-rings'));
  return 2 + Math.floor(rng() * 3);   // 2..4
}
/** Ring rotation, revolutions per second (<= 0.5 Hz; glyph passing per pixel cells·rev <= 1 Hz). */
export function ringRotationRev(ring: number, cells: number): number {
  const rev = (0.012 + 0.006 * ring) * (ring % 2 === 0 ? 1 : -1);
  const cap = 1.0 / Math.max(1, cells);
  return Math.sign(rev) * Math.min(Math.abs(rev), cap, 0.5);
}

/** Message envelope from the legacy {active, t} state: fade in 1.5 s, out over the last 1.5 s of 12 s. */
export function messageEnvelope(active: boolean, tS: number, showS = 12): number {
  if (!active) return 0;
  return smoothstep(0, 1.5, tS) * (1 - smoothstep(showS - 1.5, showS, tS));
}

/** First-order follower with separate rise/fall time constants (seconds). */
export function follow(x: number, target: number, dt: number, riseS: number, fallS: number): number {
  const tau = target > x ? riseS : fallS;
  return x + (target - x) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
}
