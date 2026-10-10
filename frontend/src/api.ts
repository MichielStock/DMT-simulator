// Typed fetch wrappers for the back-end API (CONTRACTS.md). Relative URLs only, so the Vite
// proxy and the production server both work. Every call throws ApiError on failure; callers
// decide whether that is fatal (the UI degrades gracefully when the back end is unreachable).

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BASE = '/api';

async function req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  let res: Response;
  try {
    const init: RequestInit = { method };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw new ApiError(0, `network: ${String(e)}`);
  }
  if (!res.ok) throw new ApiError(res.status, `${method} ${path}: HTTP ${res.status}`);
  if (raw) return res as unknown as T;
  return (await res.json()) as T;
}

// ---------- types ----------

export interface Status {
  resident_models: string[];
  versions?: Record<string, string>;
  fallbacks?: string[];
  llm?: { runtime: string; model: string; host: string };
  images?: string;
  ok: boolean;
}

export interface SessionSummary {
  id: string;
  date: string;
  dose_step: string;
  peak_visual: number | null;
  deepest_layer: string;
  beings: string;
  has_report: boolean;
}

export interface ProgressLine { label: string; done: boolean; detail?: string }
export interface Progress {
  stage: string;
  lines: ProgressLine[];
  ready: boolean;
  error: string | null;
}

export type DoseStep = 'threshold' | 'light' | 'strong' | 'breakthrough';

export interface PkParams {
  ka: number; k10: number; k12: number; k21: number; ke0: [number, number, number] | number[]; h: number;
}

export interface EntitySpec {
  type: string;
  label?: string;
  attributes?: Record<string, boolean>;
  disposition?: string;
  communication?: string;
  behaviours: string[];
  sprites?: string[];
  procedural?: boolean;
  [k: string]: unknown;
}

export interface TripScript {
  version: number;
  seed: number;
  pharmacology: {
    dose_step: DoseStep; dose_rel: number; hold_fraction: number;
    sensitivity: number; clearance: number; params: PkParams;
  };
  predicted: { peak_visual: number; deepest_layer: string; minutes_above_8?: number };
  palette: { name: string; colours: string[] };
  room: { source: string; image: string | null; depth: string | null };
  layers: Record<string, unknown>;
  breakthrough: {
    reached: boolean;
    world?: Record<string, unknown> | null;
    entities: EntitySpec[];
    message: { present: boolean; sealed_text?: string; glyph_seed?: number } | null;
  };
  challenge: { occurs: boolean; onset_offset_s: number | null; flavour: string | null };
  [k: string]: unknown;
}

export interface LoggedEvent { t_min: number; type: string; payload: Record<string, unknown> }

export interface Stats {
  date: string; dose_step: string; inhaled_pct: number; repeat_hits: number;
  peak_visual: number; time_to_peak: string; duration: string; deepest_layer: string;
  beings_met: string; message: string; difficult_passage: string;
  memory_match_pct: number | null; ended_early_at: string | null; session_minutes: number;
  sparkline_real: string; sparkline_you: string; box: string[];
}

export interface ReportStatus { stage: string; done: boolean; report_html: string | null; error: string | null }

export interface Replay {
  seed: number;
  trip_script: TripScript;
  events: LoggedEvent[];
  intake: Record<string, unknown>;
}

// ---------- calls ----------

const s = (id: string) => `/session/${encodeURIComponent(id)}`;

export const api = {
  status: () => req<Status>('GET', '/status'),
  sessions: () => req<SessionSummary[]>('GET', '/sessions'),
  createSession: (seed: number | null) => req<{ id: string; seed: number }>('POST', '/session', { seed }),
  uploadRoom: (id: string, file: Blob, kind: 'photo' | 'panorama') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    return req<{ image: string; depth: string; source: string }>('POST', `${s(id)}/room`, fd);
  },
  intake: (id: string, intake: unknown) => req<{ accepted: boolean }>('POST', `${s(id)}/intake`, intake),
  progress: (id: string) => req<Progress>('GET', `${s(id)}/progress`),
  tripScript: (id: string) => req<TripScript>('GET', `${s(id)}/trip_script`),
  events: (id: string, events: LoggedEvent[]) => req<{ count: number }>('POST', `${s(id)}/events`, { events }),
  frame: (id: string, name: string, t_min: number, png_base64: string) =>
    req<{ path: string }>('POST', `${s(id)}/frame`, { name, t_min, png_base64 }),
  curve: (id: string, points: [number, number][]) => req<{ ok: boolean }>('POST', `${s(id)}/curve`, { points }),
  finish: (id: string) => req<{ started: boolean }>('POST', `${s(id)}/finish`, {}),
  reportStatus: (id: string) => req<ReportStatus>('GET', `${s(id)}/report_status`),
  stats: (id: string) => req<Stats>('GET', `${s(id)}/stats`),
  replay: (id: string) => req<Replay>('GET', `${s(id)}/replay`),
};

export function sessionAssetUrl(id: string, rel: string): string {
  return `/sessions/${encodeURIComponent(id)}/${rel.replace(/^\/+/, '')}`;
}

export function reportUrl(id: string): string {
  return sessionAssetUrl(id, 'report.html');
}
