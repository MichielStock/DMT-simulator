// Past sessions (BUILD.md section 15.2): date, dose step, peak, deepest layer, beings met.
// Enter opens that session's report. Esc returns to the title.

import { api, reportUrl, type SessionSummary } from '../api';
import { h, onKey, pad, screen } from './dom';

export function sessionRow(s: SessionSummary): string {
  const peak = s.peak_visual === null || s.peak_visual === undefined ? '—' : Number(s.peak_visual).toFixed(1);
  return `${pad(s.date || s.id, 17)}${pad((s.dose_step || '').toUpperCase(), 14)}${pad(peak, 6)}${pad((s.deepest_layer || '').toUpperCase().replace(/_/g, ' '), 16)}${(s.beings || 'NONE').toUpperCase()}`;
}

export function mountPastSessions(root: HTMLElement): Promise<void> {
  const el = screen(root, 'past');
  const table = h('div', { class: 'table', 'data-testid': 'past-sessions' });
  const note = h('div', { class: 'note' });
  el.appendChild(h('div', { class: 'wide' },
    h('h1', {}, 'PAST SESSIONS'),
    h('div', { class: 'term dim' }, `${pad('DATE', 17)}${pad('DOSE STEP', 14)}${pad('PEAK', 6)}${pad('DEEPEST LAYER', 16)}BEINGS`),
    h('div', { class: 'term dim' }, '─'.repeat(72)),
    table,
    h('div', { class: 'gap' }),
    note,
    h('div', { class: 'term' }, '[↑][↓] MOVE  [ENTER] OPEN REPORT  [ESC] TITLE'),
  ));
  let list: SessionSummary[] = [];
  let focus = 0;
  const rows: HTMLElement[] = [];
  const render = () => rows.forEach((r, i) => r.classList.toggle('focused', i === focus));
  const open = (i: number) => {
    const s = list[i];
    if (!s) return;
    if (!s.has_report) { note.textContent = 'NO REPORT FOR THAT SESSION.'; return; }
    window.location.assign(reportUrl(s.id));
  };

  api.sessions().then((l) => {
    list = [...l].sort((a, b) => (a.id < b.id ? 1 : -1));
    if (list.length === 0) table.appendChild(h('div', { class: 'term dim' }, 'NO SESSIONS YET.'));
    list.forEach((s, i) => {
      const r = h('div', { class: 'tr', 'data-id': s.id, onclick: () => open(i) }, sessionRow(s));
      r.addEventListener('mouseenter', () => { focus = i; render(); });
      rows.push(r);
      table.appendChild(r);
    });
    render();
  }, () => { table.appendChild(h('div', { class: 'term dim' }, 'THE BACK END IS NOT REACHABLE.')); });

  return new Promise((resolve) => {
    const off = onKey((e) => {
      if (e.key === 'ArrowDown') { focus = Math.min(rows.length - 1, focus + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { focus = Math.max(0, focus - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') open(focus);
      else if (e.key === 'Escape' || e.key === 'Backspace' || e.key.toLowerCase() === 't') { off(); resolve(); }
    });
  });
}
