// Settling (BUILD.md sections 5.1 and 15.4): three progress lines driven by GET /progress every
// 500 ms. Ready only when /progress is ready AND /api/status reports no resident models ("Clearing
// the table" is the last line). Since the start was simplified (NOTES D-S2) this module no longer
// mounts its own screen: prepare.ts shows these lines under the breathing circle of the hit.

import { api, type Progress } from '../api';
import { h, sleep } from './dom';

export const SETTLE_LABELS = ['Preparing your room', 'Imagining the other side', 'Clearing the table'];
export const SETTLE_WIDTH = 34;

export type SettleResult = 'ready' | 'error' | 'cancel';

export interface SettleLines {
  el: HTMLElement;
  detail: HTMLElement;
  draw: (p: Progress | null, residentClear: boolean | null) => void;
}

/** The three progress lines (`PREPARING YOUR ROOM ........ DONE`) and a detail line. */
export function createSettleLines(): SettleLines {
  const lines = SETTLE_LABELS.map(() => h('div', { class: 'term pline' }));
  const detail = h('div', { class: 'note center', 'data-testid': 'settle-detail' });
  const el = h('div', { class: 'plines', 'data-testid': 'settle-lines' }, ...lines);
  const draw = (p: Progress | null, residentClear: boolean | null) => {
    SETTLE_LABELS.forEach((label, i) => {
      const line = p?.lines?.[i];
      let done = !!line?.done;
      if (i === 2) done = done && residentClear === true;
      const text = label.toUpperCase();
      const status = done ? 'DONE' : '····';
      lines[i].replaceChildren(`${text} ${'.'.repeat(Math.max(2, SETTLE_WIDTH - text.length))} `,
        h('span', { class: done ? 'accent' : 'dim' }, status));
      lines[i].classList.toggle('dim', !done);
      lines[i].setAttribute('data-done', String(done));
    });
    const d = p?.lines?.find((l) => !l.done)?.detail;
    detail.textContent = p?.error ? `ERROR: ${p.error}` : d ? d : '';
    detail.classList.toggle('err', !!p?.error);
  };
  draw(null, null);
  return { el, detail, draw };
}

/** Poll until the session is ready (and no model is resident) or failed. `stopped()` cancels. */
export async function waitUntilReady(sessionId: string | null, view: SettleLines, stopped: () => boolean,
  pollMs = 500): Promise<SettleResult> {
  if (!sessionId) {
    // offline dev mode: nothing to wait for
    view.draw({ stage: 'ready', ready: true, error: null, lines: SETTLE_LABELS.map((l) => ({ label: l, done: true })) }, true);
    await sleep(600);
    return stopped() ? 'cancel' : 'ready';
  }
  let failures = 0;
  while (!stopped()) {
    let p: Progress | null = null;
    let clear: boolean | null = null;
    try {
      p = await api.progress(sessionId);
      if (p.ready) {
        const st = await api.status();
        clear = (st.resident_models ?? []).length === 0;
      }
      failures = 0;
    } catch {
      failures++;
      view.detail.textContent = failures > 4 ? 'WAITING FOR THE BACK END…' : '';
      view.detail.classList.toggle('err', failures > 4);
    }
    if (stopped()) return 'cancel';
    if (p) view.draw(p, clear);
    if (p?.stage === 'error' && !p.ready) {
      view.detail.textContent = `ERROR: ${p.error ?? 'unknown'}`;
      view.detail.classList.add('err');
      return 'error';
    }
    if (p?.ready && clear) {
      await sleep(300);
      return stopped() ? 'cancel' : 'ready';
    }
    await sleep(pollMs);
  }
  return 'cancel';
}
