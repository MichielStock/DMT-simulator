// Retro screen captures (BUILD.md 16.2): title, safety, the setup screen (+ details) and the end screen at
// 1920x1080 and 3840x2160 into verification/gallery/screens/.
import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acceptSafety, repoRoot, waitForScreen } from './helpers/session';

const SIZES = [
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
];
const OUT = path.join(repoRoot(), 'verification', 'gallery', 'screens');

async function shot(page: Page, name: string, size: { width: number; height: number }): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // freeze CSS animations at a fixed point so captures are reproducible
  await page.addStyleTag({ content: '*, *::before, *::after { animation-play-state: paused !important; animation-delay: -2s !important; }' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, `${name}_${size.width}x${size.height}.png`) });
}

/** A finished session with stats (newest first), for ?demoEnd=. */
async function finishedSession(page: Page): Promise<string | null> {
  const r = await page.request.get('/api/sessions');
  if (!r.ok()) return null;
  const list: { id: string; has_report: boolean; peak_visual: number | null }[] = await r.json();
  // only sessions that actually ran a trip and wrote a report
  const done = list.filter((s) => s.has_report && (s.peak_visual ?? 0) > 0);
  for (const s of done.sort((a, b) => (a.id < b.id ? 1 : -1))) {
    const st = await page.request.get(`/api/session/${s.id}/stats`);
    if (st.ok()) return s.id;
  }
  return null;
}

for (const size of SIZES) {
  test.describe(`screens at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('title', async ({ page }) => {
      await page.goto('/');
      await waitForScreen(page, 'title');
      await expect(page.getByTestId('title-screen')).toBeVisible();
      await expect(page.getByTestId('session-count')).not.toHaveText('…');
      await shot(page, 'title', size);
    });

    test('safety', async ({ page }) => {
      await page.goto('/?autostart=1');
      await waitForScreen(page, 'safety');
      await expect(page.getByText('Before you begin', { exact: false })).toBeVisible();
      await shot(page, 'safety', size);
    });

    test('intake', async ({ page }) => {
      await page.goto('/?autostart=1');
      await acceptSafety(page);
      await waitForScreen(page, 'intake');
      await expect(page.getByTestId('setup-screen')).toBeVisible();
      await expect(page.getByTestId('intake-option-strong')).toHaveClass(/selected/);
      await shot(page, 'intake', size);
      await page.keyboard.press('d'); // the optional details sub-screen
      await expect(page.getByTestId('intake-slider-clarity')).toBeVisible();
      await shot(page, 'intake_details', size);
    });

    test('end screen', async ({ page }) => {
      const id = await finishedSession(page);
      test.skip(!id, 'no finished session yet (run session.spec.ts first)');
      await page.goto(`/?demoEnd=${id}`);
      await waitForScreen(page, 'end');
      await expect(page.getByTestId('saved-to')).toBeVisible();
      await shot(page, 'end', size);
    });
  });
}
