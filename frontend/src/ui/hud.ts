// Heads-up display (BUILD.md section 7.6): plasma level and the three channel intensities on a
// small canvas, model units "relative to half-effect level", 0–10 axis, never real units.
// Toggle with I; off by default during the trip.

import { h } from './dom';

interface Sample { t: number; plasma: number; body: number; visual: number; auditory: number }

const COLORS = { plasma: '#7a5400', body: '#ffb000', visual: '#4fe3ff', auditory: '#ff9cb3' };

export class Hud {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private samples: Sample[] = [];
  visible = false;

  constructor(parent: HTMLElement) {
    this.canvas = h('canvas', { width: 360, height: 150, 'data-testid': 'hud-canvas' }) as HTMLCanvasElement;
    const legend = h('div', { class: 'legend' },
      ...(['plasma', 'body', 'visual', 'auditory'] as const).map((k) => h('span', { style: `color:${COLORS[k]}` }, k.toUpperCase())));
    this.el = h('div', { class: 'hud hidden', 'data-testid': 'hud' },
      h('div', {}, 'RELATIVE TO HALF-EFFECT LEVEL'), this.canvas, legend);
    parent.appendChild(this.el);
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    if (this.visible) this.draw();
    return this.visible;
  }

  push(s: Sample): void {
    this.samples.push(s);
    if (this.visible) this.draw();
  }

  draw(): void {
    const c = this.canvas;
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width, H = c.height;
    const L = 26, B = 16, T = 6, R = 6;
    g.clearRect(0, 0, W, H);
    g.font = '14px VT323, monospace';
    g.strokeStyle = '#7a5400';
    g.fillStyle = '#7a5400';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(L, T); g.lineTo(L, H - B); g.lineTo(W - R, H - B);
    g.stroke();
    for (const v of [0, 5, 10]) {
      const y = H - B - (v / 10) * (H - B - T);
      g.fillText(String(v), 4, y + 4);
      g.beginPath(); g.moveTo(L - 3, y); g.lineTo(L, y); g.stroke();
    }
    const tMax = Math.max(5, this.samples.length ? this.samples[this.samples.length - 1].t : 0);
    g.fillText('0', L, H - 2);
    g.fillText(`${Math.round(tMax)} MIN`, W - R - 40, H - 2);
    const x = (t: number) => L + (t / tMax) * (W - L - R);
    const y = (v: number) => H - B - (Math.max(0, Math.min(10, v)) / 10) * (H - B - T);
    for (const k of ['plasma', 'body', 'visual', 'auditory'] as const) {
      g.strokeStyle = COLORS[k];
      g.lineWidth = k === 'visual' ? 2 : 1.25;
      g.beginPath();
      this.samples.forEach((s, i) => (i ? g.lineTo(x(s.t), y(s[k])) : g.moveTo(x(s.t), y(s[k]))));
      g.stroke();
    }
  }
}
