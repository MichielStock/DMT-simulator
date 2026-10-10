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
      h('button', { class: 'key', 'data-testid': 'debug-challenge', onclick: deps.forceChallenge }, 'CHALLENGE')),
    readout,
  );
  parent.appendChild(el);
  return { el, update: () => { readout.textContent = deps.readout(); } };
}
