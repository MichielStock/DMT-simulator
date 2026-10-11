// Setup (BUILD.md sections 8 and 15.4, simplified at the user's request; NOTES D-S1..D-S4): ONE screen
// with the dose, gentle mode and the room, plus an optional DETAILS sub-screen with the seven
// questionnaire items, the intention, the motifs and the eyes / sound / microphone options.
// Defaults are the neutral profile, so [ENTER] alone begins a session. The Intake posted to the back
// end keeps its exact schema. ?autofill=<profile> renders the screen with the profile and begins after
// ~50 ms. The screen name stays 'intake' (window.__hyperspace.screen) for the tests.

import { api, sessionAssetUrl, type DoseStep } from '../api';
import type { Expectation, Intake, Intention } from '../profiles';
import { h, onKey, screen, sleep } from './dom';

export interface SetupCtx {
  sessionId: string | null;
  /** initial values (neutral defaults or an autofill profile); mutated and returned */
  intake: Intake;
  autofill: boolean;
  /** delay before an autofilled setup begins on its own (ms) */
  autofillDelayMs?: number;
}

export type SetupResult = Intake | 'title';

export const SETUP_PROMISE = 'ABOUT TEN MINUTES · ESCAPE ALWAYS BRINGS YOU BACK';

export const DOSE_CARDS: { value: DoseStep; label: string; hint: string }[] = [
  { value: 'threshold', label: 'THRESHOLD', hint: 'A shimmer at the edges.' },
  { value: 'light', label: 'LIGHT', hint: 'Patterns and colour.' },
  { value: 'strong', label: 'STRONG', hint: 'Deep geometry.' },
  { value: 'breakthrough', label: 'BREAKTHROUGH', hint: 'Through to the other side.' },
];

export const MODE_ON = 'DIFFICULT PASSAGES ON';
export const MODE_GENTLE = 'GENTLE · NO DIFFICULT PASSAGES';
export const MODE_NOTE_ON = 'Real experiences can turn frightening. Turn this off for a gentle session.';
export const MODE_NOTE_GENTLE = 'A calm session: no difficult passages, start to finish.';
export const ROOM_PROMPT = 'DROP A PHOTO OF WHERE YOU ARE SITTING, OR [O] TO CHOOSE';
export const ROOM_PRIVACY = 'THE PHOTO NEVER LEAVES THIS MACHINE';
export const ROOM_STORED = 'STORED LOCALLY · METADATA REMOVED';

// ---------------------------------------------------------------------------------------------
// details: every hidden variable of BUILD.md 8.2 plus the 8.3 options (exact question wording, 15.4)

export type SliderRow = {
  kind: 'slider'; key: string; q: string; min: number; max: number; lo: string; hi: string;
  get: (i: Intake) => number; set: (i: Intake, v: number) => void;
};
export type ChoiceRow = {
  kind: 'choice'; key: string; q: string; note?: string; below: boolean;
  options: { value: string; label: string }[];
  get: (i: Intake) => string; set: (i: Intake, v: string) => void;
};
export type MultiRow = {
  kind: 'multi'; key: string; q: string; options: { value: string; label: string }[];
};
export type DetailRow = SliderRow | ChoiceRow | MultiRow;

const SAME = { lo: 'NOT AT ALL', hi: 'COMPLETELY' };
const EYES = ['auto', 'open', 'closed'] as const;

export const DETAIL_ROWS: DetailRow[] = [
  { kind: 'slider', key: 'clarity', q: 'How clear is your intention for this session?', min: 0, max: 10, lo: 'NO IDEA', hi: 'VERY CLEAR',
    get: (i) => i.answers.clarity, set: (i, v) => { i.answers.clarity = v; } },
  { kind: 'slider', key: 'set', q: 'How do you feel right now?', min: -5, max: 5, lo: 'LOW', hi: 'GREAT',
    get: (i) => i.answers.set, set: (i, v) => { i.answers.set = v; } },
  { kind: 'slider', key: 'absorption0', q: 'I can get completely lost in music or a film.', min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[0], set: (i, v) => { i.answers.absorption[0] = v; } },
  { kind: 'slider', key: 'absorption1', q: 'Vivid images come easily when I close my eyes.', min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[1], set: (i, v) => { i.answers.absorption[1] = v; } },
  { kind: 'slider', key: 'absorption2', q: "I lose track of my surroundings when I'm absorbed.", min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[2], set: (i, v) => { i.answers.absorption[2] = v; } },
  { kind: 'slider', key: 'surrender', q: 'Right now I feel…', min: 0, max: 10, lo: 'PREOCCUPIED', hi: 'READY TO LET GO',
    get: (i) => i.answers.surrender, set: (i, v) => { i.answers.surrender = v; } },
  { kind: 'choice', key: 'intention', q: 'What brings you here?', below: true, options: [
    { value: 'curiosity', label: 'CURIOSITY' }, { value: 'recreation', label: 'RECREATION' },
    { value: 'reflection', label: 'REFLECTION' }, { value: 'spiritual', label: 'SPIRITUAL' }],
    get: (i) => i.answers.intention, set: (i, v) => { i.answers.intention = v as Intention; } },
  { kind: 'multi', key: 'expectations', q: 'Which of these have you seen in videos, art or stories?', options: [
    { value: 'jesters', label: 'JESTERS' }, { value: 'machine_elves', label: 'MACHINE ELVES' },
    { value: 'aliens', label: 'ALIENS' }, { value: 'luminous_feminine', label: 'LUMINOUS FEMININE FIGURES' },
    { value: 'insectoid', label: 'INSECTOID BEINGS' }, { value: 'none', label: 'NONE OF THESE' }] },
  { kind: 'choice', key: 'eyes', q: 'Eyes', note: 'AUTO CLOSES THEM AS IT DEEPENS · [E] TOGGLES', below: false,
    options: EYES.map((e) => ({ value: e, label: e.toUpperCase() })),
    get: (i) => i.options.eyes, set: (i, v) => { i.options.eyes = v as Intake['options']['eyes']; } },
  { kind: 'choice', key: 'audio', q: 'Sound', below: false, options: [{ value: 'on', label: 'ON' }, { value: 'off', label: 'OFF' }],
    get: (i) => (i.options.audio ? 'on' : 'off'), set: (i, v) => { i.options.audio = v === 'on'; } },
  { kind: 'choice', key: 'microphone', q: 'Microphone', note: 'ROOM SOUND SHAPES THE VISUALS', below: false,
    options: [{ value: 'off', label: 'OFF' }, { value: 'on', label: 'ON' }],
    get: (i) => (i.options.microphone ? 'on' : 'off'), set: (i, v) => { i.options.microphone = v === 'on'; } },
];

/** Motif selection helpers (empty list = "none of these"). */
export function motifSelected(i: Intake, v: string): boolean {
  return v === 'none' ? i.answers.expectations.length === 0 : i.answers.expectations.includes(v as Expectation);
}
export function toggleMotif(i: Intake, v: string): void {
  const ex = i.answers.expectations;
  if (v === 'none') { ex.length = 0; return; }
  const k = ex.indexOf(v as Expectation);
  if (k >= 0) ex.splice(k, 1); else ex.push(v as Expectation);
}

export function setSlider(row: SliderRow, i: Intake, v: number): void {
  row.set(i, Math.max(row.min, Math.min(row.max, Math.round(v))));
}

/** Step the dose by d (no wrap). */
export function stepDose(i: Intake, d: number): void {
  const k = DOSE_CARDS.findIndex((c) => c.value === i.dose_step);
  i.dose_step = DOSE_CARDS[Math.max(0, Math.min(DOSE_CARDS.length - 1, (k < 0 ? 2 : k) + d))].value;
}

/** A 2:1 (±5 %) image is a phone panorama (BUILD.md 8.1; the back end applies the same rule). */
export function isPanoramaSize(w: number, h: number): boolean {
  return h > 0 && Math.abs(w / h - 2) <= 0.1;
}

function imageSize(f: Blob): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') { resolve(null); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;

// ---------------------------------------------------------------------------------------------

export function mountSetup(root: HTMLElement, ctx: SetupCtx): Promise<SetupResult> {
  const intake = ctx.intake;
  // room state survives switching between the setup and details views
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', 'data-testid': 'room-file' }) as HTMLInputElement;
  let thumbUrl: string | null = intake.room.image && ctx.sessionId ? sessionAssetUrl(ctx.sessionId, intake.room.image) : null;
  let roomStatus = intake.room.source !== 'default' ? ROOM_STORED : '';
  let uploading: Promise<void> | null = null;
  let uploadGen = 0;
  let refreshRoom: () => void = () => {};
  let view: 'setup' | 'details' = 'setup';
  let detailFocus = 0;
  let chipFocus = 0;
  let finished = false;

  return new Promise((resolve) => {
    const finish = (r: SetupResult) => {
      if (finished) return;
      finished = true;
      resolve(r);
    };
    const begin = async () => {
      if (finished) return;
      if (uploading) {
        roomStatus = 'UPLOADING… ONE MOMENT';
        refreshRoom();
        await uploading;
      }
      finish(intake);
    };

    const removeRoom = () => {
      uploadGen++;
      uploading = null;
      intake.room = { source: 'default', image: null, depth: null };
      thumbUrl = null;
      roomStatus = '';
      refreshRoom();
    };

    const handleFile = async (f: File | undefined | null) => {
      if (!f) return;
      if (f.type && !f.type.startsWith('image/')) { roomStatus = 'THAT IS NOT AN IMAGE · TRY A JPG OR PNG'; refreshRoom(); return; }
      const gen = ++uploadGen;
      thumbUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : null; // local preview first
      roomStatus = 'UPLOADING…';
      refreshRoom();
      if (!ctx.sessionId) {
        intake.room = { source: 'default', image: null, depth: null };
        thumbUrl = null;
        roomStatus = 'BACK END OFFLINE · USING THE BUILT-IN ROOM';
        refreshRoom();
        return;
      }
      const sid = ctx.sessionId;
      uploading = (async () => {
        const size = await imageSize(f);
        const kind = size && isPanoramaSize(size.w, size.h) ? 'panorama' : 'photo';
        try {
          const r = await api.uploadRoom(sid, f, kind);
          if (gen !== uploadGen) return;
          const source = r.source === 'panorama' ? 'panorama' : 'photo';
          intake.room = { source, image: r.image, depth: r.depth ?? null };
          thumbUrl = sessionAssetUrl(sid, r.image) + `?t=${Date.now()}`;
          roomStatus = (source === 'panorama' ? 'PANORAMA · ' : '') + ROOM_STORED;
        } catch {
          if (gen !== uploadGen) return;
          intake.room = { source: 'default', image: null, depth: null };
          thumbUrl = null;
          roomStatus = 'COULD NOT READ THAT IMAGE · USING THE BUILT-IN ROOM';
        }
      })();
      const mine = uploading;
      await mine;
      if (uploading === mine) uploading = null;
      if (gen === uploadGen) refreshRoom();
    };
    file.addEventListener('change', () => { void handleFile(file.files?.[0]); file.value = ''; });
    const choose = () => { if (!ctx.autofill) file.click(); };

    // ---------------- setup view ----------------
    function renderSetup(): void {
      view = 'setup';
      const el = screen(root, 'intake', 'setup');
      el.setAttribute('data-view', 'setup');
      el.setAttribute('data-testid', 'setup-screen');

      // DOSE: four boxed cards
      const cards = DOSE_CARDS.map((c, i) => h('div', {
        class: 'card', role: 'radio', 'data-testid': `intake-option-${c.value}`, 'data-value': c.value,
        onclick: () => { intake.dose_step = c.value; draw(); },
      }, h('div', { class: 'card-key' }, `[${i + 1}]`), h('div', { class: 'card-label' }, c.label), h('div', { class: 'card-hint' }, c.hint)));

      // MODE: one toggle
      const mode = h('button', { class: 'toggle', 'data-testid': 'intake-option-difficult',
        onclick: () => { intake.options.difficult_passages = !intake.options.difficult_passages; draw(); } });
      const modeNote = h('div', { class: 'note' });

      // ROOM: drop zone
      const thumbBox = h('div', { class: 'drop-thumb' });
      const status = h('div', { class: 'drop-status', 'data-testid': 'room-status' });
      const remove = h('button', { class: 'key small', 'data-testid': 'room-remove', onclick: (e: Event) => { e.stopPropagation(); removeRoom(); } }, '[X] REMOVE');
      const prompt = h('div', { class: 'drop-prompt' }, ROOM_PROMPT, h('div', { class: 'drop-privacy' }, ROOM_PRIVACY));
      const zone = h('div', { class: 'dropzone', 'data-testid': 'room-drop', role: 'button', onclick: () => choose() },
        thumbBox, h('div', { class: 'drop-text' }, prompt, status, remove));

      const details = h('button', { class: 'key dim-key', 'data-testid': 'intake-details', onclick: () => renderDetails() },
        '[D] MORE QUESTIONS · OPTIONAL');
      const beginBtn = h('button', { class: 'key primary', 'data-testid': 'intake-next', onclick: () => void begin() }, '[ENTER] BEGIN');
      const titleBtn = h('button', { class: 'key', 'data-testid': 'intake-title', onclick: () => finish('title') }, '[ESC] TITLE');

      const label = (t: string, hint: string) => h('div', { class: 'row-label' }, h('div', {}, t), h('div', { class: 'row-hint' }, hint));
      el.appendChild(h('div', { class: 'panel setup-panel' },
        h('div', { class: 'panel-title' }, ' NEW SESSION '),
        h('div', { class: 'promise setup-promise' }, SETUP_PROMISE),
        h('div', { class: 'setup-grid' },
          label('DOSE', '[1]-[4]'), h('div', { class: 'cards' }, ...cards),
          label('MODE', '[G]'), h('div', {}, mode, modeNote),
          label('ROOM', '[O] [X]'), zone,
          h('div', {}), h('div', {}, details),
        ),
        h('div', { class: 'actions' }, beginBtn, titleBtn),
      ));
      el.appendChild(file);

      const draw = () => {
        cards.forEach((c, i) => {
          const on = DOSE_CARDS[i].value === intake.dose_step;
          c.classList.toggle('selected', on);
          c.setAttribute('aria-checked', String(on));
        });
        const gentle = !intake.options.difficult_passages;
        mode.textContent = gentle ? MODE_GENTLE : MODE_ON;
        mode.classList.toggle('gentle', gentle);
        mode.setAttribute('aria-pressed', String(gentle));
        modeNote.textContent = gentle ? MODE_NOTE_GENTLE : MODE_NOTE_ON;
      };
      refreshRoom = () => {
        if (view !== 'setup') return;
        const has = !!thumbUrl;
        thumbBox.replaceChildren(has ? h('img', { class: 'thumb', src: thumbUrl!, alt: 'your room', 'data-testid': 'room-thumb' })
          : h('div', { class: 'thumb-empty' }, '┌────┐\n│/\\/\\│\n└────┘'));
        zone.classList.toggle('has-photo', has);
        prompt.classList.toggle('hidden', has);
        status.textContent = roomStatus || (has ? '' : 'NOTHING DROPPED · THE BUILT-IN ROOM IS FINE');
        status.classList.toggle('ok', roomStatus.endsWith(ROOM_STORED));
        remove.classList.toggle('hidden', !has);
      };
      draw();
      refreshRoom();

      // drag and drop anywhere on the screen lands in the zone
      let depth = 0;
      el.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('over'); });
      el.addEventListener('dragover', (e) => { e.preventDefault(); });
      el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('over'); });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        zone.classList.remove('over');
        void handleFile((e as DragEvent).dataTransfer?.files?.[0]);
      });

      onKey((e) => {
        if (!plain(e) || finished) return;
        const k = e.key;
        if (k >= '1' && k <= '4') { intake.dose_step = DOSE_CARDS[Number(k) - 1].value; draw(); }
        else if (k === 'ArrowLeft') stepDose(intake, -1), draw();
        else if (k === 'ArrowRight') stepDose(intake, 1), draw();
        else if (k === 'g' || k === 'G') { intake.options.difficult_passages = !intake.options.difficult_passages; draw(); }
        else if (k === 'o' || k === 'O') choose();
        else if (k === 'x' || k === 'X') removeRoom();
        else if (k === 'd' || k === 'D') renderDetails();
        else if (k === 'Enter') { if (!e.repeat) void begin(); }
        else if (k === 'Escape') finish('title');
        else return;
        e.preventDefault();
      });
    }

    // ---------------- details view ----------------
    function renderDetails(): void {
      view = 'details';
      const el = screen(root, 'intake', 'setup');
      el.setAttribute('data-view', 'details');
      el.setAttribute('data-testid', 'details-screen');

      const rowEls: HTMLElement[] = [];
      const redraws: (() => void)[] = [];
      DETAIL_ROWS.forEach((row, ri) => {
        const marker = h('span', { class: 'marker' });
        const q = h('div', { class: 'q' }, row.q.toUpperCase(),
          row.kind === 'choice' && row.note ? h('span', { class: 'note' }, row.note) : null);
        const r = h('div', { class: `drow k-${row.kind}`, 'data-testid': `detail-${row.key}`, onclick: () => { detailFocus = ri; drawFocus(); } }, marker, q);
        if (row.kind === 'slider') {
          const fmt = (v: number) => (row.min < 0 && v > 0 ? `+${v}` : String(v));
          const bar = h('span', { class: 'slider', 'data-testid': `intake-slider-${row.key}`, role: 'slider',
            'aria-valuemin': row.min, 'aria-valuemax': row.max });
          const value = h('span', { class: 'val' });
          r.append(h('span', { class: 'lo' }, row.lo), bar, h('span', { class: 'hi' }, row.hi), value);
          redraws.push(() => {
            const v = row.get(intake);
            bar.setAttribute('aria-valuenow', String(v));
            bar.setAttribute('data-value', String(v));
            const cells: Node[] = [];
            for (let x = row.min; x <= row.max; x++) {
              cells.push(h('span', { class: 'cell', 'data-v': x, onclick: () => { setSlider(row, intake, x); redraw(); } }, x <= v ? '■' : '□'));
            }
            bar.replaceChildren('[', ...cells, ']');
            value.textContent = fmt(v);
          });
        } else {
          const ctrl = h('div', { class: `chips ${row.kind === 'choice' && !row.below ? 'inline' : 'below'}` });
          const chips = row.options.map((o, oi) => h('span', {
            class: 'chip', role: row.kind === 'multi' ? 'checkbox' : 'radio',
            'data-testid': row.kind === 'multi' || row.key === 'intention' ? `intake-option-${o.value}` : `intake-option-${row.key}-${o.value}`,
            'data-value': o.value,
            onclick: (e: Event) => {
              e.stopPropagation();
              detailFocus = ri;
              if (row.kind === 'multi') { chipFocus = oi; toggleMotif(intake, o.value); } else row.set(intake, o.value);
              redraw();
            },
          }));
          ctrl.append(...chips);
          r.append(ctrl);
          redraws.push(() => {
            chips.forEach((c, oi) => {
              const o = row.options[oi];
              const on = row.kind === 'multi' ? motifSelected(intake, o.value) : row.get(intake) === o.value;
              const mark = row.kind === 'multi' ? (on ? '[X]' : '[ ]') : (on ? '(•)' : '( )');
              c.textContent = `${mark} ${o.label}`;
              c.classList.toggle('on', on);
              c.classList.toggle('cursor-on', row.kind === 'multi' && detailFocus === ri && chipFocus === oi);
              c.setAttribute('aria-checked', String(on));
            });
          });
        }
        rowEls.push(r);
      });
      const drawFocus = () => {
        rowEls.forEach((r, i) => {
          r.classList.toggle('focused', i === detailFocus);
          (r.querySelector('.marker') as HTMLElement).textContent = i === detailFocus ? '>' : ' ';
        });
        redraws.forEach((f) => f());
      };
      const redraw = drawFocus;

      const done = h('button', { class: 'key primary', 'data-testid': 'details-done', onclick: () => renderSetup() }, '[ENTER] DONE');
      el.appendChild(h('div', { class: 'panel details-panel' },
        h('div', { class: 'panel-title' }, ' MORE QUESTIONS '),
        h('div', { class: 'promise' }, 'ALL OPTIONAL · THEY TUNE WHAT YOU MEET · SKIP ANY OF THEM'),
        h('div', { class: 'drows' }, ...rowEls),
        h('div', { class: 'keys-hint' }, '[↑][↓] MOVE   [←][→] CHANGE   [0]-[9] SET   [SPACE] TICK'),
        h('div', { class: 'actions' }, done, h('button', { class: 'key', onclick: () => renderSetup() }, '[ESC] BACK')),
      ));
      el.appendChild(file);
      redraw();

      onKey((e) => {
        if (!plain(e) || finished) return;
        const row = DETAIL_ROWS[detailFocus];
        const k = e.key;
        if (k === 'ArrowDown') { detailFocus = (detailFocus + 1) % DETAIL_ROWS.length; chipFocus = 0; }
        else if (k === 'ArrowUp') { detailFocus = (detailFocus + DETAIL_ROWS.length - 1) % DETAIL_ROWS.length; chipFocus = 0; }
        else if (k === 'Enter' || k === 'Escape') { e.preventDefault(); renderSetup(); return; }
        else if (row.kind === 'slider') {
          if (k === 'ArrowLeft') setSlider(row, intake, row.get(intake) - 1);
          else if (k === 'ArrowRight') setSlider(row, intake, row.get(intake) + 1);
          else if (/^[0-9]$/.test(k)) setSlider(row, intake, row.min + Number(k));
          else return;
        } else if (row.kind === 'choice') {
          const n = row.options.length;
          const cur = Math.max(0, row.options.findIndex((o) => o.value === row.get(intake)));
          if (k === 'ArrowLeft') row.set(intake, row.options[(cur + n - 1) % n].value);
          else if (k === 'ArrowRight' || k === ' ') row.set(intake, row.options[(cur + 1) % n].value);
          else if (/^[1-9]$/.test(k) && Number(k) <= n) row.set(intake, row.options[Number(k) - 1].value);
          else return;
        } else {
          const n = row.options.length;
          if (k === 'ArrowLeft') chipFocus = (chipFocus + n - 1) % n;
          else if (k === 'ArrowRight') chipFocus = (chipFocus + 1) % n;
          else if (k === ' ') toggleMotif(intake, row.options[chipFocus].value);
          else if (/^[1-9]$/.test(k) && Number(k) <= n) { chipFocus = Number(k) - 1; toggleMotif(intake, row.options[chipFocus].value); }
          else return;
        }
        e.preventDefault();
        redraw();
      });
    }

    renderSetup();
    if (ctx.autofill) void sleep(ctx.autofillDelayMs ?? 50).then(() => { if (view === 'setup') void begin(); });
  });
}
