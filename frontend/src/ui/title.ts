// Title screen (BUILD.md section 15.2), verbatim layout. The ASCII title alone cycles hue.

import { api } from '../api';
import { h, onKey, screen } from './dom';

export const TITLE_ART = String.raw` _  ___   _____ ___ ___  ___ ___  _   ___ ___
| || \ \ / / _ \ __| _ \/ __| _ \/_\ / __| __|
| __ |\ V /|  _/ _||   /\__ \  _/ _ \ (__| _|
|_||_| |_| |_| |___|_|_\|___/_|/_/ \_\___|___|`;

export type TitleChoice = 'begin' | 'past' | 'about';

const ITEMS: { key: string; label: string; choice: TitleChoice }[] = [
  { key: '[ENTER]  ', label: 'BEGIN A SESSION', choice: 'begin' },
  { key: '[P]      ', label: 'PAST SESSIONS', choice: 'past' },
  { key: '[A]      ', label: 'ABOUT', choice: 'about' },
];

export function mountTitle(root: HTMLElement): Promise<TitleChoice> {
  const el = screen(root, 'title');
  el.setAttribute('data-testid', 'title-screen');
  let sel = 0;

  const art = h('span', { class: 'title-art' }, TITLE_ART);
  const sub = '\n\n       A DMT EXPERIENCE SIMULATOR   V1.0\n        NO DRUGS · NO NETWORK · NO RUSH\n\n';
  const items = ITEMS.map((it, i) =>
    h('div', { class: 'item', 'data-choice': it.choice },
      h('span', {}, '         '), h('span', { class: 'marker' }, i === sel ? '>' : ' '), `${it.key}${it.label}`),
  );
  const cursorLine = h('div', {}, ' '.repeat(38), h('span', { class: 'cursor' }, '█'));
  const count = h('span', { 'data-testid': 'session-count' }, '…');
  const footer = h('div', {}, '\n LOCAL MODE · SAFETY LIMITER ON · SESSIONS: ', count);

  const pre = h('div', { class: 'term' }, art, sub, h('div', { class: 'menu' }, ...items), cursorLine, footer);
  el.appendChild(pre);

  api.sessions().then(
    (list) => { count.textContent = String(list.length); },
    () => { count.textContent = '—'; },
  );

  const render = () => items.forEach((it, i) => { (it.querySelector('.marker') as HTMLElement).textContent = i === sel ? '>' : ' '; });

  return new Promise((resolve) => {
    let off = () => {};
    const done = (c: TitleChoice) => { off(); resolve(c); };
    off = onKey((e) => {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % ITEMS.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel + ITEMS.length - 1) % ITEMS.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter') done(ITEMS[sel].choice);
      else if (e.key === 'p' || e.key === 'P') done('past');
      else if (e.key === 'a' || e.key === 'A') done('about');
    });
    items.forEach((it, i) => {
      it.addEventListener('mouseenter', () => { sel = i; render(); });
      it.addEventListener('click', () => done(ITEMS[i].choice));
    });
  });
}
