// Typewriter: prints text at ~15 ms per character, or line by line (~80 ms per line) for boxes.
// Any key (or click) reveals everything at once. Never used for the safety screen.

export interface TypeOptions {
  msPerChar?: number;
  instant?: boolean;
  onLine?: (i: number) => void;
}

let revealAll: (() => void)[] = [];

function installSkip(): void {
  if ((window as any).__hsTypeSkip) return;
  (window as any).__hsTypeSkip = true;
  const skip = () => {
    const fns = revealAll;
    revealAll = [];
    for (const f of fns) f();
  };
  window.addEventListener('keydown', skip, true);
  window.addEventListener('pointerdown', skip, true);
}

/** Reveal all running typewriters now. */
export function revealAllNow(): void {
  const fns = revealAll;
  revealAll = [];
  for (const f of fns) f();
}

/** Type `text` into `el` character by character. */
export function typeText(el: HTMLElement, text: string, opts: TypeOptions = {}): Promise<void> {
  installSkip();
  const ms = opts.msPerChar ?? 15;
  if (opts.instant || ms <= 0) {
    el.textContent = text;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let i = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      el.textContent = text;
      resolve();
    };
    const timer = setInterval(() => {
      i = Math.min(text.length, i + Math.max(1, Math.round(16 / ms)));
      el.textContent = text.slice(0, i);
      if (i >= text.length) finish();
    }, ms);
    revealAll.push(finish);
  });
}

/** Append `lines` to `el` one line at a time (each line in its own element made by `make`). */
export function typeLines(
  el: HTMLElement,
  lines: string[],
  make: (line: string, i: number) => HTMLElement,
  opts: { msPerLine?: number; instant?: boolean; onLine?: (i: number) => void } = {},
): Promise<void> {
  installSkip();
  const ms = opts.msPerLine ?? 80;
  return new Promise((resolve) => {
    let i = 0;
    let done = false;
    const add = () => {
      el.appendChild(make(lines[i], i));
      opts.onLine?.(i);
      i++;
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      while (i < lines.length) add();
      resolve();
    };
    if (opts.instant || ms <= 0 || lines.length === 0) {
      while (i < lines.length) add();
      done = true;
      resolve();
      return;
    }
    const timer = setInterval(() => {
      add();
      if (i >= lines.length) finish();
    }, ms);
    revealAll.push(finish);
  });
}
