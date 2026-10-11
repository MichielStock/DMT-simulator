// About screen (BUILD.md section 15.2): section 1 in plain words, the main references, the controls.

import { h, onKey, screen } from './dom';

export const ABOUT_TEXT: { title: string; lines: string[] }[] = [
  { title: 'WHAT "REALISTIC" MEANS HERE', lines: [
    'Hyperspace imitates the form, timing and story of reported DMT experiences: the geometric patterns, the tiled and kaleidoscopic spaces, other worlds and the beings people describe.',
    'A model of how the drug would rise and fall in the body sets the timing. What you meet is drawn from published survey frequencies.',
    'It does not reproduce the felt sense of reality, the meaning, or the time distortion of the real state.',
  ] },
  { title: 'WHAT "SAFE" MEANS HERE', lines: [
    'No drug is involved. A limiter that cannot be switched off keeps flashing and high-contrast patterns below seizure-risk guidelines.',
    'Escape always ends the session gently. Sessions are capped at 30 minutes. Difficult passages are optional, short and always resolve.',
    'Doses are relative steps only, never real amounts. Reports are labelled simulated. Everything stays on this machine.',
  ] },
  { title: 'MAIN REFERENCES', lines: [
    'Lawrence et al. 2022 (Sci Rep) · Davis et al. 2020 (J Psychopharmacol) · Eckernäs et al. 2022 (Clin Transl Sci)',
    'Bressloff et al. 2001 (Phil Trans R Soc B) · Michael, Luke & Robinson 2021 · Timmermann et al. 2019 · Suzuki et al. 2017',
  ] },
  { title: 'CONTROLS', lines: [
    '[SPACE] HOLD TO INHALE, THEN HOLD TO LET GO   [H] REPEAT HIT   [E] EYES   [I] DISPLAY',
    '[MOUSE] LOOK AROUND   [-] [+] VOLUME   [ESC] END THE SESSION, AT ANY MOMENT',
  ] },
];

export function mountAbout(root: HTMLElement): Promise<void> {
  const el = screen(root, 'about');
  const panel = h('div', { class: 'panel about-panel' }, h('h1', { class: 'panel-title' }, ' ABOUT HYPERSPACE '));
  for (const sec of ABOUT_TEXT) {
    const body = h('div', { class: 'about-body' });
    for (const l of sec.lines) body.appendChild(h('p', {}, l));
    panel.appendChild(h('section', { class: 'about-sec' }, h('div', { class: 'accent about-head' }, sec.title), body));
  }
  panel.appendChild(h('div', { class: 'actions' }, h('button', { class: 'key primary', onclick: () => close() }, '[ESC] TITLE')));
  el.appendChild(panel);
  let close = () => {};
  return new Promise((resolve) => {
    const off = onKey((e) => {
      if (['Escape', 'Enter', 'Backspace'].includes(e.key) || e.key.toLowerCase() === 't') close();
    });
    close = () => { off(); resolve(); };
    el.addEventListener('click', () => close());
  });
}
