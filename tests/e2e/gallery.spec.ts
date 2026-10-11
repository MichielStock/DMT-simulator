// Render galleries (BUILD.md 16.2 "Render galleries", 16.4 inputs).
// For each layer x intensity (1, 3, 5, 7.5, 9) x seed (11, 23): scrub mode (dose breakthrough, layer
// forced), wait for readyForCapture + 2 s of wall time, save the trip canvas (1280x720, after the
// SafetyLimiter) to verification/gallery/<layer>/<layer>_v<v>_s<seed>.png with a <frame>.json sidecar
// (session id, palette, v, seed, layer, weights, render stats). Room base frames are taken with eyes
// forced open (eyes auto would fade the room into the phosphene field from v 2.5); extras: room at
// v 3 and 5 with eyes closed (eyes-closed field; at v 1 it is near-black by design) and every layer at v=9 with a difficult passage forced;
// breakthrough also gets <layer>_v9_s<seed>_entity.png (entity + message forced, captured once both are at full
// intensity; not part of gallery_checks.py's naming, so it is reviewed by eye). Then tools/gallery_checks.py must
// pass on the folder.
//
//   GALLERY_LAYERS=room,form_constants   limit the layers (a layer agent re-runs only its own)
//   GALLERY_SKIP_CHECKS=1                 capture only (scripts/gallery.sh runs the checks itself)
//   E2E_BASE_URL=http://127.0.0.1:5174    run against a Vite dev server (CONTRACTS.md)
//   GALLERY_SESSIONS=11=<id>,23=<id>      reuse prepared sessions (real images) per seed via &session=<id>
//                                         instead of planning a new session for every frame
// Each frame may take up to FRAME_TIMEOUT_MS (120 s) so a real-model stack (planner + SDXL) fits.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from './helpers/capture';
import { canvasPng, layersFromEnv, scrubUrl, sessionsFromEnv, snapshot, waitReady, writeFrame, type GalleryLayer, type ScrubOptions } from './helpers/scrub';

const BASE = process.env.E2E_BASE_URL;
test.use({ ...(BASE ? { baseURL: BASE } : {}), viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const INTENSITIES = [1, 3, 5, 7.5, 9];
const SEEDS = [11, 23];
const LAYERS = layersFromEnv('GALLERY_LAYERS');
// GALLERY_OUT=<dir> writes elsewhere (e.g. an agent's scratch folder) so parallel agents' frames are not replaced
const OUT = process.env.GALLERY_OUT ? path.resolve(repoRoot(), process.env.GALLERY_OUT) : path.join(repoRoot(), 'verification', 'gallery');
const SESSIONS = sessionsFromEnv('GALLERY_SESSIONS');
const FRAME_TIMEOUT_MS = 120_000;

interface Shot { file: string; opts: ScrubOptions; kind: 'base' | 'eyes' | 'challenge' | 'entity' }

function shots(layer: GalleryLayer): Shot[] {
  const out: Shot[] = [];
  for (const seed of SEEDS) {
    for (const v of INTENSITIES) {
      // room base frames with eyes open (the room itself, BUILD.md 16.4); other layers: eyes auto
      out.push({ kind: 'base', file: `${layer}/${layer}_v${v}_s${seed}.png`, opts: { layer, v, seed, eyes: layer === 'room' ? 0 : null } });
    }
    if (layer === 'room') {
      for (const v of [3, 5]) out.push({ kind: 'eyes', file: `${layer}/${layer}_v${v}_s${seed}_eyes.png`, opts: { layer, v, seed, eyes: 1 } });
    }
    out.push({ kind: 'challenge', file: `${layer}/${layer}_v9_s${seed}_challenge.png`, opts: { layer, v: 9, seed, challenge: true } });
    if (layer === 'breakthrough') {
      out.push({ kind: 'entity', file: `${layer}/${layer}_v9_s${seed}_entity.png`, opts: { layer, v: 9, seed, entity: true, message: true } });
    }
  }
  for (const s of out) s.opts.session = SESSIONS.get(s.opts.seed ?? -1) ?? null;
  return out;
}


for (const layer of LAYERS) {
  test(`gallery: ${layer}`, async ({ page }) => {
    const list = shots(layer);
    test.setTimeout(list.length * FRAME_TIMEOUT_MS + 60_000);
    const dir = path.join(OUT, layer);
    fs.mkdirSync(dir, { recursive: true });
    // remove only this spec's own frames (layer agents keep their own captures in the same folder)
    const mine = new RegExp(`^${layer}_v[0-9.]+_s\\d+(_eyes|_challenge|_entity)?\\.(png|json)$`);
    for (const f of fs.readdirSync(dir)) if (mine.test(f)) fs.rmSync(path.join(dir, f));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    for (const s of list) {
      // a Vite dev-server reload (another file edited) between load and screenshot invalidates the shot:
      // take it again (at most 3 attempts)
      let snap: Awaited<ReturnType<typeof snapshot>> | null = null;
      let png: Buffer | null = null;
      for (let attempt = 1; attempt <= 3 && !png; attempt++) {
        navigations = 0;
        await page.goto(scrubUrl({ dose: 'breakthrough', ...s.opts }));
        snap = await waitReady(page, 2, FRAME_TIMEOUT_MS);
        if (s.kind === 'challenge') {
          // a forced difficult passage ramps in over 5 s (director CHALLENGE.rampS)
          await expect.poll(async () => (await snapshot(page)).challengeLevel, { timeout: 20_000, intervals: [200] })
            .toBeGreaterThanOrEqual(0.95).catch(() => undefined);
          snap = await snapshot(page);
        }
        if (s.kind === 'entity') {
          // forced entity + message: wait until the being has come close and the glyph message is at full
          // envelope (message 2 s fade-in; the entity flares while it speaks)
          await expect.poll(async () => { const x = await snapshot(page); return Math.min(x.entity, x.messageIntensity); },
            { timeout: 30_000, intervals: [200] }).toBeGreaterThanOrEqual(0.9).catch(() => undefined);
          snap = await snapshot(page);
        }
        const shot = await canvasPng(page).catch(() => null);
        if (navigations <= 1 && shot) png = shot;
        else console.warn(`${s.file}: page reloaded during the shot, attempt ${attempt}`);
      }
      expect(png, `${s.file}: no stable capture`).not.toBeNull();
      snap = snap!;
      expect(snap.passes.at(-1), 'pipeline must end with the SafetyLimiter').toBe('SafetyLimiter');
      writeFrame(path.join(OUT, s.file), png!, {
        file: s.file, layer, kind: s.kind, v: s.opts.v, seed: s.opts.seed, eyes: s.opts.eyes ?? null,
        challenge: !!s.opts.challenge, entity_forced: !!s.opts.entity, message_forced: !!s.opts.message,
        entity_intensity: snap.entity, entity_depth: snap.entityDepth, message_intensity: snap.messageIntensity,
        reused_session: s.opts.session ?? null, session_id: snap.sessionId, palette: snap.palette,
        visual: snap.visual, weights: snap.weights, challenge_level: snap.challengeLevel, eyes_closed: snap.eyesClosed,
        wall_time_s: snap.wallTime, render_stats: snap.renderStats, captured_at: new Date().toISOString(),
        url: page.url(),
      });
      // leave the trip (its fade ends the session cleanly) before the next navigation
      await page.evaluate(() => (window as any).__hyperspace?.finishEarly?.());
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}

test('gallery: automated checks (tools/gallery_checks.py)', async () => {
  test.skip(process.env.GALLERY_SKIP_CHECKS === '1', 'checks run separately');
  test.setTimeout(10 * 60_000);
  const p = spawnSync('uv', ['run', 'python', 'tools/gallery_checks.py', OUT, '--layers', LAYERS.join(',')], {
    cwd: repoRoot(), encoding: 'utf8', timeout: 10 * 60_000,
    env: { ...process.env, HYPERSPACE_SESSIONS_DIR: process.env.HYPERSPACE_SESSIONS_DIR ?? '' },
  });
  console.log(`${p.stdout ?? ''}${p.stderr ?? ''}`.trim());
  expect(p.status, 'gallery_checks.py failed (see the table above / verification/gallery/checks.json)').toBe(0);
});
