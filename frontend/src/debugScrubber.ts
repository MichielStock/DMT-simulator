// Debug scrubber (?debug=1, BUILD.md section 5.2): a slider that sets the visual intensity directly
// (body and auditory scale proportionally), buttons to force each layer, an entity, a message and a
// difficult passage. It only writes the shared state / director; it never touches the render
// pipeline or the SafetyLimiter.

import { h } from './ui/dom';
import { WEIGHT_KEYS, LAYER_NAMES, type WeightKey } from './state';

export interface ScrubberDeps {
  setIntensity: (v: number | null) => void;
  forceLayer: (k: WeightKey | null) => void;
  forceEntity: () => void;
  forceMessage: () => void;
  forceChallenge: () => void;
  readout: () => string;
  /** Start/stop the 0 → 10 → 0 sweep (optional). */
  toggleSweep?: () => void;
}

/** snake_case (events, URLs) or camelCase layer name → WeightKey; anything else → null. */
export function parseLayerName(name: string | null | undefined): WeightKey | null {
  if (!name) return null;
  for (const k of WEIGHT_KEYS) if (name === k || name === LAYER_NAMES[k]) return k;
  return null;
}

/** Triangle sweep of the visual intensity: 0 → 10 over the first half of `periodS`, back to 0 over
 *  the second half, repeating. Linear, so every layer window is crossed at a constant slow rate. */
export function sweepValue(tS: number, periodS: number): number {
  const p = Math.max(1e-3, periodS);
  const x = (((tS / p) % 1) + 1) % 1;
  return x < 0.5 ? 20 * x : 20 * (1 - x);
}

/** Visual intensity at which each layer is fully present (used when a layer is forced). */
export const LAYER_FORCE_V: Record<WeightKey, number> = {
  room: 1.5, formConstants: 3.5, chrysanthemum: 6.0, waitingRoom: 7.7, breakthrough: 9.0,
};

export function mountScrubber(parent: HTMLElement, deps: ScrubberDeps): { el: HTMLElement; update: () => void } {
  const val = h('span', { class: 'accent' }, 'MODEL');
  const slider = h('input', { type: 'range', min: 0, max: 10, step: 0.1, value: 0, 'data-testid': 'debug-slider' }) as HTMLInputElement;
  const on = h('input', { type: 'checkbox', 'data-testid': 'debug-override' }) as HTMLInputElement;
  const readout = h('div', { class: 'term dim', 'data-testid': 'debug-readout' });
  const apply = () => {
    if (on.checked) { deps.setIntensity(Number(slider.value)); val.textContent = Number(slider.value).toFixed(1); }
    else { deps.setIntensity(null); val.textContent = 'MODEL'; }
  };
  slider.addEventListener('input', () => { on.checked = true; apply(); });
  on.addEventListener('change', apply);
  // keep keyboard shortcuts of the trip working: the panel never swallows keys
  for (const i of [slider, on]) i.addEventListener('keydown', (e) => (e.target as HTMLElement).blur());

  const layerBtns = WEIGHT_KEYS.map((k) => h('button', { class: 'key', 'data-testid': `debug-layer-${LAYER_NAMES[k]}`,
    onclick: () => { deps.forceLayer(k); on.checked = true; slider.value = String(LAYER_FORCE_V[k]); apply(); } }, LAYER_NAMES[k].toUpperCase()));
  const el = h('div', { class: 'debug', 'data-testid': 'debug-scrubber' },
    h('div', {}, 'DEBUG · VISUAL ', val, ' ', h('label', {}, on, ' OVERRIDE')),
    slider,
    h('div', {}, ...layerBtns,
      h('button', { class: 'key', onclick: () => { deps.forceLayer(null); on.checked = false; apply(); } }, 'RELEASE')),
    h('div', {},
      h('button', { class: 'key', 'data-testid': 'debug-entity', onclick: deps.forceEntity }, 'ENTITY'),
      h('button', { class: 'key', 'data-testid': 'debug-message', onclick: deps.forceMessage }, 'MESSAGE'),
      h('button', { class: 'key', 'data-testid': 'debug-challenge', onclick: deps.forceChallenge }, 'CHALLENGE'),
      deps.toggleSweep ? h('button', { class: 'key', 'data-testid': 'debug-sweep', onclick: deps.toggleSweep }, 'SWEEP') : null),
    readout,
  );
  parent.appendChild(el);
  return { el, update: () => { readout.textContent = deps.readout(); } };
}
