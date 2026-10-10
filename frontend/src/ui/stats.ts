// Renders the stats box and sparklines (BUILD.md section 15.3) from GET /api/session/{id}/stats.
// No computation here: the box lines and sparklines come from the back end's compute_stats, so the
// end screen, the report and the tests print the identical thing.

import { api, type Stats } from '../api';
import { fmtMs, h } from './dom';
import { typeLines } from './typewriter';

export function fetchStats(id: string): Promise<Stats> {
  return api.stats(id);
}

export interface StatsLine { text: string; cls?: string; parts?: { text: string; cls?: string }[] }

/** The lines printed below the box (ENDED EARLY, axis, REAL and YOU sparklines). */
export function statsTailLines(s: Stats): StatsLine[] {
  const out: StatsLine[] = [];
  if (s.ended_early_at) out.push({ text: ` ENDED EARLY AT ${s.ended_early_at}`, cls: 'ended-early' });
  out.push({ text: '' });
  out.push({ text: ` INTENSITY  0:00 ${'─'.repeat(22)} ${fmtMs(s.session_minutes ?? 0)}`, cls: 'dim' });
  out.push({ text: '', parts: [{ text: ' REAL  ' }, { text: s.sparkline_real ?? '', cls: 'spark-real' }] });
  out.push({ text: '', parts: [{ text: ' YOU   ' }, s.sparkline_you
    ? { text: s.sparkline_you, cls: 'spark-you' } : { text: 'NO CURVE DRAWN', cls: 'dim' }] });
  return out;
}

function lineEl(l: StatsLine): HTMLElement {
  const el = h('div', { class: `term ${l.cls ?? ''}`.trim() });
  if (l.parts) for (const p of l.parts) el.appendChild(h('span', { class: p.cls ?? '' }, p.text));
  else el.textContent = l.text || ' ';
  return el;
}

/**
 * Print the box line by line (~80 ms per line; instant when asked) into `parent`.
 * Returns the box element (data-testid end-box).
 */
export async function renderStats(parent: HTMLElement, s: Stats, opts: { instant?: boolean; msPerLine?: number; onLine?: () => void } = {}): Promise<HTMLElement> {
  const box = h('div', { 'data-testid': 'end-box', class: 'stats-box' });
  const tail = h('div', { class: 'stats-tail' });
  parent.appendChild(box);
  parent.appendChild(tail);
  const ms = opts.msPerLine ?? 80;
  await typeLines(box, s.box ?? [], (line) => lineEl({ text: line }), { msPerLine: ms, instant: opts.instant, onLine: opts.onLine });
  await typeLines(tail, statsTailLines(s).map((_, i) => String(i)), (i) => lineEl(statsTailLines(s)[Number(i)]),
    { msPerLine: ms, instant: opts.instant, onLine: opts.onLine });
  return box;
}
