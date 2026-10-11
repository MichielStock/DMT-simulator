// The one-screen setup (frontend/src/ui/setup.ts, NOTES D-S1): state → Intake mapping.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultIntake, loadProfile, PROFILES, type Intake } from '../src/profiles';
import {
  DETAIL_ROWS, DOSE_CARDS, isPanoramaSize, MODE_GENTLE, MODE_ON, mountSetup, stepDose, type SetupResult,
} from '../src/ui/setup';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
});
afterEach(() => { document.body.innerHTML = ''; });

const key = (k: string, extra: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ...extra }));
const keys = (...ks: string[]) => ks.forEach((k) => key(k));
const tick = () => new Promise((r) => setTimeout(r, 0));
const tid = (id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;

function start(intake: Intake = defaultIntake(7), autofill = false): Promise<SetupResult> {
  intake.room = { source: 'default', image: null, depth: null };
  return mountSetup(root, { sessionId: null, intake, autofill, autofillDelayMs: 10 });
}

/** Keys as JSON-schema-relevant fields; the posted object must keep the exact intake schema. */
const SCHEMA_KEYS = ['version', 'room', 'answers', 'dose_step', 'hold_fraction', 'options', 'seed'].sort();

describe('setup screen: defaults', () => {
  it('Enter alone begins with the neutral profile, strong dose, difficult passages on, default room', async () => {
    const p = start();
    expect(root.querySelector('[data-screen="intake"]')).not.toBeNull();
    key('Enter');
    const r = await p as Intake;
    expect(r).not.toBe('title');
    expect(Object.keys(r).sort()).toEqual(SCHEMA_KEYS);
    expect(r.dose_step).toBe('strong');
    expect(r.options).toEqual({ difficult_passages: true, eyes: 'auto', audio: true, microphone: false, live_diffusion: false });
    expect(r.answers).toEqual({ clarity: 5, set: 0, absorption: [5, 5, 5], surrender: 5, intention: 'curiosity', expectations: [] });
    expect(r.room).toEqual({ source: 'default', image: null, depth: null });
    expect(r.seed).toBe(7);
  });

  it('a held Enter (key repeat) does not begin', async () => {
    let done = false;
    const p = start().then((r) => { done = true; return r; });
    key('Enter', { repeat: true });
    await tick();
    expect(done).toBe(false);
    key('Enter');
    await p;
  });

  it('Escape returns to the title', async () => {
    const p = start();
    key('Escape');
    expect(await p).toBe('title');
  });
});

describe('setup screen: dose and mode', () => {
  it('[1]-[4] choose the dose step; the chosen card is selected', async () => {
    for (const [i, c] of DOSE_CARDS.entries()) {
      const p = start();
      key(String(i + 1));
      expect(tid(`intake-option-${c.value}`).classList.contains('selected')).toBe(true);
      expect(root.querySelectorAll('.card.selected')).toHaveLength(1);
      key('Enter');
      expect(((await p) as Intake).dose_step).toBe(c.value);
    }
  });

  it('arrows step the dose without wrapping', async () => {
    const p = start();
    keys('ArrowRight', 'ArrowRight', 'ArrowRight');
    expect(tid('intake-option-breakthrough').classList.contains('selected')).toBe(true);
    keys('ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft');
    key('Enter');
    expect(((await p) as Intake).dose_step).toBe('threshold');
    const i = defaultIntake(1);
    stepDose(i, 1);
    expect(i.dose_step).toBe('breakthrough');
  });

  it('clicking a card chooses it', async () => {
    const p = start();
    tid('intake-option-light').click();
    key('Enter');
    expect(((await p) as Intake).dose_step).toBe('light');
  });

  it('[G] toggles gentle mode (difficult_passages false) and back', async () => {
    const p = start();
    expect(tid('intake-option-difficult').textContent).toBe(MODE_ON);
    key('g');
    expect(tid('intake-option-difficult').textContent).toBe(MODE_GENTLE);
    key('Enter');
    expect(((await p) as Intake).options.difficult_passages).toBe(false);
    const p2 = start();
    keys('G', 'G', 'Enter');
    expect(((await p2) as Intake).options.difficult_passages).toBe(true);
  });

  it('[X] keeps the built-in room; without a back end nothing is uploaded', async () => {
    const p = start();
    key('x');
    expect(tid('room-status').textContent).toMatch(/BUILT-IN ROOM/);
    key('Enter');
    expect(((await p) as Intake).room.source).toBe('default');
  });
});

describe('details sub-screen', () => {
  it('[D] opens the details; Enter returns to setup keeping the answers; every 8.2 variable is settable', async () => {
    const p = start();
    key('d');
    expect(root.querySelector('[data-view="details"]')).not.toBeNull();
    // row order: clarity, set, absorption×3, surrender, intention, expectations, eyes, audio, microphone
    key('9');                                   // clarity 9
    key('ArrowDown'); key('0'); key('ArrowLeft'); // set: digit 0 → -5, left clamps at -5
    key('ArrowDown'); key('2');                  // absorption[0] 2
    key('ArrowDown'); key('ArrowRight'); key('ArrowRight'); // absorption[1] 7
    key('ArrowDown'); key('1'); key('ArrowLeft'); // absorption[2] 0
    key('ArrowDown'); key('9'); key('ArrowRight'); key('ArrowRight'); // surrender 10 (clamped)
    key('ArrowDown'); key('3');                  // intention reflection
    key('ArrowDown'); key('1'); key('4'); key('ArrowRight'); key(' '); // jesters, luminous_feminine, insectoid
    key('ArrowDown'); key('3');                  // eyes closed
    key('ArrowDown'); key('ArrowRight');         // sound off
    key('ArrowDown'); key(' ');                  // microphone on
    expect(tid('intake-slider-clarity').getAttribute('data-value')).toBe('9');
    key('Enter');
    expect(root.querySelector('[data-view="setup"]')).not.toBeNull();
    key('Enter');
    const r = await p as Intake;
    expect(r.answers).toEqual({ clarity: 9, set: -5, absorption: [2, 7, 0], surrender: 10, intention: 'reflection',
      expectations: ['jesters', 'luminous_feminine', 'insectoid'] });
    expect(r.options).toEqual({ difficult_passages: true, eyes: 'closed', audio: false, microphone: true, live_diffusion: false });
  });

  it('Escape in the details goes back to setup (not to the title)', async () => {
    let res: SetupResult | null = null;
    const p = start().then((r) => { res = r; return r; });
    key('d');
    key('Escape');
    await tick();
    expect(res).toBeNull();
    expect(root.querySelector('[data-view="setup"]')).not.toBeNull();
    key('Enter');
    expect(await p).not.toBe('title');
  });

  it('"none of these" clears the motifs; mouse clicks on chips and slider cells work', async () => {
    const p = start();
    key('d');
    tid('intake-option-aliens').click();
    tid('intake-option-machine_elves').click();
    (root.querySelector('[data-testid="intake-slider-set"] .cell[data-v="3"]') as HTMLElement).click();
    tid('intake-option-recreation').click();
    tid('intake-option-eyes-open').click();
    let r = p;
    key('Enter'); key('Enter');
    let out = await r as Intake;
    expect(out.answers.expectations).toEqual(['aliens', 'machine_elves']);
    expect(out.answers.set).toBe(3);
    expect(out.answers.intention).toBe('recreation');
    expect(out.options.eyes).toBe('open');

    r = start();
    key('d');
    tid('intake-option-aliens').click();
    tid('intake-option-none').click();
    key('Enter'); key('Enter');
    out = await r as Intake;
    expect(out.answers.expectations).toEqual([]);
  });

  it('covers every hidden variable of BUILD.md 8.2 and the 8.3 options', () => {
    const keysCovered = DETAIL_ROWS.map((r) => r.key);
    for (const k of ['clarity', 'set', 'absorption0', 'absorption1', 'absorption2', 'surrender', 'intention', 'expectations', 'eyes', 'audio', 'microphone']) {
      expect(keysCovered).toContain(k);
    }
  });
});

describe('autofill', () => {
  it('begins on its own with the profile (and its URL overrides)', async () => {
    const prof = loadProfile('gentle', { dose: 'breakthrough', gentle: true }, 11)!;
    const r = await mountSetup(root, { sessionId: null, intake: prof, autofill: true, autofillDelayMs: 10 }) as Intake;
    expect(r.dose_step).toBe('breakthrough');
    expect(r.options.difficult_passages).toBe(false);
    expect(r.answers).toEqual(PROFILES.gentle.answers);
    expect(r.seed).toBe(11);
  });
});

describe('panorama detection', () => {
  it('a 2:1 image (±5 %) is a panorama', () => {
    expect(isPanoramaSize(4096, 2048)).toBe(true);
    expect(isPanoramaSize(2000, 1040)).toBe(true);
    expect(isPanoramaSize(1920, 1080)).toBe(false);
    expect(isPanoramaSize(1000, 0)).toBe(false);
  });
});
