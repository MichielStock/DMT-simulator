// PROTECTED (BUILD.md §0.7, §4.1, §16.2 "Safety" → "Worst case"): maximum dose step, maximum
// sensitivity, difficult passage forced (plus an entity and the glyph message), each layer forced through
// the debug scrubber at visual intensity 9 and captured for 60 seconds at REAL time (never time-warped)
// in real Chrome with the GPU; tools/flashcheck.py must report zero violations. One more run sweeps the
// scrubber linearly 0 → 10 → 0 over the capture (sweep=1), crossing every layer transition.
// Do not loosen, shorten or skip these assertions; the defaults are the protected configuration.
//
//   Environment:     WORSTCASE_LAYERS=room,chrysanthemum   limit the layers (the sweep always runs unless
//                                                          WORSTCASE_SWEEP=0)
//                    WORSTCASE_SECONDS=20                  quick agent checks (protected default: 60)
//                    E2E_BASE_URL=http://127.0.0.1:5174    run against a Vite dev server
// Captures: verification/captures/worstcase-<layer>/ and worstcase-sweep/ (frames, capture.json,
// flashcheck.json, worstcase.json).
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot, runFlashcheck, startCapture } from './helpers/capture';
import { layersFromEnv, scrubUrl, snapshot, type ScrubOptions } from './helpers/scrub';

const BASE = process.env.E2E_BASE_URL;
const HAS_DISPLAY = !!process.env.DISPLAY;
const CHROME = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;

test.use({
  ...(BASE ? { baseURL: BASE } : {}),
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  headless: !HAS_DISPLAY,
  launchOptions: {
    executablePath: CHROME,
    args: ['--use-gl=angle', `--use-angle=${HAS_DISPLAY ? 'default' : 'swiftshader'}`, '--enable-gpu',
      '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required'],
  },
});

const SECONDS = Math.max(5, Number(process.env.WORSTCASE_SECONDS ?? '60') || 60);
const FPS = 30;
const SEED = Number(process.env.WORSTCASE_SEED ?? '11') || 11;
const SETUP_S = 3;
const MAX_ATTEMPTS = 3; // scrub setup (session + planning) is recorded too, before the trip starts
const LAYERS = layersFromEnv('WORSTCASE_LAYERS');
const WORST: ScrubOptions = { dose: 'breakthrough', seed: SEED, sensitivity: 2.0, challenge: true, entity: true, message: true };

interface Case { name: string; opts: ScrubOptions; seconds: number }
const CASES: Case[] = [
  ...LAYERS.map((layer) => ({ name: layer, opts: { ...WORST, layer, v: 9 }, seconds: SECONDS + SETUP_S })),
  ...(process.env.WORSTCASE_SWEEP === '0' ? [] : [{ name: 'sweep', opts: { ...WORST, sweep: true, sweepS: SECONDS }, seconds: SECONDS + SETUP_S + 1 }]),
];


for (const c of CASES) {
  test(`worst case: ${c.name} at real time passes flashcheck`, async ({ page, baseURL }) => {
    test.setTimeout((c.seconds + 240) * 1000 * MAX_ATTEMPTS);
    const dir = path.join(repoRoot(), 'verification', 'captures', `worstcase-${c.name}`);
    const url = new URL(scrubUrl(c.opts), baseURL).toString();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    // A capture is only valid if the page loaded exactly once: on a Vite dev server, a source file edited
    // during the capture reloads the page (HMR) and restarts the trip. Such a capture is discarded and
    // repeated (at most MAX_ATTEMPTS); this never retries a flashcheck result.
    let res: Awaited<ReturnType<typeof startCapture>> | null = null;
    let reloads = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // record from a black page BEFORE navigating, so the first (not yet limited) frames are included
      await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
      await page.waitForTimeout(500); // let the black page paint
      navigations = 0;
      res = await startCapture(page, dir, c.seconds, FPS, { onStart: () => page.goto(url) });
      if (navigations <= 1) break;
      reloads++;
      console.warn(`[${c.name}] the page reloaded during the capture (dev-server HMR?): capture discarded, attempt ${attempt}`);
    }
    expect(reloads, 'every capture attempt was interrupted by a page reload').toBeLessThan(MAX_ATTEMPTS);
    const snap = await snapshot(page);
    const probe = await page.evaluate(() => {
      const hs = (window as any).__hyperspace;
      const evs: { type: string; payload: any }[] = hs?.events?.all ?? [];
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        limiterEngaged: evs.filter((e) => e.type === 'limiter_engaged').length,
        eventTypes: [...new Set(evs.map((e) => e.type))],
        renderer: gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none',
      };
    });
    const fc = runFlashcheck(dir);
    fs.writeFileSync(path.join(dir, 'worstcase.json'), JSON.stringify({
      case: c.name, url, seconds: c.seconds, trip_seconds: snap.wallTime, capture: res, discarded_reloads: reloads, snapshot: snap, ...probe,
      flashcheck_ok: fc.ok, page_errors: errors,
    }, null, 2));
    console.log(`[${c.name}] trip ${snap.wallTime.toFixed(1)} s, limiter engaged ${probe.limiterEngaged}x, `
      + `events ${probe.eventTypes.join(',')}\n${fc.stdout.trim()}`);

    expect(snap.screen, 'the trip must still be running at the end of the capture').toBe('trip');
    expect(snap.passes.at(-1)).toBe('SafetyLimiter');
    expect(snap.wallTime, 'trip time inside the capture').toBeGreaterThanOrEqual(SECONDS - 1);
    expect(res!.achievedFps, `capture achieved ${res!.achievedFps} fps`).toBeGreaterThanOrEqual(20);
    if (HAS_DISPLAY) expect(probe.renderer).not.toMatch(/swiftshader|llvmpipe|software/i);
    // the forced difficult passage, entity and message actually happened during the capture
    for (const t of ['challenge_start', 'entity_appear', 'message_shown']) expect(probe.eventTypes, `event ${t}`).toContain(t);
    expect(fc.report, 'flashcheck produced no report').not.toBeNull();
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(3);
    expect(fc.report.max_red_flashes_per_s).toBeLessThanOrEqual(3);
    expect(fc.report.pattern_frames).toBe(0);
    expect(fc.report.pattern_motion_windows).toBe(0);
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}
