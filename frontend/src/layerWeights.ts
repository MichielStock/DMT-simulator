// Layer weights from visual intensity (BUILD.md §11.2).
//
// computeLayerWeights(v, prev) is a pure function of the current visual intensity and the previous
// result. It returns TARGET weights: smoothstep windows evaluated on a hysteretic intensity `vEff`
// (0.5 hysteresis: thresholds sit 0.5 lower on the way down, with no jumps), plus the raw breakthrough
// latch (set at v >= 8.0, released when v < 6.5). advanceFade(prev, target, dtSec) then moves the
// displayed weights towards the targets in time: breakthrough fades in over >= 2.5 s (section 4.1: at
// least 2 s) and out over 20 s, other layers by at most 1 per 0.3 s, and the waiting room is replaced
// by the breakthrough as it fades in. Call it with wall-clock seconds so the safety minimum holds in
// real time, also under timewarp.

export const LAYER_ORDER = ['none', 'onset', 'form_constants', 'chrysanthemum', 'waiting_room', 'breakthrough'] as const;
export type DeepLayer = (typeof LAYER_ORDER)[number];

/** Deepest layer reached for a peak visual intensity; mirrors backend/pharmacology.py:deepest_layer. */
export function deepestLayer(peakVisual: number): DeepLayer {
  if (peakVisual >= 8.0) return 'breakthrough';
  if (peakVisual >= 7.6) return 'waiting_room';
  if (peakVisual >= 5.2) return 'chrysanthemum';
  if (peakVisual >= 3.0) return 'form_constants';
  if (peakVisual >= 0.5) return 'onset';
  return 'none';
}

/** Index in LAYER_ORDER (for "deepest" comparisons). */
export function layerRank(name: string): number {
  return (LAYER_ORDER as readonly string[]).indexOf(name);
}

export const HYSTERESIS = 0.5;
export const WINDOWS = Object.freeze({
  roomDistortion: [0.5, 2.0] as const, // distortion amount ramps up
  roomReplaced: [6.8, 7.5] as const, // room fully replaced by 7.5
  formConstantsIn: [1.8, 3.0] as const,
  formConstantsOut: [5.5, 7.0] as const, // fades as a layer; the field keeps running as modulation
  chrysanthemumIn: [4.2, 5.2] as const,
  chrysanthemumOut: [7.2, 8.2] as const,
  waitingRoomIn: [6.8, 7.6] as const, // replaced by breakthrough (see advanceFade)
});
export const BREAKTHROUGH_LATCH = 8.0;
export const BREAKTHROUGH_RELEASE = 6.5;
export const BREAKTHROUGH_FADE_IN_S = 2.5;
export const BREAKTHROUGH_FADE_OUT_S = 20;
export const LAYER_MIN_FADE_S = 0.3;

export interface LayerWeights {
  /** Visibility of the (distorted) room; 1 until replaced by the waiting room. */
  room: number;
  formConstants: number;
  chrysanthemum: number;
  waitingRoom: number;
  breakthrough: number;
  /** Room distortion amount 0–1 (0.5 → 2.0), lingering mildly on the way down. */
  roomDistortion: number;
  /** Neural-field modulation strength 0–1 (form-constant entry window without the fade-out). */
  fieldModulation: number;
  /** Hysteretic intensity used for the windows (v ≤ vEff ≤ v + 0.5). */
  vEff: number;
  /** Raw breakthrough latch. */
  breakthroughLatched: boolean;
}

/** Keys that are layer weights (match SharedState.layerWeights), in compositing order. */
export const WEIGHT_KEYS = ['room', 'formConstants', 'chrysanthemum', 'waitingRoom', 'breakthrough'] as const;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const ss = (w: readonly [number, number], x: number) => smoothstep(w[0], w[1], x);

export function computeLayerWeights(v: number, prev?: LayerWeights | null): LayerWeights {
  const x = Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : 0;
  const vEff = prev ? Math.min(x + HYSTERESIS, Math.max(x, prev.vEff)) : x;
  let latched = prev ? prev.breakthroughLatched : false;
  if (x >= BREAKTHROUGH_LATCH) latched = true;
  else if (x < BREAKTHROUGH_RELEASE) latched = false;
  const fieldModulation = ss(WINDOWS.formConstantsIn, vEff);
  return {
    room: 1 - ss(WINDOWS.roomReplaced, vEff),
    formConstants: fieldModulation * (1 - ss(WINDOWS.formConstantsOut, vEff)),
    chrysanthemum: ss(WINDOWS.chrysanthemumIn, vEff) * (1 - ss(WINDOWS.chrysanthemumOut, vEff)),
    waitingRoom: ss(WINDOWS.waitingRoomIn, vEff),
    breakthrough: latched ? 1 : 0,
    roomDistortion: ss(WINDOWS.roomDistortion, vEff),
    fieldModulation,
    vEff,
    breakthroughLatched: latched,
  };
}

function approach(from: number, to: number, maxDelta: number): number {
  if (to > from) return Math.min(to, from + maxDelta);
  return Math.max(to, from - maxDelta);
}

/** Time-based fader from the previously displayed weights towards computeLayerWeights' targets.
 *  dtSec: wall-clock seconds since the previous call. */
export function advanceFade(prev: LayerWeights | null | undefined, target: LayerWeights, dtSec: number): LayerWeights {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
  const p = prev ?? { ...target, breakthrough: 0 };
  const btRate = target.breakthrough > p.breakthrough ? 1 / BREAKTHROUGH_FADE_IN_S : 1 / BREAKTHROUGH_FADE_OUT_S;
  const breakthrough = approach(p.breakthrough, target.breakthrough, dt * btRate);
  const step = dt / LAYER_MIN_FADE_S;
  return {
    room: approach(p.room, target.room, step),
    formConstants: approach(p.formConstants, target.formConstants, step),
    chrysanthemum: approach(p.chrysanthemum, target.chrysanthemum, step),
    waitingRoom: approach(p.waitingRoom, target.waitingRoom * (1 - breakthrough), step),
    breakthrough,
    roomDistortion: approach(p.roomDistortion, target.roomDistortion, step),
    fieldModulation: approach(p.fieldModulation, target.fieldModulation, step),
    vEff: target.vEff,
    breakthroughLatched: target.breakthroughLatched,
  };
}

/** Fresh weights for v = 0 (calm room). */
export function initialLayerWeights(): LayerWeights {
  return computeLayerWeights(0, null);
}
