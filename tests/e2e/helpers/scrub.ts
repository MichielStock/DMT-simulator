// Scrub-mode helpers (BUILD.md 5.2 debug scrubber, 16.2 galleries / worst case).
// Scrub mode: /?debug=1&scrub=1&dose=<step>&seed=<int>&v=..&layer=..&challenge=1&entity=1&message=1&eyes=..
// creates a session through the API, skips title/safety/intake/hit and enters the trip with forced values.
// Only erasable TypeScript syntax (also imported by node --experimental-strip-types tools).
import { expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const GALLERY_LAYERS = ['room', 'form_constants', 'chrysanthemum', 'waiting_room', 'breakthrough'] as const;
export type GalleryLayer = typeof GALLERY_LAYERS[number];

export interface ScrubOptions {
  dose?: 'threshold' | 'light' | 'strong' | 'breakthrough';
  seed?: number;
  v?: number;
  layer?: GalleryLayer | null;
  challenge?: boolean;
  entity?: boolean;
  message?: boolean;
  eyes?: number | null;
  sensitivity?: number;
  sweep?: boolean;
  sweepS?: number;
  autofill?: string;
  panel?: boolean;
}

export function scrubUrl(o: ScrubOptions = {}): string {
  const q = new URLSearchParams();
  q.set('debug', '1');
  q.set('scrub', '1');
  q.set('autofill', o.autofill ?? 'neutral');
  q.set('dose', o.dose ?? 'breakthrough');
  if (o.seed !== undefined) q.set('seed', String(o.seed));
  if (o.v !== undefined) q.set('v', String(o.v));
  if (o.layer) q.set('layer', o.layer);
  if (o.challenge) q.set('challenge', '1');
  if (o.entity) q.set('entity', '1');
  if (o.message) q.set('message', '1');
  if (o.eyes !== undefined && o.eyes !== null) q.set('eyes', String(o.eyes));
  if (o.sensitivity !== undefined) q.set('sensitivity', String(o.sensitivity));
  if (o.sweep) q.set('sweep', '1');
  if (o.sweepS !== undefined) q.set('sweepS', String(o.sweepS));
  if (o.panel) q.set('panel', '1');
  return `/?${q.toString()}`;
}

/** Comma-separated env list filtered to the known layers (all layers when unset/empty). */
export function layersFromEnv(name: string): GalleryLayer[] {
  const raw = (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return [...GALLERY_LAYERS];
  const bad = raw.filter((l) => !(GALLERY_LAYERS as readonly string[]).includes(l));
  if (bad.length) throw new Error(`${name}: unknown layer(s) ${bad.join(', ')}`);
  return raw as GalleryLayer[];
}

export interface HsSnapshot {
  screen: string;
  sessionId: string | null;
  ready: boolean;
  wallTime: number;
  visual: number;
  weights: Record<string, number>;
  palette: { name: string; colours: string[] } | null;
  challengeLevel: number;
  challengeActive: boolean;
  entity: number;
  message: boolean;
  eyesClosed: number;
  renderStats: { frameMs: number; renderScale: number; frames: number } | null;
  passes: string[];
}

export async function snapshot(page: Page): Promise<HsSnapshot> {
  return page.evaluate(() => {
    const hs = (window as any).__hyperspace ?? {};
    const st = hs.state ?? null;
    return {
      screen: String(hs.screen ?? ''),
      sessionId: hs.sessionId ?? null,
      ready: !!hs.readyForCapture,
      wallTime: st ? Number(st.wallTime) : 0,
      visual: st ? Number(st.intensity.visual) : 0,
      weights: st ? { ...st.layerWeights } : {},
      palette: st ? st.palette : null,
      challengeLevel: st ? Number(st.challenge.level) : 0,
      challengeActive: st ? !!st.challenge.active : false,
      entity: st && st.entity.present ? Number(st.entity.intensity) : 0,
      message: st ? !!st.message.active : false,
      eyesClosed: st ? Number(st.eyesClosed) : 0,
      renderStats: hs.renderStats ? { ...hs.renderStats } : null,
      passes: hs.pipeline ? [...hs.pipeline.passes] : [],
    };
  });
}

/** Wait until the trip runs and readyForCapture is true, then `settleS` more seconds of WALL time
 *  (state.wallTime) so the neural field settles. Returns the snapshot at that moment. */
export async function waitReady(page: Page, settleS = 2, timeout = 120_000): Promise<HsSnapshot> {
  await expect.poll(async () => (await snapshot(page)).screen, { timeout, intervals: [100, 250, 500] }).toBe('trip');
  await expect.poll(async () => (await snapshot(page)).ready, { timeout: 60_000, intervals: [100, 250] }).toBe(true);
  const t0 = (await snapshot(page)).wallTime;
  await expect.poll(async () => (await snapshot(page)).wallTime - t0, { timeout: settleS * 1000 + 30_000, intervals: [100, 200] })
    .toBeGreaterThanOrEqual(settleS);
  return snapshot(page);
}

/** PNG of the trip canvas exactly as displayed (after the SafetyLimiter; no DOM overlays). */
export async function canvasPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="trip-canvas"]') as HTMLCanvasElement | null;
    return c ? c.toDataURL('image/png') : '';
  });
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('trip canvas not available');
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

export function writeFrame(file: string, png: Buffer, sidecar: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify(sidecar, null, 2));
}
