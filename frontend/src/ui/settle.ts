// Settling screen (BUILD.md sections 5.1 and 15.4): "Settling in…" with three progress lines driven
// by GET /progress every 500 ms. Proceeds only when ready AND /api/status reports no resident
// models ("Clearing the table" is the last line).

import { api, type Progress } from '../api';
import { h, onKey, screen, sleep } from './dom';

export const SETTLE_LABELS = ['Preparing your room', 'Imagining the other side', 'Clearing the table'];

export type SettleResult = 'ready' | 'error' | 'cancel';

export function mountSettle(root: HTMLElement, sessionId: string | null, pollMs = 500): Promise<SettleResult> {
  const el = screen(root, 'settle');
  const lines = SETTLE_LABELS.map(() => h('div', { class: 'term' }));
  const detail = h('div', { class: 'note', 'data-testid': 'settle-detail' });
  const cursor = h('span', { class: 'cursor' }, '█');
  el.appendChild(h('div', { class: 'col' },
    h('h1', {}, 'SETTLING IN…'),
    ...lines,
    h('div', { class: 'gap' }),
    detail,
    h('div', { class: 'gap' }),
    h('div', { class: 'term' }, cursor),
  ));

  const draw = (p: Progress | null, residentClear: boolean | null) => {
    SETTLE_LABELS.forEach((label, i) => {
      const line = p?.lines?.[i];
      let done = !!line?.done;
      if (i === 2) done = done && residentClear === true;
      const status = done ? 'DONE' : '....';
      const text = label.toUpperCase();
      lines[i].textContent = `${text} ${'.'.repeat(Math.max(2, 40 - text.length))} ${status}`;
      lines[i].classList.toggle('dim', !done);
      lines[i].setAttribute('data-done', String(done));
    });
    const d = p?.lines?.find((l) => !l.done)?.detail;
    detail.textContent = p?.error ? `ERROR: ${p.error}` : d ? d : '';
  };
  draw(null, null);

  return new Promise((resolve) => {
    let stopped = false;
    const off = onKey((e) => {
      if (e.key === 'Escape') { stopped = true; off(); resolve('cancel'); }
    });
    if (!sessionId) {
      // offline dev mode: nothing to wait for
      draw({ stage: 'ready', ready: true, error: null, lines: SETTLE_LABELS.map((l) => ({ label: l, done: true })) }, true);
      void sleep(600).then(() => { if (!stopped) { off(); resolve('ready'); } });
      return;
    }
    let failures = 0;
    const tick = async () => {
      while (!stopped) {
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
          detail.textContent = failures > 4 ? 'WAITING FOR THE BACK END…' : '';
        }
        if (stopped) return;
        if (p) draw(p, clear);
        if (p?.stage === 'error' && !p.ready) {
          detail.textContent = `ERROR: ${p.error ?? 'unknown'} · [ESC] TITLE`;
          stopped = true;
          off();
          resolve('error');
          return;
        }
        if (p?.ready && clear) {
          stopped = true;
          off();
          await sleep(300);
          resolve('ready');
          return;
        }
        await sleep(pollMs);
      }
    };
    void tick();
  });
}
