// Return and grounding (BUILD.md section 13.1), always, including after Escape. 60 s (divided by
// the timewarp in tests), three lines of copy, an optional slow breathing circle (≤ 0.2 Hz) and the
// calm room image behind. Any key continues after 10 s (immediately when timewarp > 1); it also
// continues on its own when the 60 s are over.

import { h, onKey, screen, sleep } from './dom';
import { typeText } from './typewriter';

export const GROUNDING_LINES = ["You're back.", 'Take a few slow breaths.', "When you're ready, draw what you remember."];
export const GROUNDING_S = 60;

export function mountGrounding(root: HTMLElement, opts: { roomUrl: string | null; timewarp: number }): Promise<void> {
  const el = screen(root, 'grounding');
  el.setAttribute('data-testid', 'grounding');
  const tw = Math.max(1, opts.timewarp);
  const total = (GROUNDING_S * 1000) / tw;
  const minWait = tw > 1 ? 0 : 10_000;
  const bg = h('div', { class: 'grounding-bg' });
  if (opts.roomUrl) bg.style.backgroundImage = `url("${opts.roomUrl}")`;
  const lines = GROUNDING_LINES.map(() => h('div', { class: 'term' }));
  const hint = h('div', { class: 'note' });
  el.appendChild(bg);
  el.appendChild(h('div', { class: 'grounding-text' }, ...lines, h('div', { class: 'breath slow' }), hint));

  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const finish = () => { if (done) return; done = true; off(); clearTimeout(auto); resolve(); };
    const off = onKey((e) => {
      if (e.key === 'Escape') return;
      if (performance.now() - t0 >= minWait) finish();
    });
    el.addEventListener('click', () => { if (performance.now() - t0 >= minWait) finish(); });
    const auto = setTimeout(finish, total);
    void (async () => {
      const gap = total / 4;
      for (let i = 0; i < lines.length; i++) {
        if (done) return;
        await typeText(lines[i], GROUNDING_LINES[i], { instant: tw > 1 });
        await sleep(gap);
      }
      await sleep(Math.max(0, minWait - (performance.now() - t0)));
      if (!done) hint.textContent = '[ANY KEY] CONTINUE';
    })();
  });
}
