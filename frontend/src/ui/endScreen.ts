// End screen (BUILD.md section 15.3): stats box printed line by line from GET /stats, sparklines
// (REAL amber, YOU cyan), ENDED EARLY line, "<n> SNAPSHOTS SAVED" (GET /frames), menu
// ([R] read, [D] download the report zip, [P] replay, [N] new, [T] title), SAVED TO line. No per-line click sound: the
// optional click would need an onset faster than the 200 ms audio rule of section 4.2 (decision
// recorded in NOTES.md), so the end screen is silent.

import { api, type Stats } from '../api';
import { h, onKey, screen, sleep } from './dom';
import { downloadReport, openReport } from './report';
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
  // the same centred double-frame panel as setup and safety (NOTES D-F8); the two report actions are primary
  const wrap = h('div', { class: 'end-body' });
  el.appendChild(h('div', { class: 'panel end-panel' }, h('h1', { class: 'panel-title' }, 'WELCOME BACK'), wrap));
  const status = h('div', { class: 'note end-status', 'data-testid': 'end-status' });
  const read = h('button', { class: 'key primary', 'data-testid': 'read-report' }, '[R] READ REPORT');
  const download = h('button', { class: 'key primary', 'data-testid': 'download-report' }, '[D] DOWNLOAD');
  const replay = h('button', { class: 'key dim-key', 'data-testid': 'replay' }, '[P] REPLAY');
  const newS = h('button', { class: 'key dim-key', 'data-testid': 'new-session' }, '[N] NEW');
  const title = h('button', { class: 'key dim-key', 'data-testid': 'to-title' }, '[T] TITLE');
  const menu = h('div', { class: 'end-menu' },
    h('div', { class: 'end-actions primary-row' }, read, download),
    h('div', { class: 'end-actions secondary-row' }, replay, newS, title));
  const snaps = h('div', { class: 'term dim end-snaps', 'data-testid': 'snapshot-count' }, ' ');
  const saved = h('div', { class: 'end-saved', 'data-testid': 'saved-to' }, `SAVED TO sessions/${ctx.sessionId}/`);

  return new Promise((resolve) => {
    let busy = false;
    const doRead = async () => {
      if (busy) return;
      busy = true;
      status.textContent = ' PREPARING THE REPORT…';
      const ok = await openReport(ctx.sessionId, (st) => { status.textContent = ` PREPARING THE REPORT · ${st.toUpperCase()}`; });
      if (!ok) { status.textContent = ' THE REPORT IS NOT AVAILABLE.'; busy = false; }
    };
    const doDownload = async () => {
      if (busy) return;
      busy = true;
      status.textContent = ' PREPARING THE REPORT…';
      const ok = await downloadReport(ctx.sessionId, (st) => { status.textContent = ` PREPARING THE REPORT · ${st.toUpperCase()}`; });
      status.textContent = ok ? ' DOWNLOADING · THE ZIP HOLDS THE REPORT, ITS SNAPSHOTS AND FIGURES' : ' THE REPORT IS NOT AVAILABLE.';
      busy = false;
    };
    const doReplay = () => { window.location.assign(`/?replay=${encodeURIComponent(ctx.sessionId)}`); };
    const finish = (a: EndAction) => { off(); resolve(a); };
    read.addEventListener('click', () => void doRead());
    download.addEventListener('click', () => void doDownload());
    replay.addEventListener('click', doReplay);
    newS.addEventListener('click', () => finish('new'));
    title.addEventListener('click', () => finish('title'));
    const off = onKey((e) => {
      const k = e.key.toLowerCase();
      if (k === 'r') void doRead();
      else if (k === 'd') void doDownload();
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
      wrap.appendChild(snaps);
      void api.frames(ctx.sessionId).then((f) => {
        snaps.setAttribute('data-count', String(f.length));
        snaps.textContent = f.length === 0 ? ' NO SNAPSHOTS SAVED' : '';
        if (f.length) snaps.append(h('span', { class: 'accent' }, String(f.length)), f.length === 1 ? ' SNAPSHOT SAVED' : ' SNAPSHOTS SAVED');
      }, () => { snaps.setAttribute('data-count', '0'); });
      wrap.appendChild(menu);
      wrap.appendChild(status);
      wrap.appendChild(saved);
      el.setAttribute('data-ready', 'true');
    })();
  });
}
