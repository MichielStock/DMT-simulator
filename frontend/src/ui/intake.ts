// Intake (BUILD.md sections 8 and 15.4): eleven screens, one question each, exact wording,
// keyboard navigable (arrows / number keys, Enter next, Backspace previous), progress line.
// ?autofill=<profile> renders every screen with the profile's answers and advances after ~50 ms.

import { api, sessionAssetUrl, type DoseStep } from '../api';
import type { Expectation, Intake, Intention } from '../profiles';
import { h, onKey, progressLine, screen, sleep } from './dom';

export interface IntakeCtx {
  sessionId: string | null;
  intake: Intake;          // initial values (defaults or autofill profile); mutated and returned
  autofill: boolean;
}

type SliderStep = { kind: 'slider'; q: string; min: number; max: number; lo: string; hi: string;
  get: (i: Intake) => number; set: (i: Intake, v: number) => void };
type ChoiceStep = { kind: 'choice'; q: string; options: { value: string; label: string; hint?: string }[];
  get: (i: Intake) => string; set: (i: Intake, v: string) => void };
type MultiStep = { kind: 'multi'; q: string; options: { value: string; label: string }[] };
type RoomStep = { kind: 'room'; q: string };
type OptionsStep = { kind: 'options'; q: string };
type Step = SliderStep | ChoiceStep | MultiStep | RoomStep | OptionsStep;

const SAME = { lo: 'Not at all', hi: 'Completely' };

export const STEPS: Step[] = [
  { kind: 'room', q: "Add a photo of where you're sitting." },
  { kind: 'slider', q: 'How clear is your intention for this session?', min: 0, max: 10, lo: 'No idea', hi: 'Very clear',
    get: (i) => i.answers.clarity, set: (i, v) => { i.answers.clarity = v; } },
  { kind: 'slider', q: 'How do you feel right now?', min: -5, max: 5, lo: 'Low', hi: 'Great',
    get: (i) => i.answers.set, set: (i, v) => { i.answers.set = v; } },
  { kind: 'slider', q: 'I can get completely lost in music or a film.', min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[0], set: (i, v) => { i.answers.absorption[0] = v; } },
  { kind: 'slider', q: 'Vivid images come to me easily when I close my eyes.', min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[1], set: (i, v) => { i.answers.absorption[1] = v; } },
  { kind: 'slider', q: "I sometimes lose track of my surroundings when I'm absorbed in something.", min: 0, max: 10, ...SAME,
    get: (i) => i.answers.absorption[2], set: (i, v) => { i.answers.absorption[2] = v; } },
  { kind: 'slider', q: 'Right now I feel…', min: 0, max: 10, lo: 'Preoccupied', hi: 'Ready to let go',
    get: (i) => i.answers.surrender, set: (i, v) => { i.answers.surrender = v; } },
  { kind: 'choice', q: 'What brings you here?', options: [
    { value: 'curiosity', label: 'Curiosity' }, { value: 'recreation', label: 'Recreation' },
    { value: 'reflection', label: 'Reflection' }, { value: 'spiritual', label: 'Spiritual' }],
    get: (i) => i.answers.intention, set: (i, v) => { i.answers.intention = v as Intention; } },
  { kind: 'multi', q: 'Which of these have you seen in videos, art or stories?', options: [
    { value: 'jesters', label: 'Jesters' }, { value: 'machine_elves', label: 'Machine elves' },
    { value: 'aliens', label: 'Aliens' }, { value: 'luminous_feminine', label: 'Luminous feminine figures' },
    { value: 'insectoid', label: 'Insectoid beings' }, { value: 'none', label: 'None of these' }] },
  { kind: 'choice', q: 'Choose a dose step.', options: [
    { value: 'threshold', label: 'Threshold', hint: 'A shimmer at the edges.' },
    { value: 'light', label: 'Light', hint: 'Patterns and colour.' },
    { value: 'strong', label: 'Strong', hint: 'Deep geometry.' },
    { value: 'breakthrough', label: 'Breakthrough', hint: 'Through to the other side.' }],
    get: (i) => i.dose_step, set: (i, v) => { i.dose_step = v as DoseStep; } },
  { kind: 'options', q: 'Options.' },
];

export const N_STEPS = STEPS.length; // 11

export function mountIntake(root: HTMLElement, ctx: IntakeCtx): Promise<Intake> {
  const intake = ctx.intake;
  let idx = 0;
  let off = () => {};
  let thumbUrl: string | null = intake.room.image && ctx.sessionId ? sessionAssetUrl(ctx.sessionId, intake.room.image) : null;

  return new Promise((resolve) => {
    const finish = () => { off(); resolve(intake); };
    const next = () => {
      if (idx < STEPS.length - 1) { idx++; render(); } else finish();
    };
    const prev = () => { if (idx > 0) { idx--; render(); } };

    function render(): void {
      off();
      const step = STEPS[idx];
      const el = screen(root, 'intake');
      el.setAttribute('data-step', String(idx + 1));
      const col = h('div', { class: 'col' });
      el.appendChild(col);
      col.appendChild(h('div', { class: 'progress term', 'data-testid': 'intake-progress' }, progressLine(idx + 1, STEPS.length)));
      col.appendChild(h('h1', { 'data-testid': 'intake-question' }, step.q.toUpperCase()));
      const body = h('div', {});
      col.appendChild(body);
      const nextBtn = h('button', { class: 'key', 'data-testid': 'intake-next', onclick: () => next() },
        idx === STEPS.length - 1 ? '[ENTER] BEGIN' : '[ENTER] NEXT');
      const backBtn = idx > 0 ? h('button', { class: 'key', onclick: () => prev() }, '[BACKSPACE] BACK') : null;
      let keyHandler: (e: KeyboardEvent) => boolean = () => false;

      if (step.kind === 'slider') keyHandler = renderSlider(body, step, intake);
      else if (step.kind === 'choice') keyHandler = renderChoice(body, step, intake);
      else if (step.kind === 'multi') keyHandler = renderMulti(body, step, intake);
      else if (step.kind === 'options') keyHandler = renderOptions(body, intake);
      else keyHandler = renderRoom(body, intake, ctx, () => thumbUrl, (u) => { thumbUrl = u; });

      col.appendChild(h('div', { class: 'gap' }));
      col.appendChild(h('div', {}, nextBtn, backBtn));
      off = onKey((e) => {
        if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'file') return;
        if (keyHandler(e)) { e.preventDefault(); return; }
        if (e.key === 'Enter') { e.preventDefault(); next(); }
        else if (e.key === 'Backspace') { e.preventDefault(); prev(); }
      });
      if (ctx.autofill) {
        const at = idx;
        void sleep(50).then(() => { if (idx === at) next(); });
      }
    }
    render();
  });
}

function sliderText(step: SliderStep, v: number): string {
  const n = step.max - step.min + 1;
  const k = v - step.min;
  let cells = '';
  for (let i = 0; i < n; i++) cells += i <= k ? '■' : '□';
  return cells;
}

function renderSlider(body: HTMLElement, step: SliderStep, intake: Intake): (e: KeyboardEvent) => boolean {
  const fmt = (v: number) => (step.min < 0 && v > 0 ? `+${v}` : String(v));
  const value = h('span', { class: 'accent', 'data-testid': 'intake-value' });
  const bar = h('span', { class: 'slider', 'data-testid': 'intake-slider', role: 'slider',
    'aria-valuemin': step.min, 'aria-valuemax': step.max, tabindex: 0 });
  const set = (v: number) => {
    v = Math.max(step.min, Math.min(step.max, Math.round(v)));
    step.set(intake, v);
    bar.setAttribute('aria-valuenow', String(v));
    bar.setAttribute('data-value', String(v));
    bar.replaceChildren(h('span', {}, '['),
      ...sliderText(step, v).split('').map((c, i) => h('span', { class: 'cell', 'data-v': step.min + i,
        onclick: () => set(step.min + i) }, c)), h('span', {}, ']'));
    value.textContent = fmt(v);
  };
  set(step.get(intake));
  body.appendChild(h('div', { class: 'term' },
    h('span', { class: 'dim' }, `${fmt(step.min)} `), bar, h('span', { class: 'dim' }, ` ${fmt(step.max)}`), '   ', value));
  body.appendChild(h('div', { class: 'term dim' }, `${step.lo.toUpperCase()} … ${step.hi.toUpperCase()}`));
  body.appendChild(h('div', { class: 'gap' }));
  body.appendChild(h('div', { class: 'note' }, '[←][→] MOVE   [0]-[9] SET'));
  return (e) => {
    const v = step.get(intake);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(v - 1); return true; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(v + 1); return true; }
    if (/^[0-9]$/.test(e.key)) { set(step.min + Number(e.key)); return true; }
    return false;
  };
}

function choiceList(body: HTMLElement, options: { value: string; label: string; hint?: string }[],
  isSelected: (v: string) => boolean, onPick: (v: string) => void, multi: boolean): { move: (d: number) => void; pick: () => void; refresh: () => void; setFocus: (i: number) => void } {
  let focus = Math.max(0, options.findIndex((o) => isSelected(o.value)));
  const rows = options.map((o, i) => h('div', { class: 'option', 'data-testid': `intake-option-${o.value}`, 'data-value': o.value,
    onclick: () => { focus = i; onPick(o.value); refresh(); } }));
  const refresh = () => rows.forEach((r, i) => {
    const o = options[i];
    const mark = multi ? (isSelected(o.value) ? '[X]' : '[ ]') : (isSelected(o.value) ? '(•)' : '( )');
    r.replaceChildren(`${i === focus ? '>' : ' '} ${i + 1} ${mark} ${o.label.toUpperCase()}`,
      o.hint ? h('span', { class: 'hint' }, `  ${o.hint}`) : '');
    r.classList.toggle('selected', i === focus);
    r.setAttribute('aria-checked', String(isSelected(o.value)));
  });
  rows.forEach((r) => body.appendChild(r));
  refresh();
  return {
    move: (d) => { focus = (focus + d + options.length) % options.length; refresh(); },
    pick: () => { onPick(options[focus].value); refresh(); },
    refresh,
    setFocus: (i) => { focus = i; refresh(); },
  };
}

function renderChoice(body: HTMLElement, step: ChoiceStep, intake: Intake): (e: KeyboardEvent) => boolean {
  const list = choiceList(body, step.options, (v) => step.get(intake) === v, (v) => step.set(intake, v), false);
  body.appendChild(h('div', { class: 'gap' }));
  body.appendChild(h('div', { class: 'note' }, `[↑][↓] MOVE   [1]-[${step.options.length}] CHOOSE`));
  return (e) => {
    if (e.key === 'ArrowDown') { list.move(1); list.pick(); return true; }
    if (e.key === 'ArrowUp') { list.move(-1); list.pick(); return true; }
    const n = Number(e.key);
    if (n >= 1 && n <= step.options.length) { step.set(intake, step.options[n - 1].value); list.setFocus(n - 1); return true; }
    return false;
  };
}

function renderMulti(body: HTMLElement, step: MultiStep, intake: Intake): (e: KeyboardEvent) => boolean {
  const ex = intake.answers.expectations;
  const isSel = (v: string) => (v === 'none' ? ex.length === 0 : ex.includes(v as Expectation));
  const toggle = (v: string) => {
    if (v === 'none') { ex.length = 0; return; }
    const k = ex.indexOf(v as Expectation);
    if (k >= 0) ex.splice(k, 1); else ex.push(v as Expectation);
  };
  const list = choiceList(body, step.options, isSel, toggle, true);
  body.appendChild(h('div', { class: 'gap' }));
  body.appendChild(h('div', { class: 'note' }, `[↑][↓] MOVE   [SPACE] TOGGLE   [1]-[${step.options.length}] TOGGLE`));
  return (e) => {
    if (e.key === 'ArrowDown') { list.move(1); return true; }
    if (e.key === 'ArrowUp') { list.move(-1); return true; }
    if (e.key === ' ') { list.pick(); return true; }
    const n = Number(e.key);
    if (n >= 1 && n <= step.options.length) { toggle(step.options[n - 1].value); list.setFocus(n - 1); return true; }
    return false;
  };
}

function renderOptions(body: HTMLElement, intake: Intake): (e: KeyboardEvent) => boolean {
  const o = intake.options;
  const EYES: ('auto' | 'open' | 'closed')[] = ['auto', 'open', 'closed'];
  const rows: { label: string; note?: string; value: () => string; cycle: (d: number) => void; testid: string }[] = [
    { label: 'DIFFICULT PASSAGES', note: 'Real experiences can turn frightening. Turn this off for a gentle session.',
      value: () => (o.difficult_passages ? 'ON' : 'OFF · GENTLE'), cycle: () => { o.difficult_passages = !o.difficult_passages; }, testid: 'difficult' },
    { label: 'EYES', value: () => EYES.map((e) => (e === o.eyes ? `<${e.toUpperCase()}>` : e.toUpperCase())).join(' · '),
      cycle: (d) => { o.eyes = EYES[(EYES.indexOf(o.eyes) + d + 3) % 3]; }, testid: 'eyes' },
    { label: 'SOUND', value: () => (o.audio ? 'ON' : 'OFF'), cycle: () => { o.audio = !o.audio; }, testid: 'audio' },
    { label: 'MICROPHONE', note: 'Let sound in the room shape the visuals',
      value: () => (o.microphone ? 'ON' : 'OFF'), cycle: () => { o.microphone = !o.microphone; }, testid: 'microphone' },
  ];
  let focus = 0;
  const els = rows.map((r, i) => h('div', { class: 'row', 'data-testid': `intake-option-${r.testid}`,
    onclick: () => { focus = i; r.cycle(1); refresh(); } }));
  const notes = rows.map((r) => (r.note ? h('div', { class: 'note' }, `    ${r.note}`) : null));
  const refresh = () => els.forEach((el, i) => {
    const r = rows[i];
    const label = `${i === focus ? '>' : ' '} ${r.label}`;
    el.replaceChildren(`${label} ${'.'.repeat(Math.max(2, 26 - label.length))} ${r.value()}`);
    el.classList.toggle('focused', i === focus);
  });
  els.forEach((el, i) => { body.appendChild(el); if (notes[i]) body.appendChild(notes[i]!); });
  refresh();
  body.appendChild(h('div', { class: 'gap' }));
  body.appendChild(h('div', { class: 'note' }, '[↑][↓] MOVE   [←][→] / [SPACE] CHANGE'));
  return (e) => {
    if (e.key === 'ArrowDown') { focus = (focus + 1) % rows.length; refresh(); return true; }
    if (e.key === 'ArrowUp') { focus = (focus + rows.length - 1) % rows.length; refresh(); return true; }
    if (e.key === 'ArrowRight' || e.key === ' ') { rows[focus].cycle(1); refresh(); return true; }
    if (e.key === 'ArrowLeft') { rows[focus].cycle(-1); refresh(); return true; }
    return false;
  };
}

function renderRoom(body: HTMLElement, intake: Intake, ctx: IntakeCtx, getThumb: () => string | null,
  setThumb: (u: string | null) => void): (e: KeyboardEvent) => boolean {
  const status = h('div', { class: 'note', 'data-testid': 'room-status' });
  const thumbBox = h('div', {});
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', 'data-testid': 'room-file' }) as HTMLInputElement;
  let kind: 'photo' | 'panorama' = 'photo';
  const options = [
    { value: 'photo', label: 'Use a photo' },
    { value: 'panorama', label: 'Use a panorama' },
    { value: 'default', label: 'Skip — use a default room' },
  ];
  const showThumb = () => {
    const u = getThumb();
    thumbBox.replaceChildren(u && intake.room.source !== 'default' ? h('img', { class: 'thumb', src: u, alt: 'room', 'data-testid': 'room-thumb' }) : '');
  };
  const pick = (v: string) => {
    if (v === 'default') {
      intake.room = { source: 'default', image: null, depth: null };
      status.textContent = '';
      showThumb();
      return;
    }
    kind = v as 'photo' | 'panorama';
    if (!ctx.autofill) file.click();
  };
  const list = choiceList(body, options, (v) => intake.room.source === v, pick, false);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    status.textContent = 'UPLOADING…';
    // local preview first; replaced by the stored (EXIF-stripped) copy when the upload succeeds
    setThumb(URL.createObjectURL(f));
    intake.room = { source: kind, image: null, depth: null };
    list.refresh();
    showThumb();
    if (!ctx.sessionId) { status.textContent = 'BACK END OFFLINE · USING THE DEFAULT ROOM'; intake.room = { source: 'default', image: null, depth: null }; list.refresh(); return; }
    try {
      const r = await api.uploadRoom(ctx.sessionId, f, kind);
      intake.room = { source: r.source === 'panorama' ? 'panorama' : 'photo', image: r.image, depth: r.depth ?? null };
      setThumb(sessionAssetUrl(ctx.sessionId, r.image) + `?t=${Date.now()}`);
      status.textContent = 'STORED LOCALLY · METADATA REMOVED';
    } catch {
      intake.room = { source: 'default', image: null, depth: null };
      status.textContent = 'COULD NOT READ THAT IMAGE · USING THE DEFAULT ROOM';
    }
    list.refresh();
    showThumb();
  });
  body.appendChild(file);
  body.appendChild(thumbBox);
  body.appendChild(status);
  showThumb();
  body.appendChild(h('div', { class: 'gap' }));
  body.appendChild(h('div', { class: 'note' }, '[↑][↓] MOVE   [1]-[3] CHOOSE   THE PHOTO NEVER LEAVES THIS MACHINE'));
  return (e) => {
    if (e.key === 'ArrowDown') { list.move(1); return true; }
    if (e.key === 'ArrowUp') { list.move(-1); return true; }
    if (e.key === ' ') { list.pick(); return true; }
    const n = Number(e.key);
    if (n >= 1 && n <= 3) { list.setFocus(n - 1); pick(options[n - 1].value); list.refresh(); return true; }
    return false;
  };
}
