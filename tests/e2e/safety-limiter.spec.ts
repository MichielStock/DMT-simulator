// PROTECTED (BUILD.md §0.7, §16.2 "Safety"): full-screen 10 Hz black/white, saturated-red 8 Hz and
// 6 Hz phase-reversing high-contrast stripes, rendered through the RenderPipeline + SafetyLimiter in
// real Chrome (GPU), captured at REAL TIME, must pass tools/flashcheck.py.
//
// Base URL: the back end (playwright.config.ts, http://127.0.0.1:8765) or, when set, E2E_BASE_URL
// (e.g. the Vite dev server: E2E_BASE_URL=http://127.0.0.1:5173).
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot, runFlashcheck, startCapture } from './helpers/capture';

const BASE = process.env.E2E_BASE_URL;
const HAS_DISPLAY = !!process.env.DISPLAY;
const CHROME = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;

test.use({
  ...(BASE ? { baseURL: BASE } : {}),
  viewport: { width: 1280, height: 720 },
  headless: !HAS_DISPLAY,
  launchOptions: {
    executablePath: CHROME,
    args: ['--use-gl=angle', `--use-angle=${HAS_DISPLAY ? 'default' : 'swiftshader'}`, '--enable-gpu',
      '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-gpu-vsync'],
  },
});

const SECONDS = 5;
const FPS = 30;

interface LimiterProbe {
  engagedCount: number; lastInfo: { kind: string; tiles: number } | null; frames: number;
  webgl2: boolean; renderer: string; passes: string[]; status: { engaged: boolean };
}

const CASES: Array<{ pattern: string; query: string; mustEngage: boolean; kind?: string }> = [
  { pattern: 'bw10', query: 'pattern=bw10', mustEngage: true, kind: 'general' },
  { pattern: 'red8', query: 'pattern=red8', mustEngage: true, kind: 'red' },
  { pattern: 'stripes', query: 'pattern=stripes', mustEngage: false },
  { pattern: 'bw10-debug', query: 'pattern=bw10&debug=1', mustEngage: true, kind: 'general' },
];

for (const c of CASES) {
  test(`SafetyLimiter: ${c.pattern} captured at real time passes flashcheck`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const dir = path.join(repoRoot(), 'verification', 'captures', `safety-${c.pattern}`);
    const url = new URL(`/safety-test.html?${c.query}`, baseURL).toString();
    // Start from a black page and begin recording BEFORE navigation, so the capture includes the very
    // first (not yet limited) frames of the pattern.
    await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
    const res = await startCapture(page, dir, SECONDS, FPS, { onStart: () => page.goto(url) });
    const info = await page.evaluate(() => {
      const l = (window as any).__limiter;
      return l ? { ...l, status: l.status() } : null;
    }) as LimiterProbe | null;
    expect(info, 'window.__limiter missing').not.toBeNull();
    fs.writeFileSync(path.join(dir, 'limiter.json'), JSON.stringify({ ...info, capture: res }, null, 2));

    expect(info!.webgl2).toBe(true);
    expect(info!.passes.at(-1)).toBe('SafetyLimiter');
    expect(res.achievedFps, `capture achieved ${res.achievedFps} fps`).toBeGreaterThanOrEqual(20);
    expect(info!.frames).toBeGreaterThan(SECONDS * 20);
    if (c.mustEngage) {
      expect(info!.engagedCount).toBeGreaterThan(0);
      expect(info!.lastInfo?.kind).toBe(c.kind);
    }
    const fc = runFlashcheck(dir);
    console.log(fc.stdout.trim());
    expect(fc.report, 'flashcheck produced no report').not.toBeNull();
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(3);
    expect(fc.report.max_red_flashes_per_s).toBeLessThanOrEqual(3);
    expect(fc.report.pattern_frames).toBe(0);
  });
}

test('SafetyLimiter: static control does not engage and passes flashcheck', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const dir = path.join(repoRoot(), 'verification', 'captures', 'safety-static');
  await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
  const url = new URL('/safety-test.html?pattern=static', baseURL).toString();
  await startCapture(page, dir, 3, FPS, { onStart: () => page.goto(url) });
  const engaged = await page.evaluate(() => (window as any).__limiter.engagedCount as number);
  expect(engaged).toBe(0);
  expect(runFlashcheck(dir).ok).toBe(true);
});
