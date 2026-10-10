// EventLog: records events with t_min from the model clock, keeps them all in memory (the curve
// screen and replay use them) and batches POST /events every 2 s and on session_end.

import { api, type LoggedEvent } from './api';

export type EventType =
  | 'hit' | 'hit_blocked' | 'intensity_sample' | 'layer_enter' | 'layer_exit' | 'entity_appear'
  | 'entity_behaviour' | 'message_shown' | 'challenge_start' | 'challenge_resolve' | 'let_go_held'
  | 'eyes_toggle' | 'exit_pressed' | 'frame_captured' | 'limiter_engaged' | 'session_end';

export interface EventLogOptions {
  /** POST to the back end (false for replays and offline mode). */
  post?: boolean;
  flushIntervalMs?: number;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export class EventLog {
  readonly all: LoggedEvent[] = [];
  private pending: LoggedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: ((e: LoggedEvent) => void)[] = [];
  private inflight: Promise<void> = Promise.resolve();
  post: boolean;
  failures = 0;

  constructor(public sessionId: string | null, private clock: () => number, opts: EventLogOptions = {}) {
    this.post = opts.post ?? sessionId !== null;
    if (this.post) {
      this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 2000);
    }
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  log(type: EventType | string, payload: Record<string, unknown> = {}, tMin?: number): LoggedEvent {
    const e: LoggedEvent = { t_min: round(tMin ?? this.clock()), type, payload };
    this.all.push(e);
    if (this.post) this.pending.push(e);
    for (const l of this.listeners) l(e);
    if (type === 'session_end') void this.flush();
    return e;
  }

  onEvent(cb: (e: LoggedEvent) => void): void {
    this.listeners.push(cb);
  }

  ofType(type: string): LoggedEvent[] {
    return this.all.filter((e) => e.type === type);
  }

  /** Send everything pending; resolves when the back end has it (or failed). Serialised. */
  flush(): Promise<void> {
    this.inflight = this.inflight.then(async () => {
      if (!this.post || !this.sessionId || this.pending.length === 0) return;
      const batch = this.pending;
      this.pending = [];
      try {
        await api.events(this.sessionId, batch);
      } catch {
        this.failures++;
        this.pending = batch.concat(this.pending); // retry with the next flush
      }
    });
    return this.inflight;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
