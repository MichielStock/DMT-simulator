// The shared state of BUILD.md section 11.1, updated every frame by main.ts. Every layer and the
// audio read only this object; nothing reads the clock directly.

import type { TripScript } from './api';
import { mulberry32, type Rng } from './rng';

export interface Weights {
  room: number;
  formConstants: number;
  chrysanthemum: number;
  waitingRoom: number;
  breakthrough: number;
}

export type WeightKey = keyof Weights;

/** camelCase state keys → snake_case names used in events and trip scripts. */
export const LAYER_NAMES: Record<WeightKey, string> = {
  room: 'room',
  formConstants: 'form_constants',
  chrysanthemum: 'chrysanthemum',
  waitingRoom: 'waiting_room',
  breakthrough: 'breakthrough',
};
export const WEIGHT_KEYS: WeightKey[] = ['room', 'formConstants', 'chrysanthemum', 'waitingRoom', 'breakthrough'];

export interface Palette { name: string; colours: string[] }

export interface EntityState {
  present: boolean;
  index: number;          // which entity of the trip script
  type: string | null;
  behaviour: string | null;
  beat: number;           // behaviour beat counter
  since: number;          // t_min of appearance
  intensity: number;      // 0–1, fades in/out
}

export interface SharedState {
  t_min: number;
  plasma: number;
  intensity: { body: number; visual: number; auditory: number };
  layerWeights: Weights;
  fieldTexture: WebGLTexture | unknown | null;
  pulse: number;
  challenge: { active: boolean; level: number; relief: number };
  eyesClosed: number;
  palette: Palette;
  absorptionGain: number;

  // additions (CONTRACTS.md: seed, tripScript, timewarp, rng)
  seed: number;
  tripScript: TripScript | null;
  timewarp: number;
  rng: Rng;

  // skeleton additions read by layers / audio later
  look: { yaw: number; pitch: number };
  entity: EntityState;
  message: { active: boolean; t: number };   // glyph message on screen, t = seconds shown
  letGo: boolean;                             // space held during the trip
  gentle: boolean;
  wallTime: number;                           // seconds of wall time since the trip started (for shaders)
  breakthroughLatched: boolean;
  forced: { visual: number | null; layer: WeightKey | null };
  assetBase: string | null;                   // "/sessions/<id>/" for room and world images
}

export const DEFAULT_PALETTE: Palette = {
  name: 'amber',
  colours: ['#ffb000', '#4fe3ff', '#ff4fd8', '#7dff6a', '#2a1a00'],
};

export function createState(seed: number, timewarp = 1): SharedState {
  return {
    t_min: 0,
    plasma: 0,
    intensity: { body: 0, visual: 0, auditory: 0 },
    layerWeights: { room: 0, formConstants: 0, chrysanthemum: 0, waitingRoom: 0, breakthrough: 0 },
    fieldTexture: null,
    pulse: 0,
    challenge: { active: false, level: 0, relief: 0 },
    eyesClosed: 0,
    palette: DEFAULT_PALETTE,
    absorptionGain: 1,
    seed,
    tripScript: null,
    timewarp,
    rng: mulberry32(seed),
    look: { yaw: 0, pitch: 0 },
    entity: { present: false, index: -1, type: null, behaviour: null, beat: 0, since: 0, intensity: 0 },
    message: { active: false, t: 0 },
    letGo: false,
    gentle: false,
    wallTime: 0,
    breakthroughLatched: false,
    forced: { visual: null, layer: null },
    assetBase: null,
  };
}
