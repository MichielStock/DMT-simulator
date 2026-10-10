// M5 spectrum gate in the browser (BUILD.md §11.4, §18): read back the GPU neural field through
// window.__hyperspace.readField() at visual intensity 1 (below the critical gain: no pattern) and 6
// (pattern at the predicted wavenumber), and check the spatial spectrum with tools/field_spectrum.py.
// Uses scrub mode (?debug=1&scrub=1, main.ts) with the form-constants layer forced and the regime
// forced through &fcmode= (neuralField.ts). Run against a dev stack:
//   cd frontend && E2E_BASE_URL=http://127.0.0.1:<vite> npx playwright test neuralfield-spectrum
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers/session';

const SEED = 20261010;
const OUT = path.join(repoRoot(), 'verification', 'neural_field');

async function fieldAt(page: Page, v: number, mode: string): Promise<{ info: any; file: string }> {
  await page.goto(`/?debug=1&scrub=1&dose=strong&seed=${SEED}&v=${v}&layer=form_constants&fcmode=${mode}`);
  await expect.poll(() => page.evaluate(() => (window as any).__hyperspace?.fieldInfo?.()?.ready ?? false),
    { timeout: 180_000, intervals: [500, 1000] }).toBe(true);
  // a little more time at the target gain, then read the GPU field
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => (window as any).__hyperspace.fieldInfo());
  const data: number[] = await page.evaluate(() => Array.from((window as any).__hyperspace.readField() as Float32Array));
  expect(data.length).toBe(256 * 256);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `field_v${v}_${mode}.f32`);
  fs.writeFileSync(file, Buffer.from(new Float32Array(data).buffer));
  return { info, file };
}

function spectrum(file: string, args: string[]): { status: number; res: any } {
  const r = spawnSync('uv', ['run', 'python', 'tools/field_spectrum.py', file, '--json', file.replace(/\.f32$/, '.json'), ...args],
    { cwd: repoRoot(), encoding: 'utf8' });
  let res: any = null;
  try { res = JSON.parse(r.stdout); } catch { res = { raw: r.stdout, err: r.stderr }; }
  return { status: r.status ?? -1, res };
}

test.describe.configure({ mode: 'serial' });

test('GPU field at v=1: no spectral peak above noise', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const { info, file } = await fieldAt(page, 1, 'stripes_x');
  expect(info.ratio).toBeLessThan(1);
  const { status, res } = spectrum(file, ['--expect', 'none']);
  console.log('v=1', JSON.stringify({ ratio: info.ratio, p2m: res.peak_to_median }));
  expect(res.peak_to_median).toBeLessThan(3);
  expect(status).toBe(0);
});

for (const mode of ['stripes_x', 'hexagons']) {
  test(`GPU field at v=6 (${mode}): peak at the predicted wavenumber`, async ({ page }) => {
    test.setTimeout(5 * 60_000);
    const { info, file } = await fieldAt(page, 6, mode);
    expect(info.ratio).toBeGreaterThan(1);
    const { status, res } = spectrum(file, ['--expect', 'pattern', '--predict-k', String(info.predictedK)]);
    console.log(`v=6 ${mode}`, JSON.stringify({ ratio: info.ratio, k: res.peak_k, pred: info.predictedK, p2m: res.peak_to_median, dirs: res.directions_deg }));
    expect(res.peak_to_median).toBeGreaterThanOrEqual(8);
    expect(res.k_rel_error).toBeLessThan(0.15);
    expect(status).toBe(0);
    if (mode === 'hexagons') {
      const top = res.directions_deg.slice(0, 3);
      expect(top.length).toBe(3);
      for (const d of top) expect(d.rel).toBeGreaterThan(0.4);
    }
  });
}

// Gallery (BUILD.md §16.2/§16.4): the four form-constant classes at v = 3, 5, 7.5, 9 with the layer
// forced, into verification/gallery/form_constants/. Opt-in: FORM_CONSTANTS_GALLERY=1.
const GALLERY = [
  { cls: 'tunnels', mode: 'stripes_x', seed: 7 },
  { cls: 'funnels', mode: 'stripes_y', seed: 11 },
  { cls: 'spirals', mode: 'spirals', seed: 12 },
  { cls: 'lattices', mode: 'hexagons', seed: 13 },
];
test.describe('form_constants gallery', () => {
  test.skip(!process.env.FORM_CONSTANTS_GALLERY, 'set FORM_CONSTANTS_GALLERY=1');
  for (const g of GALLERY) {
    test(`gallery ${g.cls}`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      const dir = path.join(repoRoot(), 'verification', 'gallery', 'form_constants');
      fs.mkdirSync(dir, { recursive: true });
      for (const v of [3, 5, 7.5, 9]) {
        await page.goto(`/?debug=1&scrub=1&dose=strong&seed=${g.seed}&v=${v}&layer=form_constants&fcmode=${g.mode}`);
        await expect.poll(() => page.evaluate(() => {
          const hs = (window as any).__hyperspace;
          return !!(hs?.readyForCapture && hs?.fieldInfo?.()?.ready);
        }), { timeout: 180_000, intervals: [500, 1000] }).toBe(true);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(dir, `${g.cls}_seed${g.seed}_v${v}.png`) });
      }
    });
  }
});
