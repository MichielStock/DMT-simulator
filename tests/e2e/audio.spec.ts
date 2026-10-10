// M7 audio (BUILD.md §12, §4.2, §16.2): /audio-test.html renders the full audio graph through an
// OfflineAudioContext (48 kHz) driven by a synthetic state at maximum intensity and analyses it
// in-page. Asserts the ceiling, the 200 ms onset rule, level tracking and the buzz rate; writes
// verification/audio-test.json and the listening renders verification/audio/*.wav.
//
// Run: E2E_BASE_URL=http://127.0.0.1:<vite port> npx playwright test audio.spec.ts
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers/capture';

const BASE = process.env.E2E_BASE_URL;
test.use({ ...(BASE ? { baseURL: BASE } : {}), launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

interface AudioTest {
  done: boolean; pass: boolean; error?: string;
  checks: Record<string, boolean>;
  results: Record<string, Record<string, number | string[]>>;
  wavs: Record<string, string>;
}

test('offline render of the full audio graph is safe and follows the state', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/audio-test.html?wav=1');
  await page.waitForFunction(() => (window as unknown as { __audioTest?: { done: boolean } }).__audioTest?.done === true, null, { timeout: 220_000 });
  const r = await page.evaluate(() => (window as unknown as { __audioTest: AudioTest }).__audioTest);
  expect(r.error, r.error).toBeUndefined();

  const root = repoRoot();
  const wavDir = path.join(root, 'verification', 'audio');
  fs.mkdirSync(wavDir, { recursive: true });
  for (const [name, b64] of Object.entries(r.wavs)) fs.writeFileSync(path.join(wavDir, `${name}.wav`), Buffer.from(b64, 'base64'));
  const { wavs: _w, ...summary } = r;
  fs.writeFileSync(path.join(root, 'verification', 'audio-test.json'), JSON.stringify({ ...summary, wavs: Object.keys(r.wavs) }, null, 2));

  const max = r.results.max;
  expect(max.peakDbfs as number, 'peak at maximum intensity').toBeLessThanOrEqual(-3);
  expect(r.results.ceilingStress.peakDbfs as number, 'hard ceiling under +12 dBFS square + noise').toBeLessThanOrEqual(-3);
  for (const [name, res] of Object.entries(r.results)) {
    expect(res.maxRiseDb200ms as number, `${name}: rise ≥ 12 dB within 200 ms`).toBeLessThan(12);
    expect(res.peakDbfs as number, `${name}: ceiling`).toBeLessThanOrEqual(-3);
  }
  expect(r.results.level2.rmsDbfs as number).toBeLessThan(r.results.level8.rmsDbfs as number);
  expect(max.amEnvelopePeakHz as number).toBeLessThanOrEqual(12);
  expect(max.amEnvelopePeakHz as number).toBeGreaterThanOrEqual(4);
  expect(max.amOscMaxHz as number).toBeLessThanOrEqual(12);
  expect(r.checks.amLockedToPulse, 'AM at an integer multiple of the 0.5 Hz pulse').toBe(true);
  expect(r.pass).toBe(true);
});

test.describe('live AudioContext', () => {
  test('the graph runs in real time with irregular frames and the buzz locks to the pulse', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/audio-test.html?realtime=1');
    await page.waitForFunction(() => (window as unknown as { __audioTest?: { done: boolean } }).__audioTest?.done === true, null, { timeout: 30_000 });
    const r = await page.evaluate(() => (window as unknown as { __audioTest: { pass: boolean; error?: string; realtime: Record<string, number | string> } }).__audioTest);
    expect(r.error, r.error).toBeUndefined();
    expect(errors).toEqual([]);
    const n = r.realtime.amN as number;
    expect(n, 'AM locked near 23 × the 0.5 Hz pulse').toBeGreaterThanOrEqual(21);
    expect(n).toBeLessThanOrEqual(23);
    expect(Math.abs((r.realtime.amHz as number) - n * (r.realtime.pulseHz as number)), 'AM = n × pulse').toBeLessThan(0.3);
    expect(r.realtime.amHz as number).toBeLessThanOrEqual(12);
    expect(r.pass).toBe(true);
  });
});
