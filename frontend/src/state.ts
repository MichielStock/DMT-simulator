// The shared state of BUILD.md section 11.1, updated every frame by main.ts. Every layer and the
// audio read only this object; nothing reads the clock directly.

import type * as THREE from 'three';
import type { TripScript } from './api';
import { mulberry32, type Rng } from './rng';

export interface Weights {
  room: number;
  formConstants: number;
  chrysanthemum: number;
  waitingRoom: number;
  breakthrough: number;
  /** room distortion amount 0–1 after its fade (computeLayerWeights, drawn value; set by main.ts) */
  roomDistortion?: number;
  /** neural-field modulation of the room 0–1 after its fade (set by main.ts) */
  fieldModulation?: number;
}

export type WeightKey = 'room' | 'formConstants' | 'chrysanthemum' | 'waitingRoom' | 'breakthrough';


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
  // director additions (M9, CONTRACTS "Amendments (director)"); optional so older readers keep working
  /** sprite variant 0–2 (a/b/c) currently shown */
  variant?: number;
  /** 0–1 crossfade from `variant` to (variant + 1) % 3 ("self-transforming") */
  morph?: number;
  /** 0 = far away in the world, 1 = right in front of the viewer */
  depth?: number;
  /** screen-space placement, x and y in −1..1 (0, 0 = view centre; +y up) */
  position?: [number, number];
}

/** Glyph message (BUILD.md 11.7 item 5). `active`/`t` are the M3 names; the rest are additive. */
export interface MessageState {
  active: boolean;        // on screen
  t: number;              // seconds since shown
  present?: boolean;      // same as active (contract name)
  intensity?: number;     // 0–1 envelope: 2 s in, hold, 2 s out over 12 s
  glyphSeed?: number;     // trip_script.breakthrough.message.glyph_seed (procedural alphabet seed)
  theme?: string | null;  // attention | play | care | curiosity | wonder (never the sealed words)
}

/** Breakthrough sequence phase from the director (additive). */
export interface SequenceState {
  phase: 'none' | 'veil' | 'world' | 'encounter' | 'descent';
  sinceS: number;         // model seconds in this phase
  veil: number;           // 0–1: how far the geometry membrane has lifted (≥ 2 s; falls back in the descent)
}

/** User interaction signals for two-way communication (additive). */
export interface InteractionState {
  keyPulse: number;       // 1 on any key press during the trip, decays linearly to 0 over 1 s (wall time)
  lookVel: number;        // 0–1 smoothed mouse speed (1 ≈ one screen diagonal per second or faster)
}

export interface SharedState {
  t_min: number;
  plasma: number;
  intensity: { body: number; visual: number; auditory: number };
  layerWeights: Weights;
  /** THREE.Texture (256², half float RGBA) set every frame by the neural-field layer; null until it has rendered */
  fieldTexture: THREE.Texture | null;
  pulse: number;
  /** phase 0–1 and frequency (Hz) of the pulse oscillator, for the audio buzz lock (D-A1) */
  pulsePhase?: number;
  pulseHz?: number;
  /** microphone loudness / spectral centroid 0–1 when the microphone option is on and granted */
  mic?: { level: number; centroid: number } | null;
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
  message: MessageState;                      // glyph message on screen, t = seconds shown
  letGo: boolean;                             // space held during the trip
  gentle: boolean;
  wallTime: number;                           // seconds of wall time since the trip started (for shaders)
  breakthroughLatched: boolean;
  forced: { visual: number | null; layer: WeightKey | null };
  assetBase: string | null;                   // "/sessions/<id>/" for room and world images
  /** breakthrough sequence from the director (absent before the first trip frame) */
  sequence?: SequenceState;
  /** key presses and mouse speed during the trip (absent before the first trip frame) */
  interaction?: InteractionState;
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
    entity: { present: false, index: -1, type: null, behaviour: null, beat: 0, since: 0, intensity: 0,
      variant: 0, morph: 0, depth: 0, position: [0, 0] },
    message: { active: false, t: 0, present: false, intensity: 0, glyphSeed: 0, theme: null },
    letGo: false,
    gentle: false,
    wallTime: 0,
    breakthroughLatched: false,
    forced: { visual: null, layer: null },
    assetBase: null,
    sequence: { phase: 'none', sinceS: 0, veil: 0 },
    interaction: { keyPulse: 0, lookVel: 0 },
  };
}
