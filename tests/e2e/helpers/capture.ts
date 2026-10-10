// Shared real-time capture helpers for Playwright specs and tools/capture.ts.
// Frames are captured at REAL-TIME pace (never time-warped): CDP Page.startScreencast delivers the
// compositor's frames with timestamps; they are resampled onto a fixed `fps` grid (each output frame is
// the latest source frame at that instant). A page.screenshot loop is the fallback.
// Only erasable TypeScript syntax (runs under `node --experimental-strip-types` too).
import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface CaptureResult {
  dir: string;
  method: 'screencast' | 'screenshot';
  format: 'png' | 'jpeg';
  seconds: number;
  fps: number;
  frames: number;
  sourceFrames: number;
  achievedFps: number;
  maxGapMs: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  format?: 'png' | 'jpeg';
  method?: 'screencast' | 'screenshot';
  /** Screencast warm-up before recording starts (ms, default 300). */
  warmupMs?: number;
  /** Called once recording has started (e.g. navigate, so the capture includes the very first frames). */
  onStart?: () => Promise<unknown> | unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Repository root (the directory containing BUILD.md), found from the cwd upwards. */
export function repoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'BUILD.md'))) return d;
    d = path.dirname(d);
  }
  return process.cwd();
}

function prepareDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^frame_\d+\.(png|jpg)$/.test(f) || f === 'capture.json' || f === 'flashcheck.json') fs.rmSync(path.join(dir, f));
  }
}

interface SrcFrame { t: number; data: Buffer }

async function screencast(page: Page, seconds: number, format: 'png' | 'jpeg', warmupMs: number,
  onStart?: () => Promise<unknown> | unknown): Promise<SrcFrame[]> {
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const frames: SrcFrame[] = [];
  let recording = false;
  cdp.on('Page.screencastFrame', (ev: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    if (recording) {
      const t = ev.metadata.timestamp !== undefined ? ev.metadata.timestamp * 1000 : Date.now();
      frames.push({ t, data: Buffer.from(ev.data, 'base64') });
    }
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format, quality: 95, everyNthFrame: 1, maxWidth: vp.width, maxHeight: vp.height,
  });
  await sleep(warmupMs);
  recording = true;
  const startWall = Date.now();
  const started = Promise.resolve(onStart ? onStart() : undefined);
  await sleep(seconds * 1000);
  await started;
  recording = false;
  await cdp.send('Page.stopScreencast').catch(() => undefined);
  await cdp.detach().catch(() => undefined);
  // Anchor the grid at the capture start (wall clock and CDP timestamps are both epoch ms).
  if (frames.length && Math.abs(frames[0].t - startWall) > 5000) {
    const off = frames[0].t - startWall; for (const f of frames) f.t -= off;
  }
  (frames as SrcFrame[] & { start?: number }).start = startWall;
  return frames;
}

async function screenshotLoop(page: Page, seconds: number, fps: number, format: 'png' | 'jpeg',
  onStart?: () => Promise<unknown> | unknown): Promise<SrcFrame[]> {
  const frames: SrcFrame[] = [];
  const start = Date.now();
  if (onStart) await onStart();
  (frames as SrcFrame[] & { start?: number }).start = start;
  while (Date.now() - start < seconds * 1000) {
    const t = Date.now();
    const data = await page.screenshot({ type: format, quality: format === 'jpeg' ? 95 : undefined });
    frames.push({ t, data });
    const wait = 1000 / fps - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
  return frames;
}

/** Capture `seconds` of `page` at real-time pace into `dir` as frame_000001.png... + capture.json. */
export async function startCapture(page: Page, dir: string, seconds: number, fps: number,
  opts: CaptureOptions = {}): Promise<CaptureResult> {
  prepareDir(dir);
  const format = opts.format ?? 'png';
  let method = opts.method ?? 'screencast';
  let src: SrcFrame[] = [];
  if (method === 'screencast') {
    try { src = await screencast(page, seconds, format, opts.warmupMs ?? 300, opts.onStart); } catch { method = 'screenshot'; }
  }
  if (method === 'screenshot') src = await screenshotLoop(page, seconds, fps, format, opts.onStart);
  if (!src.length) throw new Error('capture produced no frames');
  const start = (src as SrcFrame[] & { start?: number }).start ?? src[0].t;
  src.sort((a, b) => a.t - b.t);

  const ext = format === 'png' ? 'png' : 'jpg';
  const n = Math.round(seconds * fps);
  let j = 0; let written = 0;
  for (let k = 0; k < n; k++) {
    const t = start + (k * 1000) / fps;
    while (j + 1 < src.length && src[j + 1].t <= t) j++;
    fs.writeFileSync(path.join(dir, `frame_${String(k + 1).padStart(6, '0')}.${ext}`), src[j].data);
    written++;
  }
  let maxGap = 0;
  for (let i = 1; i < src.length; i++) maxGap = Math.max(maxGap, src[i].t - src[i - 1].t);
  const inWindow = src.filter((f) => f.t >= start && f.t <= start + seconds * 1000).length;
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  const result: CaptureResult = {
    dir, method, format, seconds, fps, frames: written, sourceFrames: src.length,
    achievedFps: Math.round((inWindow / seconds) * 10) / 10, maxGapMs: Math.round(maxGap),
    width: vp.width, height: vp.height,
  };
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({
    ...result, realtime: true, timewarp: 1, url: page.url(), capturedAt: new Date().toISOString(),
    note: 'fps = output grid rate (flashcheck analyses at this rate); achievedFps = distinct source frames per second',
  }, null, 2));
  return result;
}

export interface FlashcheckResult { ok: boolean; status: number; report: any; stdout: string }

/** Run tools/flashcheck.py on a frame folder (fps from capture.json). */
export function runFlashcheck(dir: string, extraArgs: string[] = []): FlashcheckResult {
  const root = repoRoot();
  const json = path.join(dir, 'flashcheck.json');
  const p = spawnSync('uv', ['run', 'python', 'tools/flashcheck.py', dir, '--json', json, ...extraArgs], {
    cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000,
  });
  let report: any = null;
  try { report = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { /* none */ }
  return { ok: p.status === 0, status: p.status ?? -1, report, stdout: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}
