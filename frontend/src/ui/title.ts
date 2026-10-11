// Title screen (BUILD.md section 15.2). The ASCII title alone cycles hue; a tagline under the
// subtitle; the menu is a real menu (the > marker, inverted on hover / selection).

import { api } from '../api';
import { h, onKey, screen } from './dom';

// 'ANSI Shadow' block letters: they read at once in VT323 (the block and frame glyphs come from
// HyperspaceBox on the same grid); line-height 1 in retro.css so the rows join (NOTES D-F4).
export const TITLE_ART = `██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ███████╗██████╗  █████╗  ██████╗███████╗
██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝
███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝███████╗██████╔╝███████║██║     █████╗
██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗╚════██║██╔═══╝ ██╔══██║██║     ██╔══╝
██║  ██║   ██║   ██║     ███████╗██║  ██║███████║██║     ██║  ██║╚██████╗███████╗
╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝`;

export const TITLE_SUBTITLE = 'A DMT EXPERIENCE SIMULATOR   V1.0';
export const TITLE_PROMISES = 'NO DRUGS · NO NETWORK · NO RUSH';
export const TITLE_TAGLINE = 'SIT BACK · BREATHE IN · COME BACK';

export type TitleChoice = 'begin' | 'past' | 'about';

const ITEMS: { key: string; label: string; choice: TitleChoice }[] = [
  { key: '[ENTER]', label: 'BEGIN A SESSION', choice: 'begin' },
  { key: '[P]', label: 'PAST SESSIONS', choice: 'past' },
  { key: '[A]', label: 'ABOUT', choice: 'about' },
];

export function mountTitle(root: HTMLElement): Promise<TitleChoice> {
  const el = screen(root, 'title');
  el.setAttribute('data-testid', 'title-screen');
  let sel = 0;

  const items = ITEMS.map((it) =>
    h('div', { class: 'menu-item', 'data-choice': it.choice },
      h('span', { class: 'marker' }, ' '), h('span', { class: 'mkey' }, it.key), h('span', { class: 'mlabel' }, it.label)),
  );
  const count = h('span', { 'data-testid': 'session-count' }, '…');

  el.appendChild(h('div', { class: 'title-wrap' },
    h('div', { class: 'term title-art' }, TITLE_ART),
    h('div', { class: 'title-sub' }, TITLE_SUBTITLE),
    h('div', { class: 'title-sub dim' }, TITLE_PROMISES),
    h('div', { class: 'tagline' }, TITLE_TAGLINE, h('span', { class: 'cursor' }, '█')),
    h('div', { class: 'menu' }, ...items),
  ));
  el.appendChild(h('div', { class: 'footer dim' }, 'LOCAL MODE · SAFETY LIMITER ON · SESSIONS: ', count, '   ·   [↑][↓] MOVE  [ENTER] SELECT'));

  api.sessions().then(
    (list) => { count.textContent = String(list.length); },
    () => { count.textContent = '—'; },
  );

  const render = () => items.forEach((it, i) => {
    it.classList.toggle('selected', i === sel);
    (it.querySelector('.marker') as HTMLElement).textContent = i === sel ? '>' : ' ';
  });
  render();

  return new Promise((resolve) => {
    let off = () => {};
    const done = (c: TitleChoice) => { off(); resolve(c); };
    off = onKey((e) => {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % ITEMS.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel + ITEMS.length - 1) % ITEMS.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); done(ITEMS[sel].choice); }
      else if (e.key === 'p' || e.key === 'P') done('past');
      else if (e.key === 'a' || e.key === 'A') done('about');
    });
    items.forEach((it, i) => {
      it.addEventListener('mouseenter', () => { sel = i; render(); });
      it.addEventListener('click', () => done(ITEMS[i].choice));
    });
  });
}
