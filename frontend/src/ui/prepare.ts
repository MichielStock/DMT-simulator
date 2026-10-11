// Prepare = settle + hit on one screen (NOTES D-S2). A breathing circle in the centre with the three
// progress lines underneath. While the session is prepared (GET /progress ready AND /api/status with
// no resident models, settle.ts): "SETTLING IN… BREATHE." and a slow breath (12 s cycle, 0.083 Hz).
// Once ready the circle brightens, the copy becomes "HOLD SPACE TO INHALE" and the hold logic of
// hit.ts applies unchanged (hold_fraction = min(1, held / 4)). Space before ready only shows a gentle
// "almost…" cue. Escape returns to the title (the caller); an error is reported to the caller.

import { h, onKey, screen } from './dom';
import { bindHit, HOLD_MAX_S, type HitResult } from './hit';
import { createSettleLines, waitUntilReady } from './settle';

export const PREPARE_COPY = {
  settling: 'SETTLING IN… BREATHE.',
  ready: 'HOLD SPACE TO INHALE',
  holding: 'HOLD…',
  almost: 'ALMOST… KEEP BREATHING',
};

export type PrepareResult = HitResult | 'cancel' | 'error';

export interface PrepareHooks {
  /** called once when the session is ready and the hit is armed (main: setScreen('hit')) */
  onReady?: () => void;
  pollMs?: number;
}

export function mountPrepare(root: HTMLElement, sessionId: string | null, hooks: PrepareHooks = {}): Promise<PrepareResult> {
  const el = screen(root, 'prepare');
  el.setAttribute('data-testid', 'prepare-screen');
  const circle = h('div', { class: 'breath slow', 'data-testid': 'breath' }, h('div', { class: 'breath-core' }));
  const copy = h('div', { class: 'prep-copy', 'data-testid': 'hit-text' }, PREPARE_COPY.settling);
  const cue = h('div', { class: 'prep-cue', 'data-testid': 'hit-cue' });
  const btn = h('button', { class: 'key hit-key', 'data-testid': 'hit-button', 'aria-disabled': 'true' }, '[SPACE]  INHALE');
  const lines = createSettleLines();
  const wrap = h('div', { class: 'prepare' },
    h('div', { class: 'breath-stage' }, circle),
    copy, cue, btn,
    h('div', { class: 'gap' }),
    lines.el, lines.detail,
    h('div', { class: 'prep-foot dim' }, '[ESC] TITLE'),
  );
  el.appendChild(wrap);

  let armed = false;
  let stopped = false;
  let cueTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve) => {
    const done = (r: PrepareResult) => {
      if (stopped) return;
      stopped = true;
      if (cueTimer) clearTimeout(cueTimer);
      offEsc();
      resolve(r);
    };
    const offEsc = onKey((e) => { if (e.key === 'Escape') done('cancel'); });

    void bindHit(btn, {
      armed: () => armed,
      onEarly: () => {
        cue.textContent = PREPARE_COPY.almost;
        cue.classList.add('on');
        if (cueTimer) clearTimeout(cueTimer);
        cueTimer = setTimeout(() => cue.classList.remove('on'), 1600);
      },
      onBegin: () => {
        copy.textContent = PREPARE_COPY.holding;
        circle.style.animationDuration = `${HOLD_MAX_S}s`;
        circle.classList.add('inhale');
        wrap.classList.add('is-holding');
      },
    }).then((r) => done(r));

    void waitUntilReady(sessionId, lines, () => stopped, hooks.pollMs).then((r) => {
      if (stopped) return;
      if (r === 'error') { done('error'); return; }
      if (r !== 'ready') return;
      armed = true;
      circle.classList.remove('slow');
      circle.classList.add('ready');
      wrap.classList.add('is-ready');
      btn.setAttribute('aria-disabled', 'false');
      copy.textContent = PREPARE_COPY.ready;
      cue.classList.remove('on');
      hooks.onReady?.();
    });
  });
}
