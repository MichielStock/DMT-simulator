// Small DOM helpers shared by the retro screens.

type Attrs = Record<string, string | number | boolean | undefined | null | ((e: any) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const screenHandlers = new Set<() => void>();

/** Remove every key handler registered by screens (called whenever a new screen mounts). */
export function clearScreenHandlers(): void {
  for (const off of [...screenHandlers]) off();
  screenHandlers.clear();
}

/** Create a full-screen retro screen container, replacing whatever is in root. */
export function screen(root: HTMLElement, name: string, extraClass = ''): HTMLDivElement {
  clearScreenHandlers();
  root.replaceChildren();
  const el = h('div', { class: `screen ${extraClass}`.trim(), 'data-screen': name });
  root.appendChild(el);
  return el;
}

/** Register a keydown (or keyup) handler for the current screen; returns the unsubscribe function.
 *  All such handlers are removed automatically when the next screen mounts. */
export function onKey(handler: (e: KeyboardEvent) => void, type: 'keydown' | 'keyup' = 'keydown'): () => void {
  window.addEventListener(type, handler);
  const off = () => { window.removeEventListener(type, handler); screenHandlers.delete(off); };
  screenHandlers.add(off);
  return off;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `[■■■■□□□□□□] 4/11` */
export function progressLine(i: number, n: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round((i / n) * cells)));
  return `[${'■'.repeat(filled)}${'□'.repeat(cells - filled)}] ${i}/${n}`;
}

/** Dotted leader line `LABEL ........ VALUE` of exactly `width` characters. */
export function leader(label: string, value: string, width: number): string {
  const dots = Math.max(1, width - label.length - value.length - 2);
  return `${label} ${'.'.repeat(dots)} ${value}`;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function fmtMs(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
