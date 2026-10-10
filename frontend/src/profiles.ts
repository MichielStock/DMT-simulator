// Intake profiles for ?autofill=<profile> (tests only). Statically bundled from tests/e2e/profiles.

import neutral from '../../tests/e2e/profiles/neutral.json';
import gentle from '../../tests/e2e/profiles/gentle.json';
import type { DoseStep } from './api';

export type Intention = 'curiosity' | 'recreation' | 'reflection' | 'spiritual';
export type Expectation = 'jesters' | 'machine_elves' | 'aliens' | 'luminous_feminine' | 'insectoid';

/** intake.json (shared/schemas/intake.schema.json). */
export interface Intake {
  version: 1;
  room: { source: 'photo' | 'panorama' | 'default'; image: string | null; depth: string | null };
  answers: {
    clarity: number;
    set: number;
    absorption: [number, number, number];
    surrender: number;
    intention: Intention;
    expectations: Expectation[];
  };
  dose_step: DoseStep;
  hold_fraction: number;
  options: { difficult_passages: boolean; eyes: 'auto' | 'open' | 'closed'; audio: boolean; microphone: boolean; live_diffusion: boolean };
  seed: number;
}

export const PROFILES: Record<string, Intake> = {
  neutral: neutral as unknown as Intake,
  gentle: gentle as unknown as Intake,
};

export function defaultIntake(seed: number): Intake {
  const base = structuredClone(PROFILES.neutral);
  base.seed = seed;
  return base;
}

/** Load a profile and apply URL overrides (?dose=<step>, ?gentle=1). Unknown profile → null. */
export function loadProfile(name: string, overrides: { dose?: string | null; gentle?: boolean }, seed: number): Intake | null {
  const p = PROFILES[name];
  if (!p) return null;
  const intake = structuredClone(p);
  intake.seed = seed;
  if (overrides.dose && ['threshold', 'light', 'strong', 'breakthrough'].includes(overrides.dose)) {
    intake.dose_step = overrides.dose as DoseStep;
  }
  if (overrides.gentle) intake.options.difficult_passages = false;
  return intake;
}
