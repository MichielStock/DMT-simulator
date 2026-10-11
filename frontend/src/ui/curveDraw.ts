// Draw your curve (BUILD.md section 13.2): before seeing any data, the user draws their remembered
// intensity (0–10) from the hit to the session end. Done posts it; then the real visual curve is
// overlaid with peak-time and duration differences. Enter continues.
// window.__hyperspace.drawCurve(points) draws programmatically (tests).

import { api, type LoggedEvent } from '../api';
import { fmtMs, h, onKey, screen } from './dom';

export const CURVE_PROMPT = 'Draw how intense it felt, from the hit until it faded.';
const COLS = 240;

export interface CurveCtx {
  sessionId: string | null;
  endMin: number;               // session length in model minutes (hit → session end)
  events: LoggedEvent[];        // in-memory event log (for the real curve)
  post?: boolean;
}

export function realCurve(events: LoggedEvent[]): [number, number][] {
  return events.filter((e) => e.type === 'intensity_sample')
    .map((e) => [e.t_min, Number((e.payload as { visual?: number }).visual ?? 0)] as [number, number]);
}

export function curveSummary(pts: [number, number][]): { peakT: number; peak: number; above1: number } {
  let peak = -1, peakT = 0, above1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const [t, v] = pts[i];
    if (v > peak) { peak = v; peakT = t; }
    if (i > 0 && v > 1) above1 += t - pts[i - 1][0];
  }
  return { peakT, peak: Math.max(0, peak), above1 };
}

function signed(minutes: number): string {
  return (minutes < 0 ? '−' : '+') + fmtMs(Math.abs(minutes));
}

const PADL_CSS = 44, PADR_CSS = 8;   // plot padding in CSS px (room for the y labels on the left)

export function mountCurve(root: HTMLElement, ctx: CurveCtx): Promise<[number, number][]> {
  const el = screen(root, 'curve');
  const endMin = Math.max(0.5, ctx.endMin);
  const cols: (number | null)[] = new Array(COLS).fill(null);
  const cssW = Math.min(window.innerWidth * 0.7, 1400);
  const cssH = Math.min(window.innerHeight * 0.45, 600);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h('canvas', { 'data-testid': 'curve-canvas', width: Math.round(cssW * dpr), height: Math.round(cssH * dpr),
    style: `width:${cssW}px;height:${cssH}px` }) as HTMLCanvasElement;
  const done = h('button', { class: 'key', 'data-testid': 'curve-done' }, '[ENTER] Done');
  const clear = h('button', { class: 'key' }, '[C] CLEAR');
  const result = h('div', { class: 'term', 'data-testid': 'curve-result' });
  el.appendChild(h('div', {},
    h('h1', {}, CURVE_PROMPT.toUpperCase()),
    h('div', { class: 'curve-wrap' }, canvas),
    // time axis under the plot: 0:00 at the plot's left edge, the end time at its right edge (NOTES D-F12)
    h('div', { class: 'term dim curve-axis', style: `width:${cssW}px;padding-left:${PADL_CSS}px;padding-right:${PADR_CSS}px` },
      h('span', {}, '0:00'), h('span', {}, 'TIME SINCE THE HIT'), h('span', {}, fmtMs(endMin))),
    h('div', { class: 'gap' }),
    h('div', {}, done, clear),
    h('div', { class: 'gap' }),
    result,
  ));

  const g = canvas.getContext('2d')!;
  const PADL = PADL_CSS * dpr, PADB = 10 * dpr, PADT = 14 * dpr, PADR = PADR_CSS * dpr;
  const W = canvas.width, H = canvas.height;
  const xOf = (t: number) => PADL + (t / endMin) * (W - PADL - PADR);
  const yOf = (v: number) => H - PADB - (v / 10) * (H - PADB - PADT);
  const colT = (c: number) => (c / (COLS - 1)) * endMin;
  let real: [number, number][] | null = null;

  const points = (): [number, number][] => {
    const out: [number, number][] = [];
    cols.forEach((v, c) => { if (v !== null) out.push([Math.round(colT(c) * 1000) / 1000, Math.round(v * 100) / 100]); });
    return out;
  };

  const draw = () => {
    g.clearRect(0, 0, W, H);
    g.font = `${26 * dpr}px VT323, monospace`;
    g.fillStyle = '#7a5400';
    g.strokeStyle = 'rgba(122,84,0,0.5)';
    g.lineWidth = 1;
    for (const v of [0, 2, 4, 6, 8, 10]) {
      g.fillText(String(v), 8 * dpr, yOf(v) + 7 * dpr);
      g.beginPath(); g.moveTo(PADL, yOf(v)); g.lineTo(W - PADR, yOf(v)); g.stroke();
    }
    if (real) {
      g.strokeStyle = '#ffb000';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      real.forEach(([t, v], i) => (i ? g.lineTo(xOf(t), yOf(v)) : g.moveTo(xOf(t), yOf(v))));
      g.stroke();
    }
    g.strokeStyle = '#4fe3ff';
    g.lineWidth = 2.5 * dpr;
    g.beginPath();
    let pen = false;
    cols.forEach((v, c) => {
      if (v === null) { pen = false; return; }
      const X = xOf(colT(c)), Y = yOf(v);
      if (pen) g.lineTo(X, Y); else g.moveTo(X, Y);
      pen = true;
    });
    g.stroke();
  };
  draw();

  // ---- drawing ----
  let last: { c: number; v: number } | null = null;
  const toCV = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const t = Math.max(0, Math.min(endMin, ((x - PADL) / (W - PADL - PADR)) * endMin));
    const v = Math.max(0, Math.min(10, ((H - PADB - y) / (H - PADB - PADT)) * 10));
    return { c: Math.round((t / endMin) * (COLS - 1)), v };
  };
  const paint = (p: { c: number; v: number }) => {
    if (last) {
      const [a, b] = last.c <= p.c ? [last, p] : [p, last];
      for (let c = a.c; c <= b.c; c++) cols[c] = b.c === a.c ? p.v : a.v + ((c - a.c) / (b.c - a.c)) * (b.v - a.v);
    } else cols[p.c] = p.v;
    last = p;
    draw();
  };
  let drawing = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (real) return;
    drawing = true; last = null; canvas.setPointerCapture(e.pointerId); paint(toCV(e));
  });
  canvas.addEventListener('pointermove', (e) => { if (drawing) paint(toCV(e)); });
  const stop = () => { drawing = false; last = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  const setPoints = (pts: [number, number][]) => {
    cols.fill(null);
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    last = null;
    for (const [t, v] of sorted) {
      paint({ c: Math.round((Math.max(0, Math.min(endMin, t)) / endMin) * (COLS - 1)), v: Math.max(0, Math.min(10, v)) });
    }
    last = null;
  };
  const w = window as any;
  w.__hyperspace = w.__hyperspace ?? {};
  w.__hyperspace.drawCurve = (pts: [number, number][]) => setPoints(pts);

  return new Promise((resolve) => {
    let phase: 'draw' | 'compare' = 'draw';
    let posted: [number, number][] = [];
    const submit = async () => {
      if (phase !== 'draw') return;
      const pts = points();
      if (pts.length < 2) { result.textContent = 'DRAW A LINE FIRST, LEFT TO RIGHT.'; return; }
      phase = 'compare';
      posted = pts;
      done.textContent = '[ENTER] CONTINUE';
      clear.classList.add('hidden');
      if (ctx.sessionId && ctx.post !== false) {
        try { await api.curve(ctx.sessionId, pts); } catch { /* the report notes a missing curve */ }
      }
      real = realCurve(ctx.events);
      draw();
      const r = curveSummary(real), y = curveSummary(pts);
      result.replaceChildren(
        h('div', {}, h('span', { class: 'amber' }, '━ REAL'), '   ', h('span', { class: 'accent' }, '━ YOU')),
        h('div', {}, `PEAK TIME  REAL ${fmtMs(r.peakT).padStart(5)}  YOU ${fmtMs(y.peakT).padStart(5)}  (${signed(y.peakT - r.peakT)})`),
        h('div', {}, `DURATION   REAL ${fmtMs(r.above1).padStart(5)}  YOU ${fmtMs(y.above1).padStart(5)}  (${signed(y.above1 - r.above1)})`),
      );
    };
    const finish = () => { off(); resolve(posted); };
    done.addEventListener('click', () => (phase === 'draw' ? void submit() : finish()));
    clear.addEventListener('click', () => { if (phase === 'draw') { cols.fill(null); draw(); } });
    const off = onKey((e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (phase === 'draw') void submit(); else finish(); }
      else if ((e.key === 'c' || e.key === 'C') && phase === 'draw') { cols.fill(null); draw(); }
    });
  });
}
