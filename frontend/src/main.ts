// Hyperspace front end: the session state machine (BUILD.md section 5.1)
// title → safety → intake → settle → hit → trip → grounding → curve → end → report.
// URL parameters: ?debug=1 ?timewarp=N ?autofill=<profile> ?dose=<step> ?gentle=1 ?seed=<int>
// ?autostart=1 (skip the title) ?replay=<id> ?demoEnd=<id>. None of them affects the SafetyLimiter.
// Scrub mode (tests and galleries only, BUILD.md 5.2 / 16.2; requires ?debug=1):
//   ?debug=1&scrub=1&dose=<step>&seed=<int>[&v=<0-10>][&layer=<room|form_constants|chrysanthemum|waiting_room|breakthrough>]
//   [&challenge=1][&entity=1][&message=1][&eyes=<0-1>][&autofill=neutral][&sensitivity=<0.25-3>]
//   [&sweep=1[&sweepS=<seconds for 0→10→0, default 60>]][&panel=1 (show the scrubber panel)]
//   [&session=<id> (reuse an existing prepared session: its trip_script, intake and assets; no new session)]
// creates a session through the API with the autofilled intake, waits until it is ready, skips
// title/safety/intake/hit and enters the trip with the model's intensity replaced by forced values.
// The normal flow is untouched, and the SafetyLimiter stays the last pass in every mode.

import './ui/retro.css';
import * as THREE from 'three';
import { api, sessionAssetUrl, type DoseStep, type LoggedEvent, type TripScript } from './api';
import { EventLog } from './events';
import { Director } from './director';
import { advanceFade, computeLayerWeights, type LayerWeights } from './layerWeights';
import { DOSES, P as PK_DEFAULT, PharmacologyModel } from './pharmacology';
import { RenderPipeline } from './pipeline';
import { defaultIntake, loadProfile, type Intake } from './profiles';
import { AdaptiveQuality } from './quality';
import { clockSeed } from './rng';
import { createState, LAYER_NAMES, WEIGHT_KEYS, type SharedState, type WeightKey, type Weights } from './state';
import { LAYER_FORCE_V, mountScrubber, parseLayerName, sweepValue } from './debugScrubber';
import { createRoomLayer } from './layers/room';
import { createNeuralFieldLayer } from './layers/neuralField';
import { createHyperbolicLayer } from './layers/hyperbolic';
import { createWaitingRoomLayer } from './layers/waitingRoom';
import { createBreakthroughLayer } from './layers/breakthrough';
import { createAudio, type HyperspaceAudio } from './audio';
import { mountTitle } from './ui/title';
import { mountSafety } from './ui/safetyScreen';
import { mountSetup } from './ui/setup';
import { mountPrepare } from './ui/prepare';
import { RepeatHits, type HitResult } from './ui/hit';
import { Hud } from './ui/hud';
import { mountGrounding } from './ui/grounding';
import { mountCurve } from './ui/curveDraw';
import { mountEnd } from './ui/endScreen';
import { mountPastSessions } from './ui/pastSessions';
import { mountAbout } from './ui/about';
import { h, onKey, params, screen } from './ui/dom';

// ---------------------------------------------------------------------------------------------
// configuration

const Q = params();
const intParam = (k: string): number | null => {
  const v = Q.get(k);
  if (v === null || v === '' || !/^-?\d+$/.test(v)) return null;
  return Number(v);
};
const CFG = {
  debug: Q.get('debug') === '1',
  timewarp: Math.max(0.1, Math.min(100, Number(Q.get('timewarp') ?? '1') || 1)),
  seed: intParam('seed'),
  autostart: Q.get('autostart') === '1',
  autofill: Q.get('autofill'),
  dose: Q.get('dose'),
  gentle: Q.get('gentle') === '1',
  replay: Q.get('replay'),
  demoEnd: Q.get('demoEnd'),
};

/** Scrub-mode configuration (null outside scrub mode). */
interface ScrubCfg {
  v: number;
  layer: WeightKey | null;
  challenge: boolean;
  entity: boolean;
  message: boolean;
  eyes: number | null;
  sensitivity: number | null;
  sweep: boolean;
  sweepS: number;
  panel: boolean;
  /** reuse this prepared session (trip_script + assets) instead of creating one */
  session: string | null;
}
const numParam = (k: string): number | null => {
  const v = Q.get(k);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const SCRUB: ScrubCfg | null = CFG.debug && Q.get('scrub') === '1' ? (() => {
  const layer = parseLayerName(Q.get('layer'));
  const v = numParam('v');
  const eyes = numParam('eyes');
  const sens = numParam('sensitivity');
  return {
    v: Math.max(0, Math.min(10, v ?? (layer ? LAYER_FORCE_V[layer] : 5))),
    layer,
    challenge: Q.get('challenge') === '1',
    entity: Q.get('entity') === '1',
    message: Q.get('message') === '1',
    eyes: eyes === null ? null : Math.max(0, Math.min(1, eyes)),
    sensitivity: sens === null ? null : Math.max(0.25, Math.min(3, sens)),
    sweep: Q.get('sweep') === '1',
    sweepS: Math.max(4, numParam('sweepS') ?? 60),
    panel: Q.get('panel') === '1',
    session: /^[A-Za-z0-9_.-]{1,80}$/.test(Q.get('session') ?? '') ? Q.get('session') : null,
  };
})() : null;

/** Session limits (BUILD.md sections 4.2 and 11). */
export const LIMITS = {
  capMin: 30,                 // session cap from the first hit
  minSessionMin: 2,           // natural end not before 2 min of model time
  endVisual: 0.5,             // natural end when visual falls below this after having reached it
  sampleEverySub: 5,          // intensity_sample every 5 model sub-steps = 0.5 s of model time
  fadeMs: 3000,               // exit / end fade to the calm room
  enterThreshold: 0.01,       // layer_enter / layer_exit crossing
};

// ---------------------------------------------------------------------------------------------
// test hooks: window.__hyperspace

interface HyperspaceHooks {
  state: SharedState | null;
  events: EventLog | null;
  screen: string;
  pipeline: RenderPipeline<SharedState> | null;
  sessionId: string | null;
  forceIntensity: (v: number | null) => void;
  finishEarly: () => void;
  forceLayer: (name: string | null) => void;
  forceChallenge: (on: boolean) => void;
  forceEntity: () => void;
  forceMessage: () => void;
  setEyes: (x: number | null) => void;
  /** true while the trip has rendered at least a few frames, no texture/asset load is pending, every
   *  layer that exposes `ready` reports it, and the layer weights have reached their (forced) targets. */
  readyForCapture: boolean;
  renderStats: { frameMs: number; renderScale: number; frames: number };
  audioContext?: AudioContext;
  audio?: HyperspaceAudio;
  drawCurve?: (pts: [number, number][]) => void;
  /** the running trip's Director (tests read its `flickers` and `sequence`); null outside a trip */
  director?: Director | null;
  [k: string]: unknown;
}

const w = window as unknown as { __hyperspace: HyperspaceHooks };
const hs: HyperspaceHooks = Object.assign(w.__hyperspace ?? {}, {
  state: null, events: null, screen: 'boot', pipeline: null, sessionId: null,
  forceIntensity: (v: number | null) => {
    forcedSweep = false;
    forcedVisual = v === null || v === undefined ? null : Math.max(0, Math.min(10, Number(v)));
  },
  finishEarly: () => { activeTrip?.end('escape'); },
  forceLayer: (name: string | null) => { forcedLayer = name === null || name === undefined ? null : parseLayerName(name); },
  forceChallenge: (on: boolean) => { forcedChallenge = !!on; if (on) activeTrip?.forceChallengeNow(); },
  forceEntity: () => { activeTrip?.forceEntityNow(); },
  forceMessage: () => { forcedMessage = true; activeTrip?.forceMessageNow(); },
  setEyes: (x: number | null) => { forcedEyes = x === null || x === undefined ? null : Math.max(0, Math.min(1, Number(x))); },
  readyForCapture: false,
  renderStats: { frameMs: 0, renderScale: 1, frames: 0 },
});
w.__hyperspace = hs;

// ---------------------------------------------------------------------------------------------
// audio (BUILD.md 12, 4.2): one HyperspaceAudio per session; volume is reachable on every screen.

const volEl = document.createElement('div');
volEl.className = 'vol-indicator';
volEl.dataset.testid = 'volume';
document.body.appendChild(volEl);
let volTimer: ReturnType<typeof setTimeout> | null = null;
function showVolume(): void {
  const a = hs.audio;
  volEl.textContent = a ? `VOL ${Math.round(a.volume * 100)}%` : 'VOL —';
  volEl.classList.add('on');
  if (volTimer) clearTimeout(volTimer);
  volTimer = setTimeout(() => volEl.classList.remove('on'), 1500);
}
window.addEventListener('keydown', (e) => {
  const a = hs.audio;
  if (e.key === '-' || e.key === '_') { if (a) a.setVolume(Math.max(0, a.volume - 0.1)); showVolume(); }
  else if (e.key === '+' || e.key === '=') { if (a) a.setVolume(Math.min(1, a.volume + 0.1)); showVolume(); }
});

/** Create the session's audio after the hit (needs the AudioContext of the safety-screen click). */
function createSessionAudio(intake: Intake): void {
  try { hs.audio?.dispose(); } catch { /* ignore */ }
  hs.audio = undefined;
  if (!hs.audioContext) return; // no AudioContext → silent session (section 0.6)
  try {
    hs.audio = createAudio(hs.audioContext, { enabled: intake.options.audio !== false, microphone: !!intake.options.microphone, seed: intake.seed });
  } catch (e) {
    console.warn('audio unavailable; silent session', e);
    hs.audio = undefined;
  }
}
function disposeSessionAudio(): void {
  try { hs.audio?.dispose(); } catch { /* ignore */ }
  hs.audio = undefined;
}
let forcedVisual: number | null = null;
let forcedLayer: WeightKey | null = null;
let forcedChallenge = false;   // keep a difficult passage running (re-forced after each relief beat)
let forcedMessage = false;     // keep the glyph message cycling (12 s shown, 3 s pause)
let forcedEyes: number | null = null;
let forcedSweep = false;
let activeTrip: Trip | null = null;

// Pending texture/asset loads (three's DefaultLoadingManager is used by every loader that is not
// given its own manager), for readyForCapture.
let pendingLoads = 0;
{
  const mgr = THREE.DefaultLoadingManager;
  const start = mgr.itemStart.bind(mgr);
  const end = mgr.itemEnd.bind(mgr);
  mgr.itemStart = (url: string) => { pendingLoads++; start(url); };
  mgr.itemEnd = (url: string) => { pendingLoads = Math.max(0, pendingLoads - 1); end(url); };
}

function setScreen(name: string): void {
  hs.screen = name;
  document.body.dataset.screen = name;
}

const root = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------------------------------------
// screens helpers

function messageScreen(name: string, lines: string[], hint = '[ENTER] TITLE'): Promise<void> {
  setScreen(name);
  const el = screen(root, name);
  el.appendChild(h('div', { class: 'panel message-panel' },
    h('div', { class: 'panel-title' }, name === 'error' ? ' HMM. ' : ' NOTE '),
    ...lines.map((l) => h('p', {}, l)),
    h('div', { class: 'actions' }, h('button', { class: 'key primary' }, hint))));
  return new Promise((resolve) => {
    const off = onKey((e) => { if (e.key === 'Enter' || e.key === 'Escape') { off(); resolve(); } });
    el.addEventListener('click', () => { off(); resolve(); });
  });
}

async function titleLoop(): Promise<void> {
  for (;;) {
    setScreen('title');
    const c = await mountTitle(root);
    if (c === 'begin') return;
    if (c === 'past') { setScreen('past'); await mountPastSessions(root); }
    if (c === 'about') { setScreen('about'); await mountAbout(root); }
  }
}

// ---------------------------------------------------------------------------------------------
// offline fallback (dev without the back end): a minimal local trip script

function offlineTripScript(intake: Intake): TripScript {
  return {
    version: 1,
    seed: intake.seed,
    pharmacology: {
      dose_step: intake.dose_step, dose_rel: DOSES[intake.dose_step] * intake.hold_fraction, hold_fraction: intake.hold_fraction,
      sensitivity: 1, clearance: 1, params: { ...PK_DEFAULT, ke0: [...PK_DEFAULT.ke0] },
    },
    predicted: { peak_visual: 0, deepest_layer: 'none', minutes_above_8: 0 },
    palette: { name: 'amber', colours: ['#ffb000', '#4fe3ff', '#ff4fd8', '#7dff6a', '#ffe08a'] },
    room: { source: 'default', image: null, depth: null },
    layers: {},
    breakthrough: {
      reached: false, world: null,
      entities: [{ type: 'living_geometry', label: 'being', behaviours: ['approach', 'greet', 'present_object', 'transform', 'depart'], procedural: true }],
      message: { present: true, glyph_seed: 7 },
    },
    challenge: { occurs: false, onset_offset_s: null, flavour: null },
  };
}

// ---------------------------------------------------------------------------------------------
// the trip

interface TripInputs {
  /** recorded user inputs to feed (replay); keyed by model time */
  replay?: LoggedEvent[];
}

interface TripResult { endMin: number; reason: 'faded' | 'escape' | 'cap'; events: EventLog }

/** Local comfort clamp for mouse look (safety/comfort.ts has no clampLook export; see NOTES.md). */
const LOOK = { maxYaw: 0.35, maxPitch: 0.2, maxSpeed: 0.8 /* rad/s */ };
function clampLook(cur: { yaw: number; pitch: number }, target: { yaw: number; pitch: number }, dtS: number) {
  const ty = Math.max(-LOOK.maxYaw, Math.min(LOOK.maxYaw, target.yaw));
  const tp = Math.max(-LOOK.maxPitch, Math.min(LOOK.maxPitch, target.pitch));
  const step = LOOK.maxSpeed * dtS;
  const dy = Math.max(-step, Math.min(step, ty - cur.yaw));
  const dp = Math.max(-step, Math.min(step, tp - cur.pitch));
  return { yaw: cur.yaw + dy, pitch: cur.pitch + dp };
}

/** Visual intensity at which each layer's entry window is fully crossed (BUILD.md 11.2). */
const ENTRY_V: Record<WeightKey, number> = { room: 2.0, formConstants: 3.0, chrysanthemum: 5.2, waitingRoom: 7.6, breakthrough: 8.0 };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

class Trip {
  readonly state: SharedState;
  readonly events: EventLog;
  readonly model: PharmacologyModel;
  readonly director: Director;
  private pipeline: RenderPipeline<SharedState> | null = null;
  private hud: Hud;
  private repeat: RepeatHits;
  private quality: AdaptiveQuality | null = null;
  private lw: LayerWeights | null = null;      // raw windows (hysteresis + latch)
  private shown: LayerWeights | null = null;   // after time-based fades (what is drawn)
  private pendingEnters: WeightKey[] = [];     // layer_enter frames waiting until the layer is really on screen
  private lastCaptureT: number | null = null;  // model minute of the latest frame capture
  private snapCount = 0;                       // periodic snapshots taken (snap_01 …)
  private nextSnapT: number | null = null;     // model minute of the next periodic snapshot
  private active = new Set<WeightKey>();
  private captured = new Set<string>();
  private maxV = 0;
  private everAbove = false;
  private peakCaptured = false;
  private ended = false;
  private resolveEnd!: (r: TripResult) => void;
  private raf = 0;
  private lastFrame = 0;
  private pulsePhase = 0;
  private eyesMode: 'auto' | 'open' | 'closed';
  private lookTarget = { yaw: 0, pitch: 0 };
  private letGoStart: number | null = null;
  private cueEl: HTMLElement;
  private cueTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeEl: HTMLElement;
  private scrubber: { el: HTMLElement; update: () => void } | null = null;
  private replayQueue: { t: number; apply: () => void }[] = [];
  private offs: (() => void)[] = [];
  private layers: unknown[] = [];
  private framesRendered = 0;
  private sweepStart = -1;
  private messageShown = false;
  private captureEntityPending: number | null = null;   // entity index waiting for its fade-in
  private captureMessagePending = false;               // message waiting for its envelope peak
  private mouseDist = 0;                               // screen diagonals moved since the last frame
  private lastMouse: { x: number; y: number } | null = null;

  constructor(
    private sessionId: string | null,
    private script: TripScript,
    private intake: Intake,
    private hit: HitResult,
    private opts: { post: boolean; replay?: LoggedEvent[]; scrub?: ScrubCfg },
  ) {
    const seed = script.seed ?? intake.seed;
    this.state = createState(seed, CFG.timewarp);
    this.state.tripScript = script;
    this.state.gentle = !intake.options.difficult_passages;
    this.state.palette = script.palette ?? this.state.palette;
    const ab = intake.answers.absorption;
    this.state.absorptionGain = (ab[0] + ab[1] + ab[2]) / 3 / 5;
    this.state.assetBase = sessionId ? sessionAssetUrl(sessionId, '') : null;
    this.eyesMode = intake.options.eyes;

    const ph = script.pharmacology;
    this.model = new PharmacologyModel(ph.params ?? PK_DEFAULT, ph.sensitivity ?? 1, ph.clearance ?? 1);
    this.events = new EventLog(sessionId, () => this.model.tMin, { post: opts.post });
    this.director = new Director(script, seed, { gentle: this.state.gentle, surrender: intake.answers.surrender });
    hs.state = this.state;
    hs.events = this.events;
    hs.director = this.director;

    // ---- DOM ----
    setScreen('trip');
    const el = screen(root, 'trip');
    document.body.classList.add('in-trip');
    const canvas = h('canvas', { 'data-testid': 'trip-canvas', id: 'trip-canvas' }) as HTMLCanvasElement;
    const exit = h('div', { class: 'exit-corner', 'data-testid': 'exit-corner', title: 'End the session (Esc)' }, '[ESC] EXIT');
    this.cueEl = h('div', { class: 'cue', 'data-testid': 'cue' });
    const hitBtn = h('button', { class: 'key hit-button', 'data-testid': 'hit-button' }, '[H] HIT');
    this.fadeEl = h('div', { class: 'fade-overlay', 'data-testid': 'fade' });
    el.append(canvas, exit, this.cueEl, hitBtn, this.fadeEl);
    el.style.padding = '0';
    this.hud = new Hud(el);

    try {
      this.pipeline = new RenderPipeline<SharedState>(canvas, { debug: CFG.debug });
      for (const layer of [createRoomLayer(), createNeuralFieldLayer(), createHyperbolicLayer(), createWaitingRoomLayer(), createBreakthroughLayer()]) {
        this.pipeline.addLayer(layer);
        this.layers.push(layer);
      }
      const pl = this.pipeline;
      this.quality = new AdaptiveQuality((s) => pl.setRenderScale(s), pl.renderScale);
    } catch (e) {
      console.error('WebGL unavailable; the session continues without visuals', e);
      this.pipeline = null;
    }
    hs.pipeline = this.pipeline;
    if (this.pipeline) this.pipeline.limiter.onEngaged((info) => this.events.log('limiter_engaged', { kind: info.kind, tiles: info.tiles }));

    this.repeat = new RepeatHits({
      visual: () => this.state.intensity.visual,
      apply: (f) => this.model.addHit(DOSES[this.intake.dose_step] * f),
      logHit: (f, n) => this.events.log('hit', { dose_step: this.intake.dose_step, dose_rel: round3(DOSES[this.intake.dose_step] * f), hold_fraction: round3(f), n }),
      logBlocked: (reason) => this.events.log('hit_blocked', { reason, visual: round3(this.state.intensity.visual) }),
      cue: (t, ms) => this.cue(t, ms),
    });

    // ---- inputs ----
    const replaying = !!opts.replay;
    exit.addEventListener('click', () => this.end('escape'));
    if (!replaying) {
      hitBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.repeat.press(); });
      hitBtn.addEventListener('pointerup', () => this.repeat.release());
      hitBtn.addEventListener('pointerleave', () => this.repeat.release());
    }
    const down = (e: KeyboardEvent) => {
      if (this.ended) return;
      if (e.key === 'Escape') { e.preventDefault(); this.end('escape'); return; }
      if (this.state.interaction) this.state.interaction.keyPulse = 1; // two-way communication (any key)
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'i') this.hud.toggle();
      if (replaying) return;
      if (k === 'e') this.toggleEyes();
      else if (k === 'h') this.repeat.press();
      else if (e.key === ' ') { e.preventDefault(); this.letGoDown(); }
    };
    const up = (e: KeyboardEvent) => {
      if (this.ended || replaying) return;
      const k = e.key.toLowerCase();
      if (k === 'h') this.repeat.release();
      else if (e.key === ' ') this.letGoUp();
    };
    const move = (e: MouseEvent) => {
      if (this.lastMouse) {
        const diag = Math.hypot(window.innerWidth, window.innerHeight) || 1;
        this.mouseDist += Math.hypot(e.clientX - this.lastMouse.x, e.clientY - this.lastMouse.y) / diag;
      }
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.lookTarget = { yaw: (e.clientX / window.innerWidth - 0.5) * 2 * LOOK.maxYaw, pitch: -(e.clientY / window.innerHeight - 0.5) * 2 * LOOK.maxPitch };
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousemove', move);
    this.offs.push(() => window.removeEventListener('keydown', down), () => window.removeEventListener('keyup', up),
      () => window.removeEventListener('mousemove', move));

    if (CFG.debug) {
      this.scrubber = mountScrubber(el, {
        setIntensity: (v) => { forcedVisual = v; },
        forceLayer: (k) => { forcedLayer = k; },
        forceEntity: () => this.director.forceEntity(this.model.tMin),
        forceMessage: () => this.director.forceMessage(this.model.tMin),
        forceChallenge: () => this.director.forceChallenge(this.model.tMin),
        readout: () => `t ${this.model.tMin.toFixed(2)} min · v ${this.state.intensity.visual.toFixed(2)} · scale ${this.quality?.scale.toFixed(2) ?? '-'}`,
        toggleSweep: () => { forcedSweep = !forcedSweep; this.sweepStart = -1; if (!forcedSweep) forcedVisual = null; },
      });
      // scrub mode: the panel stays hidden (clean captures) unless &panel=1
      if (opts.scrub && !opts.scrub.panel) (this.scrubber as { el: HTMLElement }).el.style.display = 'none';
    }

    // ---- replay inputs ----
    if (opts.replay) this.buildReplayQueue(opts.replay);

    // ---- intensity samples every 0.5 s of model time (exact, on the model's sub-step clock) ----
    this.model.onSubStep = (m) => {
      if (m.subSteps % LIMITS.sampleEverySub === 0) this.sample();
      this.checkEntries(forcedVisual ?? m.intensity.visual);
    };
  }

  run(): Promise<TripResult> {
    return new Promise((resolve) => {
      this.resolveEnd = resolve;
      // the hit: t = 0
      const f = this.hit.holdFraction;
      const dose = DOSES[this.intake.dose_step] * f;
      this.model.addHit(dose);
      this.events.log('hit', { dose_step: this.intake.dose_step, dose_rel: round3(dose), hold_fraction: round3(f), n: 0 }, 0);
      this.sample();
      this.lastFrame = performance.now();
      activeTrip = this;
      try { hs.audio?.start(); } catch (e) { console.warn('audio start failed', e); }
      this.raf = requestAnimationFrame((t) => this.frame(t));
    });
  }

  private effective(): { body: number; visual: number; auditory: number } {
    const m = this.model.intensity;
    if (forcedVisual === null) return { ...m };
    const v = forcedVisual;
    const s = m.visual > 0.01 ? v / m.visual : 1;
    return { body: Math.min(10, m.visual > 0.01 ? m.body * s : v), visual: v, auditory: Math.min(10, m.visual > 0.01 ? m.auditory * s : v * 0.9) };
  }

  private sample(): void {
    const i = this.effective();
    const s = { plasma: round3(this.model.plasma), body: round3(i.body), visual: round3(i.visual), auditory: round3(i.auditory) };
    this.events.log('intensity_sample', s);
    this.hud.push({ t: this.model.tMin, ...s });
  }

  private frame(now: number): void {
    if (this.ended) return;
    const dtWallMs = now - this.lastFrame;
    this.lastFrame = now;
    const dtWall = Math.min(0.1, Math.max(0, dtWallMs / 1000));
    const st = this.state;

    // replay inputs due at or before the current model time
    while (this.replayQueue.length && this.replayQueue[0].t <= this.model.tMin + 1e-9) this.replayQueue.shift()!.apply();
    if (this.ended) return;

    // ---- scrub sweep: v follows 0 → 10 → 0 linearly over sweepS seconds of wall time ----
    if (forcedSweep) {
      if (this.sweepStart < 0) this.sweepStart = st.wallTime;
      forcedVisual = sweepValue(st.wallTime - this.sweepStart, this.opts.scrub?.sweepS ?? 60);
    }

    // ---- model ----
    this.model.step((dtWall * CFG.timewarp) / 60);
    const t = this.model.tMin;
    const inten = this.effective();
    st.t_min = t;
    st.plasma = this.model.plasma;
    st.intensity = inten;
    st.wallTime += dtWall;
    st.forced = { visual: forcedVisual, layer: forcedLayer };
    const v = inten.visual;

    // ---- layer weights (+ fades) ----
    this.updateWeights(v, dtWall);
    this.checkEntries(v);
    this.checkExits();

    // ---- pulse: 0–1 oscillator, 0.08–0.5 Hz (wall time), scaled by intensity; never above 2 Hz ----
    const f = 0.08 + 0.42 * Math.min(1, v / 10);
    this.pulsePhase = (this.pulsePhase + f * dtWall) % 1;
    st.pulse = (0.5 - 0.5 * Math.cos(2 * Math.PI * this.pulsePhase)) * Math.min(1, v / 5);
    st.pulsePhase = this.pulsePhase;
    st.pulseHz = f;

    // ---- eyes (section 8.3 auto mode: open during onset, closed from visual 3), 2 s crossfade ----
    const eyesTarget = forcedEyes ?? (this.eyesMode === 'open' ? 0 : this.eyesMode === 'closed' ? 1 : smoothstep(2.5, 3.5, v));
    if (forcedEyes !== null && this.framesRendered === 0) st.eyesClosed = forcedEyes; // scrub: start settled
    st.eyesClosed += Math.max(-dtWall / 2, Math.min(dtWall / 2, eyesTarget - st.eyesClosed));

    // ---- look (user-initiated only, velocity-clamped) ----
    st.look = clampLook(st.look, this.lookTarget, dtWall);

    // ---- interaction (two-way communication, BUILD.md 11.7 item 5): key pulse decays over 1 s,
    //      mouse speed in screen diagonals per second, smoothed over ~0.25 s ----
    const ia = st.interaction ?? (st.interaction = { keyPulse: 0, lookVel: 0 });
    ia.keyPulse = Math.max(0, ia.keyPulse - dtWall);
    if (dtWall > 0) {
      const speed = Math.min(1, this.mouseDist / dtWall);
      ia.lookVel += (speed - ia.lookVel) * (1 - Math.exp(-dtWall / 0.25));
    }
    this.mouseDist = 0;

    // ---- director (scrub: keep a forced difficult passage running) ----
    if (forcedChallenge && !this.director.challenge.active && this.director.challenge.relief <= 0) {
      this.director.forceChallenge(t);
    }
    // a forced message is shown by the director as soon as the (forced) entity is present
    if (forcedMessage && !this.messageShown && this.director.entity.present) this.director.forceMessage(t, true);
    for (const e of this.director.update({ tMin: t, visual: v, latched: st.breakthroughLatched, letGo: st.letGo })) {
      this.events.log(e.type, e.payload, e.t_min);
      if (e.type === 'message_shown') { this.messageShown = true; this.captureMessagePending = true; }
      if (e.type === 'entity_appear') this.captureEntityPending = Number(e.payload.index ?? 0);
    }
    const de = this.director.entity;
    Object.assign(st.entity, de, { position: [de.position[0], de.position[1]] as [number, number] });
    st.challenge = { ...this.director.challenge };
    st.message = { ...this.director.message };
    st.sequence = { ...this.director.sequence };
    // frame captures (BUILD.md 11.7): the entity once it has faded in, the message at its full envelope
    // (the entity frame waits until the being has arrived: past its approach, bright and close)
    if (this.captureEntityPending !== null && st.entity.present && st.entity.behaviour !== 'approach'
      && st.entity.behaviour !== 'depart' && st.entity.intensity >= 0.75 && (st.entity.depth ?? 1) >= 0.6) {
      this.capture(`entity_${this.captureEntityPending}`);
      this.captureEntityPending = null;
    }
    if (this.captureMessagePending && (st.message.intensity ?? 0) >= 0.95) {
      this.capture('message');
      this.captureMessagePending = false;
    }

    // ---- audio (reads only the shared state); the microphone reading flows back through it ----
    st.mic = hs.audio?.mic ?? null;
    try { hs.audio?.update(st, dtWall); } catch (e) { console.warn('audio update failed', e); }

    // ---- render (the pipeline always ends with the SafetyLimiter) ----
    if (this.pipeline) {
      try { this.pipeline.render(st); } catch (e) { console.error(e); }
      this.quality?.frame(dtWallMs);
      this.framesRendered++;
      hs.renderStats = { frameMs: this.quality?.ema ?? 0, renderScale: this.pipeline.renderScale, frames: this.framesRendered };
      hs.readyForCapture = this.framesRendered >= 3 && pendingLoads === 0 && this.layersReady() && this.weightsSettled();
    }
    // layer_enter frames wait until the layer's drawn weight is ≥ 0.5, so the picture shows that layer
    // (NOTES D-F2); a layer that leaves again before that gets no frame
    if (this.pendingEnters.length && this.shown) {
      const shown = this.shown;
      this.pendingEnters = this.pendingEnters.filter((k) => {
        if (!this.active.has(k)) return false;
        if ((k === 'room' ? shown.roomDistortion : shown[k]) < Trip.SNAP.enterWeight) return true;
        this.capture(`layer_enter_${LAYER_NAMES[k]}`);
        return false;
      });
    }

    // ---- periodic snapshots for the report: at most 6, every 80 model-seconds while visual ≥ 0.8 (so they
    //      span the arc), never within 15 model-s of another capture (a due snap waits), never in scrub mode ----
    if (!this.opts.scrub && this.snapCount < Trip.SNAP.max && v >= Trip.SNAP.minV) {
      if (this.nextSnapT === null) this.nextSnapT = t + Trip.SNAP.everyS / 60;
      else if (t >= this.nextSnapT) {
        const gapMin = Trip.SNAP.minGapS / 60;
        if (this.lastCaptureT !== null && t - this.lastCaptureT < gapMin) this.nextSnapT = this.lastCaptureT + gapMin;
        else {
          this.snapCount++;
          this.nextSnapT = t + Trip.SNAP.everyS / 60;
          this.capture(`snap_${String(this.snapCount).padStart(2, '0')}`);
        }
      }
    }

    // ---- peak frame: first moment the visual intensity falls from its maximum ----
    if (v > this.maxV) this.maxV = v;
    if (!this.peakCaptured && this.maxV >= 0.5 && v < this.maxV - 0.05) {
      this.peakCaptured = true;
      this.capture('peak');
    }
    this.scrubber?.update();

    // ---- session end ----
    const mv = this.model.intensity.visual;
    if (mv >= LIMITS.endVisual) this.everAbove = true;
    if (t >= LIMITS.capMin) { this.end('cap'); return; }
    if (forcedVisual === null && forcedLayer === null && t >= LIMITS.minSessionMin && mv < LIMITS.endVisual) {
      const peaked = this.everAbove || mv < this.maxModelV - 0.01;
      if (peaked && !this.repeatPending()) { this.end('faded'); return; }
    }
    this.maxModelV = Math.max(this.maxModelV, mv);
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }
  private maxModelV = 0;

  /** Layers may expose `ready` (boolean or () => boolean) while they still load assets. */
  private layersReady(): boolean {
    for (const l of this.layers) {
      const r = (l as { ready?: boolean | (() => boolean) }).ready;
      if (r === false || (typeof r === 'function' && !r.call(l))) return false;
    }
    return true;
  }

  /** The drawn (faded) weights have reached their targets. */
  private weightsSettled(): boolean {
    if (!this.shown || !this.lw) return false;
    const target = this.forcedTarget(this.lw);
    for (const k of WEIGHT_KEYS) {
      const tk = k === 'waitingRoom' ? target[k] * (1 - this.shown.breakthrough) : target[k];
      if (Math.abs(this.shown[k] - tk) > 0.01) return false;
    }
    return true;
  }

  // ---- scrub / test hooks ----
  forceChallengeNow(): void { this.director.forceChallenge(this.model.tMin); }
  forceEntityNow(): void { this.director.forceEntity(this.model.tMin); }
  forceMessageNow(): void { this.director.forceMessage(this.model.tMin, true); }

  /** Apply the debug layer override: the forced layer fully present (room included), the other
   *  higher layers off; breakthrough forced = latched. */
  private forcedTarget(lw: LayerWeights): LayerWeights {
    if (!forcedLayer) return lw;
    const target = { ...lw };
    for (const k of WEIGHT_KEYS) {
      if (k === forcedLayer) target[k] = 1;
      else if (k !== 'room') target[k] = 0;
    }
    if (forcedLayer === 'breakthrough') target.breakthroughLatched = true;
    return target;
  }

  private repeatPending(): boolean {
    return this.model.depot > 1e-3;
  }

  /** computeLayerWeights (windows, hysteresis, latch) → debug layer override → advanceFade. */
  private updateWeights(v: number, dtWall: number): void {
    this.lw = computeLayerWeights(v, this.lw);
    const target = this.forcedTarget(this.lw);
    this.shown = advanceFade(this.shown, target, dtWall);
    const lw = this.state.layerWeights;
    for (const k of WEIGHT_KEYS) lw[k] = this.shown[k];
    lw.roomDistortion = this.shown.roomDistortion;
    lw.fieldModulation = this.shown.fieldModulation;
    this.state.breakthroughLatched = target.breakthroughLatched;
  }

  /** layer_enter once the layer's entry window is fully crossed (the same definition as the
   *  planner's predicted deepest layer and the stats; see NOTES.md). Checked on every model sub-step. */
  private checkEntries(v: number): void {
    let raw: LayerWeights | null = null;
    for (const k of WEIGHT_KEYS) {
      if (this.active.has(k) || v < ENTRY_V[k]) continue;
      raw = raw ?? computeLayerWeights(v, this.lw);
      const present = k === 'room' ? raw.roomDistortion : raw[k];
      if (present < LIMITS.enterThreshold && forcedLayer !== k) continue; // already replaced by a deeper layer
      this.active.add(k);
      this.events.log('layer_enter', { layer: LAYER_NAMES[k] });
      this.pendingEnters.push(k);
    }
  }

  /** layer_exit when the drawn weight (room: its distortion) has fallen below 0.01. */
  private checkExits(): void {
    if (!this.shown || !this.lw) return;
    for (const k of [...this.active]) {
      const shown = k === 'room' ? this.shown.roomDistortion : this.shown[k];
      const raw = k === 'room' ? this.lw.roomDistortion : this.lw[k];
      if (shown < LIMITS.enterThreshold && raw < LIMITS.enterThreshold) {
        this.active.delete(k);
        this.events.log('layer_exit', { layer: LAYER_NAMES[k] });
      }
    }
  }

  /** Capture the on-screen frame (after the SafetyLimiter) once per name → POST /frame. */
  private capture(name: string): void {
    if (this.captured.has(name) || !this.pipeline || !this.sessionId || !this.opts.post) return;
    this.captured.add(name);
    const tMin = this.model.tMin;
    this.lastCaptureT = tMin;
    const id = this.sessionId;
    const layer = this.deepestShownLayer();
    this.pipeline.captureFrame().then(async (blob) => {
      const b64 = await blobToBase64(blob);
      const r = await api.frame(id, name, round3(tMin), b64, layer);
      this.events.log('frame_captured', { name, path: r.path, layer }, tMin);
    }).catch((e) => console.warn('frame capture failed', e));
  }

  /** Report snapshots: periodic snap_01 … every `everyS` model-seconds while visual ≥ `minV` (at most `max`,
   *  never within `minGapS` of another capture); layer_enter_* once the layer's drawn weight ≥ `enterWeight`. */
  private static readonly SNAP = { everyS: 80, minV: 0.8, max: 6, minGapS: 15, enterWeight: 0.5 } as const;

  /** The deepest layer on screen right now, for captions ("2:10 · chrysanthemum"): the deepest
   *  entered layer whose drawn weight is at least 0.3 (deeper layers draw over shallower ones, so
   *  that is what the picture shows); the room when none is. (A plain "highest weight" would almost
   *  always say room, whose weight is 1 until the waiting room replaces it, and would call a fading
   *  but still dominant breakthrough "chrysanthemum".) */
  private deepestShownLayer(): string {
    let best: WeightKey = 'room';
    if (this.shown) {
      for (const k of WEIGHT_KEYS) {
        if (k !== 'room' && this.active.has(k) && this.shown[k] >= 0.3) best = k;
      }
    }
    return LAYER_NAMES[best];
  }

  private cue(text: string, ms: number): void {
    if (this.cueTimer) clearTimeout(this.cueTimer);
    this.cueEl.textContent = text;
    if (ms > 0) this.cueTimer = setTimeout(() => { this.cueEl.textContent = ''; }, ms);
  }

  private toggleEyes(): void {
    const closed = this.state.eyesClosed < 0.5;
    this.eyesMode = closed ? 'closed' : 'open';
    this.events.log('eyes_toggle', { closed, mode: this.eyesMode });
  }

  private letGoDown(): void {
    if (this.letGoStart !== null) return;
    this.letGoStart = this.model.tMin;
    this.state.letGo = true;
  }

  private letGoUp(): void {
    if (this.letGoStart === null) return;
    const d = (this.model.tMin - this.letGoStart) * 60;
    this.letGoStart = null;
    this.state.letGo = false;
    this.events.log('let_go_held', { duration_s: Math.round(d * 100) / 100 });
  }

  private buildReplayQueue(evs: LoggedEvent[]): void {
    const q: { t: number; apply: () => void }[] = [];
    for (const e of evs) {
      const t = e.t_min;
      if (e.type === 'hit' && Number(e.payload.n ?? 0) > 0) {
        const f = Number(e.payload.hold_fraction ?? 1);
        q.push({ t, apply: () => { if (this.model.addHit(DOSES[this.intake.dose_step] * f)) { this.repeat.count++; this.events.log('hit', { ...e.payload }); } } });
      } else if (e.type === 'eyes_toggle') {
        q.push({ t, apply: () => this.toggleEyes() });
      } else if (e.type === 'let_go_held') {
        const d = Number(e.payload.duration_s ?? 0) / 60;
        q.push({ t: Math.max(0, t - d), apply: () => this.letGoDown() });
        q.push({ t, apply: () => this.letGoUp() });
      } else if (e.type === 'exit_pressed') {
        q.push({ t, apply: () => this.end('escape') });
      }
    }
    q.sort((a, b) => a.t - b.t);
    this.replayQueue = q;
  }

  /** End the trip: Escape / exit corner ('escape'), natural fade ('faded') or the 30-minute cap. */
  end(reason: 'faded' | 'escape' | 'cap'): void {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    this.model.onSubStep = null;
    this.repeat.cancel();
    if (this.letGoStart !== null) this.letGoUp();
    const t = this.model.tMin;
    if (reason === 'escape') this.events.log('exit_pressed', {});
    for (const e of this.director.endNow(t)) this.events.log(e.type, e.payload, e.t_min);
    this.events.log('session_end', { reason });
    this.events.stop();
    setScreen('fade');
    try { if (reason === 'escape') hs.audio?.exitTone(); else hs.audio?.stop(3); } catch { /* audio is optional */ }
    const roomImg = this.script.room?.image;
    if (roomImg && this.sessionId) this.fadeEl.style.backgroundImage = `url("${sessionAssetUrl(this.sessionId, roomImg)}")`;
    requestAnimationFrame(() => this.fadeEl.classList.add('on'));
    const done = async () => {
      for (const off of this.offs) off();
      try { this.pipeline?.renderer.forceContextLoss(); this.pipeline?.dispose(); } catch { /* ignore */ }
      hs.pipeline = null;
      document.body.classList.remove('in-trip');
      activeTrip = null;
      hs.director = null;
      forcedLayer = null;
      forcedChallenge = false;
      forcedMessage = false;
      forcedEyes = null;
      forcedSweep = false;
      hs.readyForCapture = false;
      await this.events.flush();
      this.resolveEnd({ endMin: t, reason, events: this.events });
    };
    setTimeout(() => void done(), LIMITS.fadeMs);
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

// ---------------------------------------------------------------------------------------------
// flows

async function sessionFlow(): Promise<'new' | 'title'> {
  disposeSessionAudio();
  setScreen('safety');
  const s = await mountSafety(root);
  if (s === 'exit') return 'title';

  // session folder
  let seed = CFG.seed ?? clockSeed();
  let sessionId: string | null = null;
  try {
    const r = await api.createSession(seed);
    sessionId = r.id;
    seed = r.seed ?? seed;
  } catch {
    console.warn('back end not reachable: offline mode (nothing is saved)');
  }
  hs.sessionId = sessionId;

  // intake
  let intake = (CFG.autofill ? loadProfile(CFG.autofill, { dose: CFG.dose, gentle: CFG.gentle }, seed) : null)
    ?? loadProfile('neutral', { dose: CFG.dose, gentle: CFG.gentle }, seed) ?? defaultIntake(seed);
  if (!CFG.autofill) {
    // a real user starts from neutral answers with the default room
    intake.room = { source: 'default', image: null, depth: null };
  }
  intake.seed = seed;
  setScreen('intake');
  const ir = await mountSetup(root, { sessionId, intake, autofill: !!CFG.autofill });
  if (ir === 'title') return 'title';
  intake = ir;
  intake.hold_fraction = 1; // the planner predicts for a full hold; the real fraction is logged at the hit
  if (sessionId) {
    try { await api.intake(sessionId, intake); } catch (e) {
      await messageScreen('error', ['THE BACK END DID NOT ACCEPT THE INTAKE.', String(e)]);
      return 'title';
    }
  }

  // settle + hit on one screen (NOTES D-S2): 'settle' while preparing, 'hit' once armed
  setScreen('settle');
  let scriptP: Promise<TripScript> | null = null;
  const loadScript = (): Promise<TripScript> => (sessionId ? api.tripScript(sessionId) : Promise.resolve(offlineTripScript(intake)))
    .catch(() => offlineTripScript(intake));
  const hit = await mountPrepare(root, sessionId, {
    onReady: () => { setScreen('hit'); scriptP = loadScript(); },
  });
  if (hit === 'cancel') return 'title';
  if (hit === 'error') { await messageScreen('error', ['SOMETHING WENT WRONG WHILE PREPARING THE SESSION.']); return 'title'; }
  const script: TripScript = await (scriptP ?? loadScript());

  // trip
  createSessionAudio(intake);
  const trip = new Trip(sessionId, script, intake, hit, { post: !!sessionId });
  const result = await trip.run();

  // grounding (always, including after Escape)
  setScreen('grounding');
  const roomUrl = script.room?.image && sessionId ? sessionAssetUrl(sessionId, script.room.image) : null;
  try { hs.audio?.groundingAmbient(true); } catch { /* optional */ }
  await mountGrounding(root, { roomUrl, timewarp: CFG.timewarp });
  try { hs.audio?.stop(4); } catch { /* optional */ }

  // curve
  setScreen('curve');
  await mountCurve(root, { sessionId, endMin: result.endMin, events: result.events.all, post: !!sessionId });

  // finish → end screen
  if (sessionId) {
    try { await api.finish(sessionId); } catch { /* the end screen reports what is missing */ }
  }
  setScreen('end');
  const next = await mountEnd(root, { sessionId: sessionId ?? 'offline', instant: CFG.timewarp > 1 });
  disposeSessionAudio();
  return next;
}

/** Scrub mode (tests / galleries): session through the API with the autofilled intake, then
 *  straight into the trip with forced values. */
async function scrubFlow(sc: ScrubCfg): Promise<'new' | 'title'> {
  setScreen('scrub-setup');
  let seed = CFG.seed ?? clockSeed();
  let sessionId: string | null = null;
  let intake = loadProfile(CFG.autofill ?? 'neutral', { dose: CFG.dose ?? 'breakthrough', gentle: CFG.gentle }, seed)
    ?? defaultIntake(seed);
  let script: TripScript = offlineTripScript(intake);
  if (sc.session) {
    // &session=<id>: reuse an existing prepared session (its trip script, intake and assets); nothing is
    // created or planned, so galleries with real images are fast. The session's own seed wins over &seed.
    try {
      const r = await api.replay(sc.session);
      script = r.trip_script;
      seed = Number(r.seed ?? script.seed ?? seed);
      const saved = r.intake as unknown as Intake | null;
      if (saved && saved.answers && saved.options) intake = saved;
      if (CFG.gentle) intake.options = { ...intake.options, difficult_passages: false };
      sessionId = sc.session;
    } catch (e) {
      await messageScreen('error', [`SCRUB MODE: SESSION ${sc.session} IS NOT AVAILABLE.`, String(e)]);
      return 'title';
    }
  } else {
    try {
      const r = await api.createSession(seed);
      sessionId = r.id;
      seed = r.seed ?? seed;
    } catch {
      console.warn('scrub: back end not reachable: offline trip script');
    }
  }
  intake.seed = seed;
  intake.hold_fraction = 1;
  hs.sessionId = sessionId;
  if (sessionId && !sc.session) {
    try {
      await api.intake(sessionId, intake);
      const t0 = Date.now();
      for (;;) {
        const p = await api.progress(sessionId);
        if (p.ready) break;
        if (p.error || p.stage === 'error') throw new Error(p.error ?? 'planning failed');
        if (Date.now() - t0 > 180_000) throw new Error('planning timed out');
        await new Promise((r) => setTimeout(r, 250));
      }
      script = await api.tripScript(sessionId);
    } catch (e) {
      await messageScreen('error', ['SCRUB MODE: THE SESSION COULD NOT BE PREPARED.', String(e)]);
      return 'title';
    }
  }
  script = structuredClone(script);
  if (sc.sensitivity !== null) script.pharmacology = { ...script.pharmacology, sensitivity: sc.sensitivity };
  if ((sc.entity || sc.message) && !(script.breakthrough?.entities?.length)) {
    // forced entity on a trip script without beings: one procedural being (test convenience)
    script.breakthrough = { ...script.breakthrough, entities: offlineTripScript(intake).breakthrough.entities };
  }
  if (sc.message && !script.breakthrough.message?.present) {
    script.breakthrough = { ...script.breakthrough, message: { present: true, glyph_seed: seed % 100000 } };
  }
  if (sc.challenge) script.challenge = { ...script.challenge, occurs: false }; // forced below, not scheduled

  forcedVisual = sc.v;
  forcedLayer = sc.layer;
  forcedSweep = sc.sweep;
  forcedChallenge = sc.challenge;
  forcedMessage = sc.message;
  forcedEyes = sc.eyes;
  createSessionAudio(intake);
  const trip = new Trip(sessionId, script, intake, { holdFraction: 1, heldS: 4 }, { post: false, scrub: sc });
  const running = trip.run();
  if (sc.entity) trip.forceEntityNow();
  if (sc.message) trip.forceMessageNow();
  if (sc.challenge) trip.forceChallengeNow();
  await running;
  setScreen('grounding');
  try { hs.audio?.groundingAmbient(true); } catch { /* optional */ }
  await mountGrounding(root, { roomUrl: null, timewarp: CFG.timewarp });
  disposeSessionAudio();
  return 'title';
}

async function replayFlow(id: string): Promise<'new' | 'title'> {
  setScreen('replay-loading');
  let data;
  try { data = await api.replay(id); } catch {
    await messageScreen('error', [`NO REPLAY AVAILABLE FOR ${id}.`]);
    return 'title';
  }
  const intake = data.intake as unknown as Intake;
  const script = data.trip_script;
  const first = data.events.find((e) => e.type === 'hit' && Number(e.payload.n ?? 0) === 0);
  const hf = Number(first?.payload.hold_fraction ?? 1);
  const trip = new Trip(id, { ...script, seed: data.seed ?? script.seed }, intake, { holdFraction: hf, heldS: hf * 4 },
    { post: false, replay: data.events });
  await trip.run();
  setScreen('end');
  return mountEnd(root, { sessionId: id, instant: CFG.timewarp > 1, replay: true });
}

async function main(): Promise<void> {
  if (CFG.demoEnd) {
    setScreen('end');
    await mountEnd(root, { sessionId: CFG.demoEnd, instant: true });
    window.location.assign('/');
    return;
  }
  let next: 'new' | 'title' = CFG.autostart ? 'new' : 'title';
  if (SCRUB) next = await scrubFlow(SCRUB);
  else if (CFG.replay) next = await replayFlow(CFG.replay);
  for (;;) {
    if (next === 'title') await titleLoop();
    next = await sessionFlow();
  }
}

void main();
