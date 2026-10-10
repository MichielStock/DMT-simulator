// End to end (BUILD.md 16.2): one session per dose step in timewarp with the neutral profile.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSession, sessionsDir, waitForReport, type DoseStep } from './helpers/session';

const SEED = 20261010;
const STEPS: DoseStep[] = ['threshold', 'light', 'strong', 'breakthrough'];
const ORDER = ['none', 'onset', 'form_constants', 'chrysanthemum', 'waiting_room', 'breakthrough'];

test.describe.configure({ mode: 'serial' });

for (const dose of STEPS) {
  test(`full session at ${dose} (timewarp 10)`, async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const { id, events } = await runSession(page, { dose, seed: SEED, timewarp: 10 });
    const dir = path.join(sessionsDir(), id);
    expect(fs.existsSync(dir), `session folder ${dir}`).toBe(true);

    // events
    const types = new Set(events.map((e) => e.type));
    for (const t of ['hit', 'intensity_sample', 'session_end']) expect(types, `event ${t}`).toContain(t);
    const hit = events.find((e) => e.type === 'hit')!;
    expect(hit.payload.dose_step).toBe(dose);
    expect(hit.payload.hold_fraction).toBeGreaterThan(0.95);
    expect(events.find((e) => e.type === 'session_end')!.payload.reason).toBe('faded');

    const script = JSON.parse(fs.readFileSync(path.join(dir, 'trip_script.json'), 'utf8'));
    const predicted: string = script.predicted.deepest_layer;
    const entered = new Set(events.filter((e) => e.type === 'layer_enter').map((e) => e.payload.layer));
    for (const layer of ORDER.slice(2, ORDER.indexOf(predicted) + 1)) expect(entered, `layer_enter ${layer}`).toContain(layer);

    // the event log on disk has everything the page logged
    const onDisk = fs.readFileSync(path.join(dir, 'event_log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(onDisk.length).toBeGreaterThanOrEqual(events.length);

    // stats: deepest layer equals the prediction; the end screen shows the same box
    const stats = await (await page.request.get(`/api/session/${id}/stats`)).json();
    expect(String(stats.deepest_layer).toLowerCase().replace(/ /g, '_')).toBe(predicted === 'none' ? 'none' : predicted);
    await expect(page.getByTestId('end-box')).toContainText(stats.box[3]);

    // report files with the Simulated label
    await waitForReport(page, id);
    const md = fs.readFileSync(path.join(dir, 'simulated-trip-report.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(fm, 'front matter').not.toBeNull();
    expect(fm![1]).toMatch(/simulated:\s*true/);
    expect(fm![1]).toMatch(/title:.*Simulated/);
    expect(fs.existsSync(path.join(dir, 'report.html'))).toBe(true);

    // frames
    const frames = fs.existsSync(path.join(dir, 'frames')) ? fs.readdirSync(path.join(dir, 'frames')).filter((f) => f.endsWith('.png')) : [];
    if (dose !== 'threshold') {
      expect(frames.length, 'frames captured').toBeGreaterThanOrEqual(1);
      expect(onDisk.some((e: any) => e.type === 'frame_captured')).toBe(true);
    }
    expect(errors, 'page errors').toEqual([]);
  });
}
