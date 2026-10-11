// Safety screen (BUILD.md sections 4.3 and 15.4). Copy verbatim; appears immediately (never typed).
// Continue is disabled until the photosensitivity box is ticked; Continue creates the AudioContext.

import { h, onKey, screen } from './dom';

export const SAFETY_TITLE = 'Before you begin';
export const SAFETY_PARAGRAPHS = [
  "This is a simulation of the visuals, sounds and timing that people report from inhaled DMT. It does not reproduce the drug's effects, and its doses do not correspond to real amounts.",
  'Do not continue if you have photosensitive epilepsy or have ever had a seizure triggered by flashing lights or patterns. The simulator limits flashing and high-contrast patterns, but no limiter removes all risk.',
  'Sit somewhere comfortable. If you feel unwell at any point, press Escape and the session will fade back to your room.',
  'If you are feeling very low or anxious today, choose gentle mode, or come back another time.',
];
export const SAFETY_CHECKBOX = "I don't have photosensitive epilepsy or a history of light-triggered seizures.";

export type SafetyResult = 'continue' | 'exit';

function createAudioContext(): void {
  const w = window as any;
  w.__hyperspace = w.__hyperspace ?? {};
  if (w.__hyperspace.audioContext) return;
  try {
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (AC) w.__hyperspace.audioContext = new AC();
  } catch {
    /* audio is optional: a silent session is the fallback (section 0.6) */
  }
}

export function mountSafety(root: HTMLElement): Promise<SafetyResult> {
  const el = screen(root, 'safety');
  const input = h('input', { type: 'checkbox', 'data-testid': 'safety-checkbox', id: 'safety-checkbox' }) as HTMLInputElement;
  const cont = h('button', { class: 'key primary', 'data-testid': 'safety-continue', disabled: true }, '[ENTER] CONTINUE') as HTMLButtonElement;
  const exit = h('button', { class: 'key', 'data-testid': 'safety-exit' }, '[ESC] EXIT') as HTMLButtonElement;

  el.appendChild(
    h('div', { class: 'panel safety-panel' },
      h('h1', { class: 'panel-title' }, ` ${SAFETY_TITLE.toUpperCase()} `),
      ...SAFETY_PARAGRAPHS.map((p) => h('p', {}, p)),
      h('label', { class: 'check', for: 'safety-checkbox', 'data-testid': 'safety-check-line' },
        input, h('span', { class: 'box' }), h('span', { class: 'check-text' }, SAFETY_CHECKBOX), h('span', { class: 'check-key' }, '[SPACE]')),
      h('div', { class: 'actions' }, cont, exit),
    ),
  );

  return new Promise((resolve) => {
    let off = () => {};
    const sync = () => {
      cont.disabled = !input.checked;
      el.classList.toggle('checked', input.checked);
    };
    input.addEventListener('change', sync);
    const doContinue = () => {
      if (!input.checked) return;
      createAudioContext();
      off();
      resolve('continue');
    };
    const doExit = () => { off(); resolve('exit'); };
    cont.addEventListener('click', doContinue);
    exit.addEventListener('click', doExit);
    off = onKey((e) => {
      if (e.key === ' ' && document.activeElement !== input) { input.checked = !input.checked; sync(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) doContinue(); }
      else if (e.key === 'Escape') doExit();
    });
  });
}
