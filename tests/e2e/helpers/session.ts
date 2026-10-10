// Helpers to drive a Hyperspace session from Playwright (tests/e2e/*.spec.ts).
import { expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type DoseStep = 'threshold' | 'light' | 'strong' | 'breakthrough';

/** Repository root (the directory containing BUILD.md), searched upwards from the cwd. */
export function repoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'BUILD.md'))) return d;
    d = path.dirname(d);
  }
  return process.cwd();
}

export function sessionsDir(): string {
  const env = process.env.HYPERSPACE_SESSIONS_DIR;
  return env ? path.resolve(repoRoot(), env) : path.join(repoRoot(), 'sessions');
}

export interface SessionUrlOptions {
  dose?: DoseStep;
  seed?: number;
  timewarp?: number;
  autofill?: string | null;
  gentle?: boolean;
  debug?: boolean;
  autostart?: boolean;
}

export function sessionUrl(o: SessionUrlOptions = {}): string {
  const q = new URLSearchParams();
  if (o.autostart !== false) q.set('autostart', '1');
  if (o.autofill !== null) q.set('autofill', o.autofill ?? 'neutral');
  if (o.dose) q.set('dose', o.dose);
  if (o.timewarp) q.set('timewarp', String(o.timewarp));
  if (o.seed !== undefined) q.set('seed', String(o.seed));
  if (o.gentle) q.set('gentle', '1');
  if (o.debug) q.set('debug', '1');
  return `/?${q.toString()}`;
}

export async function currentScreen(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__hyperspace?.screen ?? '');
}

/** Poll window.__hyperspace.screen until it equals `name` (or one of several names). */
export async function waitForScreen(page: Page, name: string | string[], timeout = 120_000): Promise<string> {
  const names = Array.isArray(name) ? name : [name];
  await expect.poll(() => currentScreen(page), { timeout, intervals: [100, 250, 500] }).toMatch(new RegExp(`^(${names.join('|')})$`));
  return currentScreen(page);
}

export async function acceptSafety(page: Page): Promise<void> {
  await waitForScreen(page, 'safety', 30_000);
  const cont = page.getByTestId('safety-continue');
  await expect(cont).toBeDisabled();
  await page.getByTestId('safety-checkbox').check({ force: true });
  await expect(cont).toBeEnabled();
  await cont.click();
}

export interface IntakeOverrides {
  clarity?: number;
  set?: number;
  absorption?: [number, number, number];
  surrender?: number;
  intention?: 'curiosity' | 'recreation' | 'reflection' | 'spiritual';
  expectations?: string[];
  dose?: DoseStep;
  difficult?: boolean;
}

/**
 * Complete the intake. With ?autofill the screens advance on their own; we only wait for them.
 * Without autofill, `overrides` are entered with the keyboard, screen by screen.
 */
export async function fillIntake(page: Page, overrides: IntakeOverrides | null = null, timeout = 60_000): Promise<void> {
  await waitForScreen(page, 'intake', 30_000);
  if (overrides) {
    const o = overrides;
    const next = () => page.keyboard.press('Enter');
    const step = async (n: number) => expect(page.locator(`[data-screen=intake][data-step="${n}"]`)).toBeVisible();
    const slider = async (n: number, v: number | undefined, min: number) => {
      await step(n);
      if (v !== undefined) {
        // number keys set min + digit; arrows reach the top of the scale
        const k = Math.min(9, v - min);
        await page.keyboard.press(String(k));
        for (let i = k; i < v - min; i++) await page.keyboard.press('ArrowRight');
      }
      await next();
    };
    await step(1);
    await page.keyboard.press('3'); // default room
    await next();
    await slider(2, o.clarity, 0);
    await slider(3, o.set, -5);
    await slider(4, o.absorption?.[0], 0);
    await slider(5, o.absorption?.[1], 0);
    await slider(6, o.absorption?.[2], 0);
    await slider(7, o.surrender, 0);
    await step(8);
    if (o.intention) await page.getByTestId(`intake-option-${o.intention}`).click();
    await next();
    await step(9);
    for (const e of o.expectations ?? []) await page.getByTestId(`intake-option-${e}`).click();
    await next();
    await step(10);
    if (o.dose) await page.getByTestId(`intake-option-${o.dose}`).click();
    await next();
    await step(11);
    if (o.difficult === false) await page.getByTestId('intake-option-difficult').click();
    await next();
  }
  await expect.poll(() => currentScreen(page), { timeout }).not.toBe('intake');
}

/** Wait for the settling screen to finish (assets ready and models unloaded): the hit screen. */
export async function waitReady(page: Page, timeout = 5 * 60_000): Promise<void> {
  await waitForScreen(page, 'hit', timeout);
}

/** Hold the on-screen hit button with the pointer for `holdMs` of wall-clock time. */
export async function takeHit(page: Page, holdMs = 4000): Promise<void> {
  const btn = page.getByTestId('hit-button');
  await btn.hover();
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
  await waitForScreen(page, ['trip', 'fade', 'grounding', 'curve', 'end'], 15_000);
}

export const DEFAULT_CURVE: [number, number][] = [[0, 0], [0.5, 4], [1.5, 7], [3, 5], [6, 2], [10, 0.5], [30, 0]];

/** On the curve screen: draw `points` programmatically, press Done, then continue. */
export async function drawCurve(page: Page, points: [number, number][] = DEFAULT_CURVE, timeout = 5 * 60_000): Promise<void> {
  await waitForScreen(page, 'curve', timeout);
  await page.evaluate((pts) => (window as any).__hyperspace.drawCurve(pts), points);
  await page.getByTestId('curve-done').click();
  await expect(page.getByTestId('curve-result')).toContainText('PEAK TIME');
  await page.keyboard.press('Enter');
}

export async function events(page: Page): Promise<{ t_min: number; type: string; payload: Record<string, any> }[]> {
  return page.evaluate(() => (window as any).__hyperspace.events?.all ?? []);
}

/** The session id printed on the end screen (SAVED TO sessions/<id>/). */
export async function sessionIdFromEndScreen(page: Page): Promise<string> {
  await expect(page.getByTestId('saved-to')).toBeVisible({ timeout: 60_000 });
  const t = (await page.getByTestId('saved-to').textContent()) ?? '';
  const m = /sessions\/([^/\s]+)\//.exec(t);
  if (!m) throw new Error(`no session id in "${t}"`);
  return m[1];
}

export async function waitForReport(page: Page, id: string, timeout = 10 * 60_000): Promise<void> {
  await expect.poll(async () => {
    const r = await page.request.get(`/api/session/${id}/report_status`);
    if (!r.ok()) return 'http';
    const j = await r.json();
    if (j.stage === 'error') throw new Error(`report error: ${j.error}`);
    return j.done ? 'done' : j.stage;
  }, { timeout, intervals: [1000, 2000] }).toBe('done');
}

/** Run a complete session to the end screen; returns the session id and the in-memory events. */
export async function runSession(page: Page, o: SessionUrlOptions & { holdMs?: number; curve?: [number, number][] }) {
  await page.goto(sessionUrl(o));
  await acceptSafety(page);
  await fillIntake(page);
  await waitReady(page);
  await takeHit(page, o.holdMs ?? 4000);
  await waitForScreen(page, 'grounding', 15 * 60_000);
  const evs = await events(page);
  await drawCurve(page, o.curve);
  await waitForScreen(page, 'end', 60_000);
  await expect(page.getByTestId('end-screen')).toBeVisible();
  const id = await sessionIdFromEndScreen(page);
  return { id, events: evs };
}
