// Downloadable report (BUILD.md 13.5 + the "report with snapshots can be downloaded" request):
// one timewarp breakthrough session on the template stack, then
//  - the end screen shows "<n> SNAPSHOTS SAVED" (n ≥ 3) and [D] downloads a .zip that holds the
//    standalone report.html, the Markdown report and the frames;
//  - the report page has the download link, a chronological snapshot strip and the D/P/R/T action bar.
// Screenshots (1920×1080): verification/tmp/report-export/{end-screen,report-page}.png
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentScreen, DEFAULT_CURVE, repoRoot } from './helpers/session';

const OUT = path.join(repoRoot(), 'verification', 'tmp', 'report-export');
const URL = '/?autostart=1&autofill=neutral&timewarp=30&dose=breakthrough&seed=20261011';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });

let sid = '';

/** Drive whatever screens come up (safety, intake autofill, settling, hit, trip, grounding, curve) to the end screen. */
async function driveToEnd(page: Page, timeout = 12 * 60_000): Promise<void> {
  const t0 = Date.now();
  let hitDone = false;
  let curveDone = false;
  while (Date.now() - t0 < timeout) {
    const s = await currentScreen(page);
    if (s === 'end') return;
    if (s === 'safety') {
      const box = page.getByTestId('safety-checkbox');
      if (!(await box.isChecked().catch(() => true))) await box.check({ force: true });
      const cont = page.getByTestId('safety-continue');
      if (await cont.isEnabled().catch(() => false)) await cont.click();
    } else if (s === 'hit' && !hitDone) {
      const btn = page.getByTestId('hit-button');
      await btn.hover();
      await page.mouse.down();
      await page.waitForTimeout(4000);
      await page.mouse.up();
      hitDone = true;
    } else if (s === 'curve' && !curveDone) {
      await page.evaluate((pts) => (window as any).__hyperspace.drawCurve(pts), DEFAULT_CURVE);
      await page.getByTestId('curve-done').click();
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      curveDone = true;
    } else if (s === 'curve' || s === 'grounding') {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`no end screen after ${timeout} ms (screen ${await currentScreen(page)})`);
}

function zipMembers(file: string): string[] {
  const py = 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))';
  return execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' }).trim().split('\n');
}

test('end screen: snapshot count, [D] downloads the report zip', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  fs.mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await driveToEnd(page);
  const end = page.getByTestId('end-screen');
  await expect(end).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  sid = (await end.getAttribute('data-session-id')) ?? '';
  expect(sid).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}/);

  const count = page.getByTestId('snapshot-count');
  await expect(count).toHaveAttribute('data-count', /\d+/, { timeout: 30_000 });
  const n = Number(await count.getAttribute('data-count'));
  expect(n, 'snapshots saved').toBeGreaterThanOrEqual(3);
  await expect(count).toContainText(`${n} SNAPSHOTS SAVED`);
  await expect(page.getByTestId('download-report')).toContainText('[D] DOWNLOAD');
  await page.screenshot({ path: path.join(OUT, 'end-screen.png') });

  // the frames carry t_min and the deepest layer; periodic snapshots exist
  const frames = await (await page.request.get(`/api/session/${sid}/frames`)).json();
  expect(frames.length).toBe(n);
  expect(frames.some((f: any) => /^snap_\d\d$/.test(f.name)), 'periodic snapshots').toBe(true);
  const ts = frames.map((f: any) => f.t_min);
  expect(ts.every((t: any) => typeof t === 'number')).toBe(true);
  expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  for (const f of frames.filter((f: any) => f.name.startsWith('snap_'))) expect(f.caption).toMatch(/^\d+:\d\d · [a-z ]+$/);

  // [D]: waits for the report, then the zip downloads (the page stays on the end screen)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10 * 60_000 }), page.keyboard.press('d')]);
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
  const file = path.join(OUT, 'download.zip');
  await dl.saveAs(file);
  const members = zipMembers(file);
  expect(members).toContain('report.html');
  expect(members).toContain('simulated-trip-report.md');
  expect(members.filter((m) => /^frames\/.+\.png$/.test(m)).length).toBeGreaterThanOrEqual(3);
  expect(members.some((m) => /trip_script|intake/.test(m)), 'no private files').toBe(false);
  await expect(end).toBeVisible();

  const info = await (await page.request.get(`/api/session/${sid}/export.json`)).json();
  expect(info.members.map((m: any) => m.name).sort()).toEqual([...members].sort());
  expect(fs.statSync(file).size).toBe(info.size);
  const z = await page.request.get(`/api/session/${sid}/export.zip`);
  expect(z.headers()['content-type']).toBe('application/zip');
  expect(errors).toEqual([]);
});

test('report page: hero, chronological snapshots, action bar', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  test.skip(!sid, 'needs the session of the previous test');
  await page.goto(`/sessions/${sid}/report.html`);
  const bar = page.getByTestId('report-actions');
  for (const k of ['[D] DOWNLOAD .ZIP', '[P] PRINT', '[R] REPLAY', '[T] TITLE']) await expect(bar).toContainText(k);
  const link = page.getByTestId('report-download');
  await expect(link).toHaveAttribute('href', `/api/session/${sid}/export.zip`);
  await expect(link).toHaveAttribute('download', /\.zip$/);
  await expect(page.getByTestId('hero').locator('img')).toBeVisible();
  const figs = page.locator('[data-testid=snapshots] figure');
  expect(await figs.count()).toBeGreaterThanOrEqual(3);
  const t = (await figs.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-t-min')))));
  expect([...t].sort((a, b) => a - b)).toEqual(t);
  await expect(figs.first().locator('figcaption')).toHaveText(/^\d+:\d\d·.+/);
  // every image loaded
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60_000 });
  await page.screenshot({ path: path.join(OUT, 'report-page-top.png') });
  await page.locator('ol.strip').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'report-page-strip.png') });
  // headless Chrome leaves off-screen images unpainted in a full-page shot unless they were on screen once
  for (let y = 0; y < (await page.evaluate(() => document.body.scrollHeight)); y += 900) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'report-page.png'), fullPage: true });
  // the D key downloads from the report page too
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.keyboard.press('d')]);
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
});
