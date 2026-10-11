// SafetyLimiter pattern guard, periodicity-aware (NOTES.md S8): STATIC high-contrast (Michelson ~0.9)
// PERIODIC patterns must engage the guard from the first frame and leave flashcheck with 0 pattern frames;
// APERIODIC high-contrast content (a photo, blooms and filaments on a dark base) must never engage it and
// must reach the screen unchanged (pre-limiter frame == post-limiter frame).
// S8b (NOTES.md): the adversarial EVASIONS found against S8 (zone plates and other chirps, FM bar trains,
// zone-plate lattices, 30% patches, red-only / dark / saturated-blue stripes, amplitude-modulated
// stripes, stripes next to black, a perspective floor, Poincare rings, a bar code, drifting, alternating
// and render-scaled versions) must engage the guard within 2 frames, keep it on and leave flashcheck
// with 0 pattern frames. S8c (NOTES.md): the round-2 evasions (crossed chirps, conformal lattices and plaids,
// a noisy zone plate, edge bands, saturated colours, the limiter's own fade, the 8-bit range floor) likewise.
// Real Chrome with the GPU on DISPLAY (default :1), real-time CDP capture, like safety-limiter.spec.ts.
//
//   E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test safety-guard
import { expect, test, type Page } from '@playwright/test';
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

interface Hist { frame: number; t: number; engaged: boolean; patternGuard: number; highContrastFraction: number;
  periodicFraction: number; meanLuminance: number }
interface Probe { frames: number; ready: boolean; shaderError: string | null; engagedCount: number; webgl2: boolean;
  passes: string[]; history: Hist[]; status: Record<string, unknown> }

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const l = (window as any).__limiter;
    return { frames: l.frames, ready: l.ready, shaderError: l.shaderError, engagedCount: l.engagedCount,
      webgl2: l.webgl2, passes: l.passes, history: l.history, status: l.status() };
  }) as Promise<Probe>;
}

async function capture(page: Page, baseURL: string | undefined, name: string, query: string,
  opts: { seconds?: number; after?: (page: Page) => Promise<void> } = {}) {
  const seconds = opts.seconds ?? SECONDS;
  const dir = path.join(repoRoot(), 'verification', 'captures', `guard-${name}`);
  const url = new URL(`/safety-test.html?${query}`, baseURL).toString();
  // Record from a black page BEFORE navigating, so the very first frames of the pattern are captured.
  await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
  const res = await startCapture(page, dir, seconds, FPS, {
    onStart: async () => { await page.goto(url); if (opts.after) await opts.after(page); },
  });
  const info = await probe(page);
  fs.writeFileSync(path.join(dir, 'limiter.json'), JSON.stringify({ ...info, history: info.history.slice(0, 20),
    maxPatternGuard: Math.max(...info.history.map((h) => h.patternGuard)), capture: res }, null, 2));
  expect(info.shaderError, 'test pattern shader error').toBeNull();
  expect(info.webgl2).toBe(true);
  expect(info.passes.at(-1)).toBe('SafetyLimiter');
  expect(res.achievedFps, `capture achieved ${res.achievedFps} fps`).toBeGreaterThanOrEqual(20);
  expect(info.frames).toBeGreaterThan(seconds * 20);
  const fc = runFlashcheck(dir);
  console.log(`${name}: ${fc.stdout.trim().split('\n').slice(-3).join(' | ')}`);
  expect(fc.report, 'flashcheck produced no report').not.toBeNull();
  return { dir, info, fc };
}

const custom = (glsl: string): string => `pattern=custom&frag=${encodeURIComponent(glsl)}`;
const PERIODIC: Array<[string, string]> = [
  ...['rings', 'hex', 'diag', 'checker', 'bigstripes', 'thinlines'].map((p): [string, string] => [p, `pattern=${p}`]),
  // adversarial: a 36-spoke sunburst (period shrinks toward the centre) and 90-px rings (W/14 at 1280)
  ['radial36', custom('vec2 d = uv * uRes - 0.5 * uRes; return vec3(0.05 + 0.9 * step(0.5, fract(atan(d.y, d.x) / 6.2831853 * 36.0)));')],
  ['rings90', custom('return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * length(uv * uRes - 0.5 * uRes) / 90.0)));')],
];

for (const [pattern, query] of PERIODIC) {
  test(`guard: static periodic '${pattern}' (Michelson 0.9) is caught from frame 1 and passes flashcheck`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { info, fc } = await capture(page, baseURL, pattern, query);
    const first = info.history.slice(0, 2);
    expect(first.length).toBe(2);
    expect(first.some((h) => h.patternGuard === 1), `patternGuard over the first 2 frames: ${JSON.stringify(first)}`).toBe(true);
    expect(info.history[1].periodicFraction).toBeGreaterThan(0.2);
    expect(info.history[1].highContrastFraction).toBeGreaterThan(0.2);
    expect(info.history.every((h) => h.patternGuard === 1), 'guard must stay on while the pattern is shown').toBe(true);
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.pattern_frames).toBe(0);
    // static: at most the single black -> pattern step at navigation (0.5 flash), never a flash pair
    expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(0.5);
    expect(fc.report.max_red_flashes_per_s).toBe(0);
  });
}

// ---- S8b: evasions of the S8 guard (adversarial review, 2026-10-11) -------------------------------
// Static luminance 0.05 / 0.95 (Michelson 0.9) unless noted; `c` = pixel offset from the screen centre.
const GEO = `
const float LO = 0.05; const float HI = 0.95;
float sqw(float u, float T) { return fract(u / T) < 0.5 ? 1.0 : 0.0; }
float cw(float u, float T) { return 0.5 + 0.5 * cos(6.2831853 * u / T); }
vec2 rot(vec2 p, float deg) { float a = radians(deg); return vec2(cos(a) * p.x + sin(a) * p.y, -sin(a) * p.x + cos(a) * p.y); }
float lv(float s) { return LO + (HI - LO) * clamp(s, 0.0, 1.0); }
vec3 pattern(vec2 uv, float t) {
  vec2 px = uv * uRes; vec2 c = px - 0.5 * uRes;
`;
const geo = (body: string): string => custom(`${GEO}${body}\n}\n`);
const zp = (k: string): string => geo(`return vec3(lv(0.5 + 0.5 * cos(dot(c, c) * ${k})));`);
const fm = (L: number, T: number, beta: string, deg: string): string =>
  geo(`float u = rot(px, ${deg}).x; float ph = u / ${T}.0 + ${beta} * sin(6.2831853 * u / ${L}.0); return vec3(lv(step(0.0, cos(6.2831853 * ph))));`);
const ZP295 = 'vec2 d = uv * uRes - 0.5 * uRes; float r = length(d);';
interface Evasion { name: string; query: string; dynamic?: boolean; seconds?: number; after?: (page: Page) => Promise<void> }
const EVASIONS: Evasion[] = [
  // zone plates (chirps: the local period changes too fast for the autocorrelation repeat test)
  { name: 'zone_k0.0003', query: zp('0.0003') },
  { name: 'zone_k0.0002', query: zp('0.0002') },
  { name: 'zone_k0.0004', query: zp('0.0004') },
  { name: 'zone_k0.0006', query: zp('0.0006') },
  { name: 'zonesq_k0.0003', query: geo('return vec3(lv(step(0.0, cos(dot(c, c) * 0.0003))));') },
  { name: 'zone_ellip', query: geo('vec2 d = c * vec2(1.0, 1.6); return vec3(lv(0.5 + 0.5 * cos(dot(d, d) * 0.0003)));') },
  { name: 'zone_k0.0003_magenta_dark', query: geo('float s = 0.5 + 0.5 * cos(dot(c, c) * 0.0003); return mix(vec3(0.02, 0.0, 0.04), vec3(0.9, 0.1, 1.0), s);') },
  { name: 'zone_k0.0003_thin', query: geo('return vec3(cos(dot(c, c) * 0.0003) > 0.8 ? 0.95 : 0.0);') },
  { name: 'zone_k0.0003_red', query: geo('return vec3(step(0.0, cos(dot(c, c) * 0.0003)), 0.0, 0.0);') },   // red on black
  { name: 'zone_offcentre', query: geo('return vec3(lv(0.5 + 0.5 * cos(dot(px, px) * 0.00025)));') },        // centred on a corner
  { name: 'zoneplate', query: custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 2.95e-5 * r * r)));`) },
  { name: 'zp_fast', query: custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 6e-5 * r * r)));`) },
  { name: 'zp_slow', query: custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 1.5e-5 * r * r)));`) },
  { name: 'zp_vslow', query: custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 0.8e-5 * r * r)));`) },  // ~4 rings centre-corner
  { name: 'zp_square', query: custom(`${ZP295} return vec3(0.05 + 0.9 * step(0.5, fract(2.95e-5 * r * r)));`) },
  // zone plates on 30% of the screen
  { name: 'zone_k0.0003_disc30', query: geo('float R = sqrt(0.30 * uRes.x * uRes.y / 3.14159265); if (length(c) > R) return vec3(0.0); return vec3(lv(0.5 + 0.5 * cos(dot(c, c) * 0.0003)));') },
  { name: 'zone_k0.0003_area30', query: `${zp('0.0003')}&area=0.3` },
  { name: 'zone_k0.0003_corner30', query: geo('if (uv.x > 0.5477 || uv.y > 0.5477) return vec3(0.0); return vec3(lv(0.5 + 0.5 * cos(dot(px, px) * 0.0003)));') },
  { name: 'zp_area30', query: `${custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 6e-5 * r * r)));`)}&area=0.30` },
  // strictly periodic lattices of zone-plate cells
  { name: 'zonelattice_640x360', query: geo('vec2 q = mod(px, vec2(640.0, 360.0)) - vec2(320.0, 180.0); return vec3(lv(0.5 + 0.5 * cos(dot(q, q) * 0.0006)));') },
  { name: 'zonelattice_427x360', query: geo('vec2 q = mod(px, vec2(426.6667, 360.0)) - vec2(213.3333, 180.0); return vec3(lv(step(0.0, cos(dot(q, q) * 0.0008))));') },
  // FM bar trains (strictly periodic every L px, local period 15-60 px) and a sawtooth chirp train
  { name: 'fmsq_L480_T24_d0.025_a0', query: fm(480, 24, '1.90986', '0.0') },
  { name: 'fmsq_L480_T24_d0.03_a0', query: fm(480, 24, '2.29183', '0.0') },
  { name: 'fmsq_L480_T24_d0.025_a90', query: fm(480, 24, '1.90986', '90.0') },
  { name: 'fmsq_L480_T24_d0.025_a11.25', query: fm(480, 24, '1.90986', '11.25') },
  { name: 'fmsq_L640_T32_d0.02_a0', query: fm(640, 32, '2.03718', '0.0') },
  { name: 'fmsq_L480_T24_d0.03_a80', query: fm(480, 24, '2.29183', '80.0') },
  { name: 'fmsq_L600_T30_d0.022_a30', query: fm(600, 30, '2.10085', '30.0') },
  { name: 'saw_L400_a0', query: geo('float u = mod(px.x, 400.0); float ph = 0.025 * u + (0.083333 - 0.025) * u * u / 800.0; return vec3(lv(step(0.0, cos(6.2831853 * ph))));') },
  // amplitude-modulated / graded stripes (the compression must not keep the envelope's block contrast)
  { name: 'am_c13_e300_a30', query: geo('vec2 p = rot(px, 30.0); return vec3(lv(cw(p.x, 13.0) * cw(p.y, 300.0)));') },
  { name: 'sq25_slowsine', query: geo('float s = cw(rot(px, 30.0).x, 25.0); float g = cw(rot(px, 30.0).x, 600.0); return vec3(lv(0.35 * s + 0.65 * g));') },
  { name: 'grad_radial_sq13', query: geo('float s = sqw(rot(px, 45.0).x, 13.0); float g = clamp(length(c) / 600.0, 0.0, 1.0); return vec3(0.01 + 0.94 * g * s);') },
  // stripes around a black centre (flashcheck blocks mix compressed stripes with black)
  { name: 'ringblk_h', query: custom('vec2 d = abs(uv - 0.5); if (d.x < 0.3906 && d.y < 0.2778) return vec3(0.0); return vec3(0.05 + 0.9 * step(0.5, fract(uv.y * uRes.y / 14.0)));') },
  { name: 'ring30_thick', query: custom('vec2 d = abs(uv - 0.5); if (d.x < 0.4375 && d.y < 0.3) return vec3(0.0); return vec3(0.05 + 0.9 * step(0.5, fract((uv.x * uRes.x + uv.y * uRes.y) * 0.7071 / 12.0)));') },
  // geometry used by the product's looks
  { name: 'poincare_rings', query: custom('vec2 d = uv * uRes - 0.5 * uRes; float r = min(length(d) / 380.0, 0.999); float rho = log((1.0 + r) / (1.0 - r)); return length(d) > 380.0 ? vec3(0.0) : vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * rho / 0.35)));') },
  { name: 'persp_floor', query: custom('vec2 p = uv * uRes; float yh = 0.75 * uRes.y; if (p.y > yh - 2.0) return vec3(0.0); float z = 200.0 / (yh - p.y); float wx = (p.x - 0.5 * uRes.x) * z / 400.0; float wz = z * 60.0; return vec3(mod(floor(wx) + floor(wz), 2.0) < 0.5 ? 0.95 : 0.05);') },
  // range below the old 0.05 floor: saturated blue on black (Y 0.043), black / dark grey (Y 0.048)
  { name: 'blue060', query: custom('vec2 p = uv * uRes; return vec3(0.0, 0.0, 0.60 * step(0.5, fract(p.x / 20.0)));') },
  { name: 'darkgrey', query: custom('vec2 p = uv * uRes; return vec3(0.048 * step(0.5, fract(p.x / 20.0)));') },
  // an irregular bar code (8-px cells, black or white from an integer hash): aperiodic stripes
  { name: 'fp_randbars', query: custom('uint hh(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }\nvec3 pattern(vec2 uv, float t) { int c = int(floor(uv.x * uRes.x / 8.0)); return vec3(float(hh(uint(c) * 1973u ^ hh(3u + 40503u))) / 4294967295.0 > 0.5 ? 0.95 : 0.05); }') },
  // dynamic: drifting rings (1 Hz), drifting dark stripes, alternating zone plate / stripes, render scale 0.5
  { name: 'zp_drift1hz', dynamic: true, query: custom(`${ZP295} return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * (2.95e-5 * r * r - 1.0 * t))));`) },
  { name: 'darkgrey_drift', dynamic: true, query: custom('vec2 p = uv * uRes; return vec3(0.045 * step(0.5, fract((p.x - 30.0 * t) / 20.0)));') },
  { name: 'zp_alt_stripes12', dynamic: true, seconds: 6, query: custom(`vec2 p = uv * uRes; ${ZP295} if (mod(floor(t / 1.2), 2.0) < 0.5) return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 2.95e-5 * r * r))); return vec3(0.05 + 0.9 * step(0.5, fract(p.x / 20.0)));`) },
  { name: 'zp_scale05', dynamic: true, query: custom(`vec2 d = uv * uRes - 0.5 * uRes; float r = length(d) * (1280.0 / uRes.x); return vec3(0.05 + 0.9 * (0.5 + 0.5 * cos(6.2831853 * 2.95e-5 * r * r)));`),
    after: async (page) => { await page.waitForTimeout(500); await page.evaluate(() => (window as any).__pipeline.setRenderScale(0.5)); } },
];

for (const ev of EVASIONS) {
  test(`guard (S8b evasion): '${ev.name}' engages within 2 frames, stays on and passes flashcheck`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { info, fc } = await capture(page, baseURL, ev.name, ev.query, { seconds: ev.seconds, after: ev.after });
    const first = info.history.slice(0, 2);
    expect(first.length).toBe(2);
    expect(first.some((h) => h.patternGuard === 1), `patternGuard over the first 2 frames: ${JSON.stringify(first)}`).toBe(true);
    expect(info.history[1].highContrastFraction).toBeGreaterThan(0.2);
    const off = info.history.filter((h) => h.patternGuard < 1);
    expect(off.length, `guard below 1 on ${off.length} frames, first ${JSON.stringify(off[0])}`).toBe(0);
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.pattern_frames).toBe(0);
    if (!ev.dynamic) expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(0.5);
    expect(fc.report.max_red_flashes_per_s).toBeLessThanOrEqual(0.5);
  });
}

// ---- S8c: evasions of the S8b guard (adversarial review round 2, 2026-10-11) ------------------------
// Crossed chirps (two or three families of rings around centres off screen: an egg-crate / hex lattice whose
// cells grow across the screen), conformal lattices, plaids in a 30 % corner, a noisy zone plate, edge bands
// of three light-dark pairs, saturated colours the compression could not lift (gamut clamp), the limiter's
// own fade creating contrast (per-pixel slew), and the 8-bit range floor (NOTES.md S8c).
const chirp2 = (c0: string, c1: string, D: string, k: string, p: string, ret = 'return vec3(lv(s));', pre = ''): string => geo(
  `${pre}float d0 = length(c - vec2(${c0})) / ${D}; float f0 = ${k} * pow(d0, ${p}); float i0 = 1.0 / pow(d0, ${p} - 1.0); ` +
  `float d1 = length(c - vec2(${c1})) / ${D}; float f1 = ${k} * pow(d1, ${p}); float i1 = 1.0 / pow(d1, ${p} - 1.0); ` +
  `float s = 0.5 + 0.5 * (i0 * cos(f0) + i1 * cos(f1)) / (i0 + i1); ${ret}`);
const SW2 = ['-1181.8, -208.4', '208.4, -1181.8', '1200.0', '114.2398', '2.75'] as const;   // sw2_a190_p2.75_D1200_T24
const bc = (ret: string, pre = ''): string => chirp2(SW2[0], SW2[1], SW2[2], SW2[3], SW2[4], ret, pre);
const CORNER = 'if (px.x > 0.5477 * uRes.x || px.y < (1.0 - 0.5477) * uRes.y) return vec3(0.0); ';
const lpPlaid = (N: number, corner: boolean): string => geo(`${corner ? CORNER : ''}vec2 q = ${corner ? 'px - vec2(0.0, uRes.y)' : 'c'}; ` +
  `float r = length(q) + 1.0; float th = atan(q.y, q.x); return vec3(lv(0.5 + 0.25 * cos(${N}.0 * log(r)) + 0.25 * cos(${N}.0 * th)));`);
const GRAIN = `uint hh(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float h2(ivec2 p) { return float(hh(uint(p.x) * 1973u ^ hh(uint(p.y) + 40503u))) / 4294967295.0; }
float grain(vec2 px, float cell) { return 2.0 * h2(ivec2(floor(px / cell)) + ivec2(1000, 1000)) - 1.0; }`;
const stripes = (body: string): string => custom(`vec2 p = uv * uRes; ${body}`);
const FLICK = 'if (uv.x < 0.32) return vec3(fract(t * 4.0) < 0.5 ? 0.6 : 0.0); ';
/** guard: 'on' = on from frame 1-2 and never off; 'pattern' = on within 2 frames (the pattern later goes
 *  away, so the guard may release); 'off' = a LEGAL pattern, the guard must never engage. */
interface Evasion2 { name: string; query: string; guard: 'on' | 'pattern' | 'off' | 'alt'; dynamic?: boolean; seconds?: number }
const EVASIONS_S8C: Evasion2[] = [
  // crossed chirps (structure tensor incoherent, every profile a sum of chirps)
  { name: 'sw2_a190_p2.75_D1200_T24', guard: 'on', query: bc('return vec3(lv(s));') },
  { name: 'sw2_a190_p3.0_D1300_T24', guard: 'on', query: chirp2('-1280.3, -225.7', '225.7, -1280.3', '1300.0', '113.4462', '3.0') },
  { name: 'sw2_a210_p3.0_D1100_T28', guard: 'on', query: chirp2('-952.6, -550.0', '550.0, -952.6', '1100.0', '82.2797', '3.0') },
  { name: 'bc_red', guard: 'on', query: bc('return vec3(s, 0.0, 0.0);') },
  { name: 'bc_green_cc', guard: 'on', query: bc('return vec3(0.3, 0.05 + 0.9 * s, 0.3);') },
  { name: 'bc_sq', guard: 'on', query: bc('return vec3(lv(s > 0.5 ? 1.0 : 0.0));') },
  { name: 'bc_drift1hz', guard: 'on', dynamic: true, query: bc('return vec3(lv(s));', 'c += vec2(24.0 * t, 0.0); ') },
  { name: 'bc_corner30', guard: 'on', query: bc('return vec3(lv(s));', CORNER) },
  { name: 'trichirp_p4_D2200_T22', guard: 'on', query: geo('float d0 = length(c - vec2(-2200.0, 0.0)) / 2200.0; float d1 = length(c - vec2(1100.0, -1905.3)) / 2200.0; ' +
    'float d2 = length(c - vec2(1100.0, 1905.3)) / 2200.0; float i0 = 1.0 / pow(d0, 3.0); float i1 = 1.0 / pow(d1, 3.0); float i2 = 1.0 / pow(d2, 3.0); ' +
    'float k = 157.07945; float s = ((i0 * cos(k * pow(d0, 4.0)) + i1 * cos(k * pow(d1, 4.0)) + i2 * cos(k * pow(d2, 4.0))) / (i0 + i1 + i2) + 0.5) / 1.5; return vec3(lv(s));') },
  { name: 'bichirp_p4_D2200_T22_sq', guard: 'on', query: geo('float d0 = length(c - vec2(-2200.0, 0.0)) / 2200.0; float d1 = length(c - vec2(0.0, -2200.0)) / 2200.0; ' +
    'float g0 = pow(d0, 3.0); float g1 = pow(d1, 3.0); float k = 157.07945; ' +
    'float s = 0.5 + 0.5 * (g1 * cos(k * pow(d0, 4.0)) + g0 * cos(k * pow(d1, 4.0))) / (g0 + g1); return vec3(lv(s > 0.5 ? 1.0 : 0.0));') },
  // conformal lattices and plaids
  { name: 'z2hex_k0.0003', guard: 'on', query: geo('vec2 w = 0.0003 * vec2(c.x * c.x - c.y * c.y, 2.0 * c.x * c.y); ' +
    'float s = cos(w.x) + cos(dot(w, vec2(-0.5, 0.8660254))) + cos(dot(w, vec2(-0.5, -0.8660254))); return vec3(lv((s + 1.5) / 4.5));') },
  { name: 'zonehex_k0.0006', guard: 'on', query: geo('vec2 w = 0.0006 * length(c) * c; ' +
    'float s = cos(w.x) + cos(dot(w, vec2(-0.5, 0.8660254))) + cos(dot(w, vec2(-0.5, -0.8660254))); return vec3(lv((s + 1.5) / 4.5));') },
  { name: 'logpolar_plaid_N100', guard: 'on', query: lpPlaid(100, false) },
  { name: 'logpolar_plaid_N100_corner30', guard: 'on', query: lpPlaid(100, true) },
  { name: 'logpolar_plaid_N72_corner30', guard: 'on', query: lpPlaid(72, true) },
  // a zone plate under +-0.3 blocky grain (3-px cells)
  { name: 'zone_grain0.3_c3', guard: 'on', query: custom(`${GRAIN}\nvec3 pattern(vec2 uv, float t) { vec2 px = uv * uRes; vec2 c = px - 0.5 * uRes; ` +
    'float s = 0.5 + 0.5 * cos(0.0003 * dot(c, c)); return vec3(clamp(0.1 + 0.8 * s + 0.3 * grain(px, 3.0), 0.0, 1.0)); }') },
  // three light-dark pairs per edge band (20 % and 15 % of the height at the top and the bottom)
  { name: 'N_bands_tb20_h48', guard: 'on', query: stripes('if (abs(uv.y - 0.5) < 0.30) return vec3(0.0); return vec3(0.05 + 0.9 * step(0.5, fract(p.y / 48.0)));') },
  { name: 'N_bands_tb15_h36', guard: 'on', query: stripes('if (abs(uv.y - 0.5) < 0.35) return vec3(0.0); return vec3(0.05 + 0.9 * step(0.5, fract(p.y / 36.0)));') },
  { name: 'N_bands_tb15_h36_grey', guard: 'on', query: stripes('if (abs(uv.y - 0.5) < 0.35) return vec3(0.2); return vec3(0.05 + 0.9 * step(0.5, fract(p.y / 36.0)));') },
  // a 0.0212 range read back from 8 bits as 5/255 (below GUARD_RANGE_MIN)
  { name: 'N_quant_dark0212', guard: 'on', query: stripes('return vec3(0.0212 * step(0.5, fract(p.x / 20.0)));') },
  // saturated colours: the compression must reach the target luminance (desaturating, not clipping)
  { name: 'N_white_blue20', guard: 'on', query: stripes('return step(0.5, fract(p.x / 20.0)) > 0.5 ? vec3(1.0) : vec3(0.0, 0.0, 1.0);') },
  { name: 'N_cyan_blue_diag12', guard: 'on', query: stripes('return step(0.5, fract((p.x + p.y) * 0.70710678 / 12.0)) > 0.5 ? vec3(0.0, 1.0, 1.0) : vec3(0.0, 0.0, 1.0);') },
  { name: 'N_white_red20', guard: 'on', query: stripes('return step(0.5, fract(p.x / 20.0)) > 0.5 ? vec3(1.0) : vec3(1.0, 0.0, 0.0);') },
  { name: 'N_white_blue_sine_rings30', guard: 'on', query: custom('vec2 d = uv * uRes - 0.5 * uRes; float s = 0.5 + 0.5 * cos(6.2831853 * length(d) / 30.0); return mix(vec3(0.0, 0.0, 1.0), vec3(1.0), s);') },
  { name: 'N_white_blue_zoneplate', guard: 'on', query: custom('vec2 c = uv * uRes - 0.5 * uRes; return cos(dot(c, c) * 0.0003) > 0.0 ? vec3(1.0) : vec3(0.0, 0.0, 1.0);') },
  { name: 'N_white_blue_meancap', guard: 'on', query: stripes('return fract(p.x / 20.0) > 0.25 ? vec3(1.0) : vec3(0.0, 0.0, 1.0);') },
  { name: 'N_violet_lilac_drift1', guard: 'on', dynamic: true, query: stripes('float s = 0.5 + 0.5 * cos(6.2831853 * ((p.x + p.y) * 0.7071 / 24.0 - t)); return mix(vec3(0.15, 0.0, 1.0), vec3(1.0, 0.85, 1.0), s);') },
  { name: 'N_white_blue_drift19', guard: 'on', dynamic: true, query: stripes('return step(0.5, fract((p.x - 38.0 * t) / 20.0)) > 0.5 ? vec3(1.0) : vec3(0.0, 0.0, 1.0);') },
  // the backstop's fade must not create contrast (pattern switched off while a flicker keeps it engaged)
  { name: 'N_flicker_then_black', guard: 'pattern', dynamic: true, query: stripes('float s = 0.05 + 0.9 * step(0.5, fract(p.x / 20.0)); if (t < 1.0) return vec3(s); ' +
    'if (t < 1.4) return fract(t * 10.0) < 0.5 ? vec3(s) : vec3(0.0); return vec3(0.0);') },
  { name: 'N_flicker_then_dim', guard: 'pattern', dynamic: true, query: stripes('float s = 0.05 + 0.9 * step(0.5, fract(p.x / 20.0)); if (t < 1.0) return vec3(s); ' +
    'if (t < 1.4) return fract(t * 10.0) < 0.5 ? vec3(s) : vec3(0.0); return vec3(0.03);') },
  { name: 'N_flickerzone_pattern_off', guard: 'pattern', dynamic: true, query: stripes(`${FLICK}if (t < 2.0) return vec3(0.05 + 0.9 * step(0.5, fract((p.x + p.y) * 0.70710678 / 14.0))); return vec3(0.0);`) },
  { name: 'N_lowc_pattern_off_flicker', guard: 'off', dynamic: true, seconds: 7, query: stripes(`${FLICK}if (t < 2.0) return vec3(0.3 + 0.3 * step(0.5, fract((p.x + p.y) * 0.70710678 / 14.0))); return vec3(0.0);`) },
  { name: 'N_rings_fadeout_flicker', guard: 'pattern', dynamic: true, query: custom('vec2 d = uv * uRes - 0.5 * uRes; float a = clamp((2.3 - t) / 0.3, 0.0, 1.0); ' +
    'vec3 fl = vec3(fract(t * 4.0) < 0.5 ? 0.5 : 0.0); if (abs(d.x) > 0.36 * uRes.x) return fl; return vec3(a * (0.25 + 0.15 * cos(6.2831853 * length(d) / 30.0)));') },
  { name: 'N_frame_alt_black', guard: 'alt', dynamic: true, query: stripes('if (mod(floor(t * 60.0), 2.0) < 0.5) return vec3(0.0); return vec3(0.05 + 0.9 * step(0.5, fract(p.x / 20.0)));') },
];

for (const ev of EVASIONS_S8C) {
  test(`guard (S8c evasion): '${ev.name}' is caught (${ev.guard}) and passes flashcheck`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { info, fc } = await capture(page, baseURL, ev.name, ev.query, { seconds: ev.seconds });
    const first = info.history.slice(0, 2);
    expect(first.length).toBe(2);
    if (ev.guard === 'off') {
      const maxGuard = Math.max(...info.history.map((h) => h.patternGuard));
      expect(maxGuard, 'a legal (Michelson 0.33) pattern must not engage the guard').toBe(0);
    } else {
      expect(first.some((h) => h.patternGuard === 1), `patternGuard over the first 2 frames: ${JSON.stringify(first)}`).toBe(true);
      if (ev.guard === 'on') {
        expect(info.history[1].highContrastFraction).toBeGreaterThan(0.2);
        const off = info.history.filter((h) => h.patternGuard < 1);
        expect(off.length, `guard below 1 on ${off.length} frames, first ${JSON.stringify(off[0])}`).toBe(0);
      }
      if (ev.guard === 'alt') {   // pattern alternating with black frames (frame 1 is black): once on, the guard
        // only releases slowly on the black frames
        const on = info.history.findIndex((h) => h.patternGuard === 1);
        const low = info.history.slice(on).filter((h) => h.patternGuard < 0.9);
        expect(low.length, `guard below 0.9 on ${low.length} frames`).toBe(0);
      }
    }
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.pattern_frames).toBe(0);
    if (!ev.dynamic) expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(0.5);
    expect(fc.report.max_red_flashes_per_s).toBeLessThanOrEqual(0.5);
  });
}

for (const [pattern, query] of [['photo', 'pattern=photo'], ['blobs', 'pattern=blobs']] as const) {
  test(`guard: aperiodic '${pattern}' never engages the guard and reaches the screen unchanged`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const { dir, info, fc } = await capture(page, baseURL, pattern, query);
    expect(info.ready, 'pattern (photo texture) never became ready').toBe(true);
    expect(info.history.length).toBeGreaterThan(SECONDS * 20);
    const maxGuard = Math.max(...info.history.map((h) => h.patternGuard));
    const maxHi = Math.max(...info.history.map((h) => h.highContrastFraction));
    expect(maxGuard, `patternGuard must stay 0 (max highContrastFraction ${maxHi})`).toBe(0);
    expect(info.engagedCount).toBe(0);
    expect(fc.ok, fc.stdout).toBe(true);
    expect(fc.report.pattern_frames).toBe(0);
    // the limiter must leave aperiodic content untouched: compare the scene before and after it
    const cmp = await page.evaluate(async () => {
      const l = (window as any).__limiter;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const pre: string = l.capturePre(); const post: string = l.capturePost();
      const load = (src: string) => new Promise<ImageData>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const x = c.getContext('2d')!; x.drawImage(img, 0, 0); resolve(x.getImageData(0, 0, c.width, c.height));
        };
        img.src = src;
      });
      const [a, b] = await Promise.all([load(pre), load(post)]);
      let max = 0; let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        for (let k = 0; k < 3; k++) { const d = Math.abs(a.data[i + k] - b.data[i + k]); max = Math.max(max, d); sum += d; }
      }
      return { pre, post, w: a.width, h: a.height, w2: b.width, h2: b.height, max, mean: sum / (a.data.length * 0.75) };
    });
    fs.writeFileSync(path.join(dir, 'prelimiter.png'), Buffer.from(cmp.pre.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, 'postlimiter.png'), Buffer.from(cmp.post.split(',')[1], 'base64'));
    console.log(`${pattern}: pre vs post max |diff| ${cmp.max}, mean ${cmp.mean.toFixed(4)} (8-bit sRGB)`);
    expect([cmp.w, cmp.h]).toEqual([cmp.w2, cmp.h2]);
    expect(cmp.max, 'aperiodic content must not be altered by the limiter').toBeLessThanOrEqual(1);
  });
}

// ---- Flash backstop across window resizes (integrate-polish, 2026-10-11) -----------------------------
// attack-dynamics-r2 found that every resize reset the limiter's history, so the frame after a resize was
// shown unfiltered: bw10 with a resize every 150 ms reached 3.5 general flashes/s. The limiter now carries its
// output and EMA history over a resize (NOTES.md D-I13); the flicker must stay as limited as without resizes.
test('flash backstop: bw10 under a resize every 150 ms stays within the flash limit', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const after = async (p: Page) => {
    const t0 = Date.now();
    for (let i = 0; i < 28; i++) {
      const wait = 600 + 150 * i - (Date.now() - t0);
      if (wait > 0) await p.waitForTimeout(wait);
      await p.setViewportSize(i % 2 === 0 ? { width: 1272, height: 716 } : { width: 1280, height: 720 });
    }
  };
  const { fc } = await capture(page, baseURL, 'bw10_resize_storm', 'pattern=bw10', { after });
  expect(fc.ok, fc.stdout).toBe(true);
  expect(fc.report.max_general_flashes_per_s).toBeLessThanOrEqual(2.5);
  expect(fc.report.max_red_flashes_per_s).toBeLessThanOrEqual(0.5);
});
