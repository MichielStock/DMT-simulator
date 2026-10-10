// End screen (BUILD.md section 15.3): stats box printed line by line from GET /stats, sparklines
// (REAL amber, YOU cyan), ENDED EARLY line, menu, SAVED TO line. No per-line click sound: the
// optional click would need an onset faster than the 200 ms audio rule of section 4.2 (decision
// recorded in NOTES.md), so the end screen is silent.

import { api, type Stats } from '../api';
import { h, onKey, screen, sleep } from './dom';
import { openReport } from './report';
import { renderStats } from './stats';

export type EndAction = 'new' | 'title';

export interface EndCtx {
  sessionId: string;
  instant: boolean;
  replay?: boolean;
}

async function fetchStatsRetry(id: string, tries = 20): Promise<Stats | null> {
  for (let i = 0; i < tries; i++) {
    try { return await api.stats(id); } catch { await sleep(500); }
  }
  return null;
}

export function mountEnd(root: HTMLElement, ctx: EndCtx): Promise<EndAction> {
  const el = screen(root, 'end', 'end');
  el.setAttribute('data-testid', 'end-screen');
  el.setAttribute('data-session-id', ctx.sessionId);
  const wrap = h('div', {});
  el.appendChild(wrap);
  const status = h('div', { class: 'note', 'data-testid': 'end-status' });
  const read = h('button', { class: 'key', 'data-testid': 'read-report' }, '[R] READ REPORT');
  const replay = h('button', { class: 'key', 'data-testid': 'replay' }, '[P] REPLAY');
  const newS = h('button', { class: 'key', 'data-testid': 'new-session' }, '[N] NEW SESSION');
  const title = h('button', { class: 'key', 'data-testid': 'to-title' }, '[T] TITLE');
  const menu = h('div', { class: 'term' }, ' ', read, replay, newS, title);
  const saved = h('div', { class: 'term', 'data-testid': 'saved-to' }, ` SAVED TO sessions/${ctx.sessionId}/`);

  return new Promise((resolve) => {
    let busy = false;
    const doRead = async () => {
      if (busy) return;
      busy = true;
      status.textContent = ' PREPARING THE REPORT…';
      const ok = await openReport(ctx.sessionId, (st) => { status.textContent = ` PREPARING THE REPORT · ${st.toUpperCase()}`; });
      if (!ok) { status.textContent = ' THE REPORT IS NOT AVAILABLE.'; busy = false; }
    };
    const doReplay = () => { window.location.assign(`/?replay=${encodeURIComponent(ctx.sessionId)}`); };
    const finish = (a: EndAction) => { off(); resolve(a); };
    read.addEventListener('click', () => void doRead());
    replay.addEventListener('click', doReplay);
    newS.addEventListener('click', () => finish('new'));
    title.addEventListener('click', () => finish('title'));
    const off = onKey((e) => {
      const k = e.key.toLowerCase();
      if (k === 'r') void doRead();
      else if (k === 'p') doReplay();
      else if (k === 'n') finish('new');
      else if (k === 't') finish('title');
    });

    void (async () => {
      if (ctx.replay) wrap.appendChild(h('div', { class: 'term accent' }, ' REPLAY FINISHED · STATS OF THE ORIGINAL SESSION'));
      const s = await fetchStatsRetry(ctx.sessionId);
      if (!s) {
        wrap.appendChild(h('div', { class: 'term', 'data-testid': 'end-box' }, ' SESSION COMPLETE · SIMULATED\n\n STATS UNAVAILABLE (BACK END NOT REACHABLE)'));
      } else {
        await renderStats(wrap, s, { instant: ctx.instant });
      }
      wrap.appendChild(h('div', { class: 'gap' }));
      wrap.appendChild(menu);
      wrap.appendChild(status);
      wrap.appendChild(h('div', { class: 'gap' }));
      wrap.appendChild(saved);
      el.setAttribute('data-ready', 'true');
    })();
  });
}
