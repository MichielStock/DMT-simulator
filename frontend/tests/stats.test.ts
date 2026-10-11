// Stats box rendering from a fixed stats object (BUILD.md 15.3). No computation in the front end.
import { describe, expect, it } from 'vitest';
import { renderStats, statsTailLines } from '../src/ui/stats';
import type { Stats } from '../src/api';

const BOX = [
  '╔════════════════════════════════════════════╗',
  '║ SESSION COMPLETE · SIMULATED    2026-10-10 ║',
  '╠════════════════════════════════════════════╣',
  '║ DOSE STEP ................... BREAKTHROUGH ║',
  '║ INHALED ............................. 100% ║',
  '║ REPEAT HITS ............................ 0 ║',
  '║ PEAK INTENSITY .................. 8.6 / 10 ║',
  '║ TIME TO PEAK ........................ 1:49 ║',
  '║ DURATION ........................... 11:06 ║',
  '║ DEEPEST LAYER ............... BREAKTHROUGH ║',
  '║ BEINGS MET .................... 1 · JESTER ║',
  '║ MESSAGE ......................... RECEIVED ║',
  '║ DIFFICULT PASSAGE ................... NONE ║',
  '║ MEMORY MATCH ......................... 75% ║',
  '╚════════════════════════════════════════════╝',
];

const STATS: Stats = {
  date: '2026-10-10', dose_step: 'BREAKTHROUGH', inhaled_pct: 100, repeat_hits: 0, peak_visual: 8.6,
  time_to_peak: '1:49', duration: '11:06', deepest_layer: 'BREAKTHROUGH', beings_met: '1 · JESTER',
  message: 'RECEIVED', difficult_passage: 'NONE', memory_match_pct: 75, ended_early_at: null, session_minutes: 15,
  sparkline_real: '▁▄▇▇▇▇▇▇▇▆▆▆▅▅▄▄▄▃▃▃▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁',
  sparkline_you: '▁▆██████████▇▆▄▃▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁',
  box: BOX,
};

describe('stats box', () => {
  it('renders the box lines verbatim, 46 columns each', async () => {
    const root = document.createElement('div');
    const box = await renderStats(root, STATS, { instant: true });
    expect(box.getAttribute('data-testid')).toBe('end-box');
    const lines = [...box.children].map((c) => c.textContent);
    expect(lines).toEqual(BOX);
    for (const l of lines) expect([...l!].length).toBe(46);
  });

  it('renders sparklines REAL (amber) and YOU (cyan) and the axis', async () => {
    const root = document.createElement('div');
    await renderStats(root, STATS, { instant: true });
    const real = root.querySelector('.spark-real')!;
    const you = root.querySelector('.spark-you')!;
    expect(real.textContent).toBe(STATS.sparkline_real);
    expect(you.textContent).toBe(STATS.sparkline_you);
    // the axis spans exactly the 36-cell sparklines: 7-column prefix, 0:00 at their start, 15:00 at their end
    expect(root.textContent).toContain(' CLOCK 0:00 ' + '─'.repeat(25) + ' 15:00');
    const axis = [...root.querySelectorAll('.term')].map((e) => e.textContent ?? '').find((t) => t.startsWith(' CLOCK'))!;
    expect([...axis].length).toBe(7 + [...STATS.sparkline_real!].length);
    expect(root.textContent).toContain(' REAL  ▁▄▇');
    expect(root.textContent).toContain(' YOU   ▁▆█');
    expect(root.textContent).not.toContain('ENDED EARLY');
  });

  it('adds ENDED EARLY AT when the session ended with Escape', () => {
    const lines = statsTailLines({ ...STATS, ended_early_at: '3:12' });
    expect(lines[0].text).toBe(' ENDED EARLY AT 3:12');
  });

  it('prints line by line when not instant', async () => {
    const root = document.createElement('div');
    const p = renderStats(root, STATS, { msPerLine: 5 });
    await new Promise((r) => setTimeout(r, 12));
    const partial = root.querySelector('[data-testid=end-box]')!.children.length;
    expect(partial).toBeLessThan(BOX.length);
    await p;
    expect(root.querySelector('[data-testid=end-box]')!.children.length).toBe(BOX.length);
  });
});
