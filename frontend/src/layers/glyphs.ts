// Procedural glyph alphabet (BUILD.md 11.7 step 5): 20-30 glyphs composed of strokes and arcs from a
// mulberry32 stream seeded by the message's glyph seed. Readable-feeling (a shared stroke style per
// alphabet: a stem, a preferred arc, a dot habit, all on a 3x3 anchor grid) but not decodable: the
// glyphs are never mapped to letters and the message words never appear on screen.
// Also draws the glyph atlas texture used by the breakthrough shader and procedural "glyph beings"
// (three variants) for entities without sprites.

import { deriveSeed, mulberry32, type Rng } from '../rng';

export type Stroke =
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number }
  | { kind: 'dot'; x: number; y: number; r: number };

export interface Glyph { strokes: Stroke[] }

export interface Alphabet {
  seed: number;
  glyphs: Glyph[];
  /** style shared by every glyph of this alphabet (what makes it feel like one script) */
  style: { stem: number; arcBias: number; dotBias: number; slant: number };
}

export const ALPHABET_MIN = 20;
export const ALPHABET_MAX = 30;

/** 3x3 anchor grid in a 0..1 cell, inset so strokes never touch the cell edge. */
const GRID = [0.18, 0.5, 0.82];

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

function glyphKey(g: Glyph): string {
  return g.strokes.map((s) => s.kind === 'line'
    ? `l${s.x0.toFixed(2)},${s.y0.toFixed(2)},${s.x1.toFixed(2)},${s.y1.toFixed(2)}`
    : s.kind === 'arc' ? `a${s.cx.toFixed(2)},${s.cy.toFixed(2)},${s.r.toFixed(2)},${s.a0.toFixed(2)},${s.a1.toFixed(2)}`
      : `d${s.x.toFixed(2)},${s.y.toFixed(2)}`).sort().join('|');
}

function makeGlyph(rng: Rng, style: Alphabet['style']): Glyph {
  const strokes: Stroke[] = [];
  const sl = style.slant;
  const P = (i: number, j: number): [number, number] => [GRID[i] + sl * (0.5 - GRID[j]), GRID[j]];
  // the alphabet's stem: a vertical (or slanted) spine most glyphs share, at a style-fixed column
  if (rng() < 0.75) {
    const c = style.stem;
    const [x0, y0] = P(c, 0);
    const [x1, y1] = P(c, rng() < 0.7 ? 2 : 1);
    strokes.push({ kind: 'line', x0, y0, x1, y1 });
  }
  const n = 1 + Math.floor(rng() * 3);   // 1-3 further strokes
  for (let k = 0; k < n; k++) {
    if (rng() < style.arcBias) {
      const [cx, cy] = P(Math.floor(rng() * 3), Math.floor(rng() * 3));
      const r = pick(rng, [0.16, 0.24, 0.32]);
      const a0 = Math.floor(rng() * 8) * (Math.PI / 4);
      const span = pick(rng, [Math.PI / 2, Math.PI, 1.5 * Math.PI]);
      strokes.push({ kind: 'arc', cx, cy, r, a0, a1: a0 + span });
    } else {
      const i0 = Math.floor(rng() * 3), j0 = Math.floor(rng() * 3);
      let i1 = Math.floor(rng() * 3), j1 = Math.floor(rng() * 3);
      if (i1 === i0 && j1 === j0) { i1 = (i0 + 1) % 3; j1 = (j0 + 2) % 3; }
      const [x0, y0] = P(i0, j0);
      const [x1, y1] = P(i1, j1);
      strokes.push({ kind: 'line', x0, y0, x1, y1 });
    }
  }
  if (rng() < style.dotBias) {
    const [x, y] = P(Math.floor(rng() * 3), Math.floor(rng() * 3));
    strokes.push({ kind: 'dot', x, y, r: 0.07 });
  }
  return { strokes };
}

/** The seeded alphabet: same seed, same glyphs; 20-30 distinct glyphs. */
export function makeAlphabet(glyphSeed: number): Alphabet {
  const rng = mulberry32(deriveSeed(glyphSeed >>> 0, 'glyph-alphabet'));
  const count = ALPHABET_MIN + Math.floor(rng() * (ALPHABET_MAX - ALPHABET_MIN + 1));
  const style = {
    stem: Math.floor(rng() * 3),
    arcBias: 0.3 + 0.4 * rng(),
    dotBias: 0.15 + 0.35 * rng(),
    slant: (rng() - 0.5) * 0.3,
  };
  const glyphs: Glyph[] = [];
  const seen = new Set<string>();
  for (let tries = 0; glyphs.length < count && tries < count * 40; tries++) {
    const g = makeGlyph(rng, style);
    const key = glyphKey(g);
    if (seen.has(key) || g.strokes.length < 2) continue;
    seen.add(key);
    glyphs.push(g);
  }
  return { seed: glyphSeed >>> 0, glyphs, style };
}

/** Atlas layout: ATLAS_COLS x ATLAS_ROWS cells (32 slots; an alphabet has at most 30 glyphs). */
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawGlyph(ctx: Ctx2D, g: Glyph, x: number, y: number, size: number, width: number): void {
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of g.strokes) {
    ctx.beginPath();
    if (s.kind === 'line') {
      ctx.moveTo(x + s.x0 * size, y + s.y0 * size);
      ctx.lineTo(x + s.x1 * size, y + s.y1 * size);
      ctx.stroke();
    } else if (s.kind === 'arc') {
      ctx.arc(x + s.cx * size, y + s.cy * size, s.r * size, s.a0, s.a1);
      ctx.stroke();
    } else {
      ctx.arc(x + s.x * size, y + s.y * size, s.r * size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** White glyph strokes on transparent black, one glyph per cell (row 0 at the top). */
export function glyphAtlasCanvas(a: Alphabet, cell = 128): HTMLCanvasElement {
  const c = makeCanvas(cell * ATLAS_COLS, cell * ATLAS_ROWS);
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  a.glyphs.forEach((g, i) => {
    const cx = (i % ATLAS_COLS) * cell;
    const cy = Math.floor(i / ATLAS_COLS) * cell;
    drawGlyph(ctx, g, cx, cy, cell, cell * 0.075);
  });
  return c;
}

/**
 * A procedural "glyph being" (for entities without sprites): a luminous, robed, n-fold-crowned figure
 * built from the alphabet's strokes. RGBA with straight alpha, transparent background; three variants
 * (0, 1, 2) share the silhouette and differ in the inner glyphs, crown and arms (the shader morphs
 * between them).
 */
export function glyphBeingCanvas(seed: number, variant: number, size = 512, colours: [string, string, string] = ['#7df9ff', '#ff4fd8', '#ffe08a']): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const rng = mulberry32(deriveSeed(seed >>> 0, 'glyph-being'));
  const alpha = makeAlphabet(seed);
  const vr = mulberry32(deriveSeed(seed >>> 0, `glyph-being-${variant}`));
  const S = size;
  const cx = S / 2;
  const folds = 5 + Math.floor(rng() * 4);
  // robe: a tall teardrop of dark glass with glowing outline filaments
  const sway = (variant - 1) * S * 0.03;
  const robePath = () => {
    ctx.beginPath();
    ctx.moveTo(cx, S * 0.26);
    ctx.bezierCurveTo(cx + S * 0.2 + sway, S * 0.34, cx + S * 0.26 + sway, S * 0.7, cx + S * 0.2, S * 0.95);
    ctx.lineTo(cx - S * 0.2, S * 0.95);
    ctx.bezierCurveTo(cx - S * 0.26 + sway, S * 0.7, cx - S * 0.2 + sway, S * 0.34, cx, S * 0.26);
  };
  // robe: a tall teardrop of luminous coloured glass (self-lit, fading to nothing at the hem) with two
  // glowing outline filaments at uneven spacing (no stack of evenly spaced concentric lines: that reads
  // as a periodic pattern to the limiter's guard, which then greys a box around the being)
  const robe = ctx.createLinearGradient(0, S * 0.2, 0, S * 0.95);
  robe.addColorStop(0, colours[1] + 'b0');
  robe.addColorStop(0.55, colours[0] + '80');
  robe.addColorStop(1, colours[0] + '00');
  ctx.fillStyle = robe;
  robePath();
  ctx.fill();
  for (let k = 0; k < 2; k++) {
    ctx.save();
    ctx.translate(cx, S * 0.6);
    ctx.scale(1 - k * 0.3, 1 - k * 0.12);
    ctx.translate(-cx, -S * 0.6);
    ctx.lineWidth = S * (k === 0 ? 0.014 : 0.008);
    ctx.strokeStyle = k === 1 ? colours[2] : colours[0];
    robePath();
    ctx.stroke();
    ctx.restore();
  }
  // head: a bright disc with a dark eye-glyph
  const hr = S * 0.075;
  const head = ctx.createRadialGradient(cx, S * 0.2, 0, cx, S * 0.2, hr * 1.6);
  head.addColorStop(0, colours[2]);
  head.addColorStop(0.35, colours[2]);
  head.addColorStop(1, colours[2] + '00');
  ctx.fillStyle = head;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(cx, S * 0.2, hr * 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // crown / halo: n-fold rays made of glyphs
  ctx.strokeStyle = colours[2];
  ctx.fillStyle = colours[2];
  const rays = folds + variant;
  for (let k = 0; k < rays; k++) {
    const a = -Math.PI / 2 + (k - (rays - 1) / 2) * (Math.PI * (0.7 + 0.15 * variant) / Math.max(1, rays - 1));
    const r = S * (0.15 + 0.02 * variant);
    const g = alpha.glyphs[Math.floor(vr() * alpha.glyphs.length)];
    const gs = S * 0.07;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * r, S * 0.2 + Math.sin(a) * r);
    ctx.rotate(a + Math.PI / 2);
    drawGlyph(ctx, g, -gs / 2, -gs / 2, gs, gs * 0.12);
    ctx.restore();
  }
  // arms: arcs of light, raised more in later variants
  ctx.strokeStyle = colours[0];
  ctx.lineWidth = S * 0.018;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    const lift = 0.1 + 0.08 * variant;
    ctx.moveTo(cx + side * S * 0.08, S * 0.36);
    ctx.quadraticCurveTo(cx + side * S * 0.3, S * (0.42 - lift), cx + side * S * 0.4, S * (0.3 - lift));
    ctx.stroke();
  }
  // inner glyph column on the robe
  ctx.strokeStyle = colours[2];
  ctx.fillStyle = colours[2];
  for (let k = 0; k < 4; k++) {
    const g = alpha.glyphs[Math.floor(vr() * alpha.glyphs.length)];
    const gs = S * (0.09 - k * 0.008);
    drawGlyph(ctx, g, cx - gs / 2, S * (0.36 + k * 0.12), gs, gs * 0.1);
  }
  return c;
}
