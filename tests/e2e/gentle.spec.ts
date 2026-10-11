// Gentle mode (BUILD.md 0.5, 4.3, 11.7): the gentle intake profile (difficult passages off) at a strong
// dose. Expect no difficult passage at all (no challenge_start / challenge_resolve), at most one fear
// flicker of at most 5 s (director record and the measured state.challenge level), and a completed session.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acceptSafety, drawCurve, fillIntake, sessionIdFromEndScreen, sessionsDir, sessionUrl, takeHit, waitForScreen, waitReady } from './helpers/session';

const BASE = process.env.E2E_BASE_URL;
test.use({ ...(BASE ? { baseURL: BASE } : {}) });

test('gentle mode at strong dose: no difficult passage, at most one short fear flicker, session completes', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(sessionUrl({ dose: 'strong', seed: 20261012, timewarp: 10, autofill: 'gentle' }));
  await acceptSafety(page);
  await fillIntake(page);
  await waitReady(page);
  await takeHit(page, 4000);
  await waitForScreen(page, 'trip', 15_000);

  // sample the shared state in the page every animation frame (model time + fear level)
  await page.evaluate(() => {
    const w = window as any;
    const probe = { samples: [] as { t: number; level: number; active: boolean }[], flickers: [] as unknown[], gentle: null as boolean | null };
    w.__gentleProbe = probe;
    const tick = () => {
      const hs = w.__hyperspace;
      const st = hs?.state;
      if (hs?.screen === 'trip' && st) {
        probe.samples.push({ t: st.t_min, level: st.challenge.level, active: st.challenge.active });
        probe.gentle = !!st.gentle;
        if (hs.director) probe.flickers = JSON.parse(JSON.stringify(hs.director.flickers ?? []));
      }
      if (hs?.screen === 'trip' || hs?.screen === 'fade') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await waitForScreen(page, 'grounding', 10 * 60_000);
  const probe = await page.evaluate(() => (window as any).__gentleProbe);
  const evs = await page.evaluate(() => (window as any).__hyperspace.events?.all ?? []);
  expect(probe.gentle, 'state.gentle').toBe(true);
  expect(probe.samples.length).toBeGreaterThan(100);
  expect(evs.find((e: any) => e.type === 'session_end')?.payload.reason).toBe('faded');

  // no difficult passage
  expect(evs.filter((e: any) => e.type === 'challenge_start' || e.type === 'challenge_resolve')).toEqual([]);
  expect(probe.samples.some((s: any) => s.active), 'challenge.active never set').toBe(false);

  // at most one fear flicker of at most 5 s (model time)
  expect(probe.flickers.length).toBeLessThanOrEqual(1);
  for (const f of probe.flickers) expect(f.duration_s).toBeLessThanOrEqual(5);
  let runs = 0, start = -1, longest = 0;
  for (const s of probe.samples) {
    if (s.level > 1e-3) { if (start < 0) { start = s.t; runs++; } longest = Math.max(longest, (s.t - start) * 60); } else start = -1;
  }
  expect(runs, 'fear flickers (measured)').toBeLessThanOrEqual(1);
  expect(longest, 'longest fear flicker (s)').toBeLessThanOrEqual(5);
  console.log(`gentle: flickers ${JSON.stringify(probe.flickers)}, measured runs ${runs}, longest ${longest.toFixed(2)} s, samples ${probe.samples.length}`);

  // the session completes
  await drawCurve(page);
  await waitForScreen(page, 'end', 60_000);
  await expect(page.getByTestId('end-screen')).toBeVisible();
  const id = await sessionIdFromEndScreen(page);
  const dir = path.join(sessionsDir(), id);
  const onDisk = fs.readFileSync(path.join(dir, 'event_log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(onDisk.some((e: any) => e.type === 'challenge_start')).toBe(false);
  const intake = JSON.parse(fs.readFileSync(path.join(dir, 'intake.json'), 'utf8'));
  expect(intake.options.difficult_passages).toBe(false);
  expect(intake.dose_step).toBe('strong');
  const script = JSON.parse(fs.readFileSync(path.join(dir, 'trip_script.json'), 'utf8'));
  expect(script.challenge.occurs).toBe(false);
  const stats = await (await page.request.get(`/api/session/${id}/stats`)).json();
  expect(stats.difficult_passage).toMatch(/^(NONE|GENTLE MODE)$/);
  expect(errors, 'page errors').toEqual([]);
});
