// Escape at the peak (BUILD.md 4.2, 13.1, 16.2): a breakthrough session in timewarp 10; Escape is
// pressed at the predicted peak. Expect the 3-second fade, grounding, the curve, the end screen, the
// report, exit_pressed + session_end {reason: escape} in the event log on disk, and working stats.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  acceptSafety, currentScreen, drawCurve, fillIntake, sessionIdFromEndScreen, sessionsDir, sessionUrl, takeHit,
  waitForReport, waitForScreen, waitReady,
} from './helpers/session';

const BASE = process.env.E2E_BASE_URL;
test.use({ ...(BASE ? { baseURL: BASE } : {}) });

test('Escape at the peak: fade, grounding, curve, end screen, report, logged as escape', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(sessionUrl({ dose: 'breakthrough', seed: 20261011, timewarp: 10 }));
  await acceptSafety(page);
  await fillIntake(page);
  await waitReady(page);
  await takeHit(page, 4000);
  await waitForScreen(page, 'trip', 15_000);

  // the peak: the predicted peak time of the trip script (fallback: visual ≥ 8)
  const peakMin = await page.evaluate(() => {
    const st = (window as any).__hyperspace.state;
    return Number(st?.tripScript?.predicted?.peak_time_min ?? NaN);
  });
  await expect.poll(() => page.evaluate((pk) => {
    const st = (window as any).__hyperspace.state;
    if (!st) return false;
    return Number.isFinite(pk) ? st.t_min >= pk : st.intensity.visual >= 8;
  }, peakMin), { timeout: 120_000, intervals: [50, 100] }).toBe(true);
  const atPress = await page.evaluate(() => {
    const st = (window as any).__hyperspace.state;
    return { t: st.t_min, v: st.intensity.visual };
  });
  expect(atPress.v, 'pressed near the peak').toBeGreaterThan(7);

  const t0 = Date.now();
  await page.keyboard.press('Escape');
  // the fade starts at once (no confirmation) and lasts 3 s of wall time
  await expect.poll(() => currentScreen(page), { timeout: 2_000, intervals: [20, 50] }).toBe('fade');
  await expect(page.getByTestId('fade')).toHaveClass(/\bon\b/);
  await waitForScreen(page, 'grounding', 15_000);
  const fadeS = (Date.now() - t0) / 1000;
  expect(fadeS, 'fade duration').toBeGreaterThanOrEqual(2.9);
  expect(fadeS).toBeLessThan(8);
  await expect(page.getByTestId('grounding')).toBeVisible();
  const evs = await page.evaluate(() => (window as any).__hyperspace.events?.all ?? []);
  expect(evs.some((e: any) => e.type === 'exit_pressed')).toBe(true);

  // curve → end screen
  await drawCurve(page);
  await waitForScreen(page, 'end', 60_000);
  await expect(page.getByTestId('end-screen')).toBeVisible();
  const id = await sessionIdFromEndScreen(page);
  const dir = path.join(sessionsDir(), id);

  // event log on disk
  const onDisk = fs.readFileSync(path.join(dir, 'event_log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const exit = onDisk.filter((e: any) => e.type === 'exit_pressed');
  const end = onDisk.filter((e: any) => e.type === 'session_end');
  expect(exit, 'one exit_pressed').toHaveLength(1);
  expect(end, 'one session_end').toHaveLength(1);
  expect(end[0].payload.reason).toBe('escape');
  expect(Math.abs(exit[0].t_min - atPress.t)).toBeLessThan(0.1);
  // a difficult passage that was running is resolved by the exit
  const starts = onDisk.filter((e: any) => e.type === 'challenge_start').length;
  const resolves = onDisk.filter((e: any) => e.type === 'challenge_resolve').length;
  expect(resolves).toBe(starts);
  expect(fs.existsSync(path.join(dir, 'curve.json'))).toBe(true);

  // stats endpoint
  const sr = await page.request.get(`/api/session/${id}/stats`);
  expect(sr.ok()).toBe(true);
  const stats = await sr.json();
  expect(Array.isArray(stats.box)).toBe(true);
  expect(stats.ended_early_at, 'stats record the early end').not.toBeNull();
  await expect(page.getByTestId('end-box')).toContainText(stats.box[3]);

  // report
  await waitForReport(page, id);
  expect(fs.existsSync(path.join(dir, 'simulated-trip-report.md'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'report.html'))).toBe(true);
  expect(errors, 'page errors').toEqual([]);
});
