// Hyperspace front end: the session state machine (BUILD.md section 5.1)
// title → safety → intake → settle → hit → trip → grounding → curve → end → report.
// URL parameters: ?debug=1 ?timewarp=N ?autofill=<profile> ?dose=<step> ?gentle=1 ?seed=<int>
// ?autostart=1 (skip the title) ?replay=<id> ?demoEnd=<id>. None of them affects the SafetyLimiter.

import './ui/retro.css';
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
import { mountScrubber } from './debugScrubber';
import { createRoomLayer } from './layers/room';
import { createNeuralFieldLayer } from './layers/neuralField';
import { createHyperbolicLayer } from './layers/hyperbolic';
import { createWaitingRoomLayer } from './layers/waitingRoom';
import { createBreakthroughLayer } from './layers/breakthrough';
import { mountTitle } from './ui/title';
import { mountSafety } from './ui/safetyScreen';
import { mountIntake } from './ui/intake';
import { mountSettle } from './ui/settle';
import { mountHit, RepeatHits, type HitResult } from './ui/hit';
import { Hud } from './ui/hud';
import { mountGrounding } from './ui/grounding';
import { mountCurve } from './ui/curveDraw';
import { mountEnd } from './ui/endScreen';
import { mountPastSessions } from './ui/pastSessions';
import { mountAbout } from './ui/about';
import { clearScreenHandlers, h, onKey, params, screen } from './ui/dom';

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
  audioContext?: AudioContext;
  audio?: { exitTone?: () => void; [k: string]: unknown };
  drawCurve?: (pts: [number, number][]) => void;
  [k: string]: unknown;
}

const w = window as unknown as { __hyperspace: HyperspaceHooks };
const hs: HyperspaceHooks = Object.assign(w.__hyperspace ?? {}, {
  state: null, events: null, screen: 'boot', pipeline: null, sessionId: null,
  forceIntensity: (v: number | null) => { forcedVisual = v === null || v === undefined ? null : Math.max(0, Math.min(10, Number(v))); },
  finishEarly: () => { activeTrip?.end('escape'); },
});
w.__hyperspace = hs;
let forcedVisual: number | null = null;
let forcedLayer: WeightKey | null = null;
let activeTrip: Trip | null = null;

function setScreen(name: string): void {
  hs.screen = name;
  document.body.dataset.screen = name;
}

const root = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------------------------------------
// screens helpers

/** Resolve with 'escape' if Escape is pressed before `p` resolves (pre-trip screens). */
function escapable<T>(p: Promise<T>): Promise<T | 'escape'> {
  return new Promise((resolve) => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { cleanup(); clearScreenHandlers(); resolve('escape'); } };
    const cleanup = () => window.removeEventListener('keydown', onEsc);
    window.addEventListener('keydown', onEsc);
    p.then((v) => { cleanup(); resolve(v); });
  });
}

function messageScreen(name: string, lines: string[], hint = '[ENTER] TITLE'): Promise<void> {
  setScreen(name);
  const el = screen(root, name);
  el.appendChild(h('div', { class: 'col' }, ...lines.map((l) => h('p', {}, l)), h('div', { class: 'term' }, hint)));
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
  private pendingCaptures: string[] = [];
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
  private scrubber: { update: () => void } | null = null;
  private replayQueue: { t: number; apply: () => void }[] = [];
  private offs: (() => void)[] = [];

  constructor(
    private sessionId: string | null,
    private script: TripScript,
    private intake: Intake,
    private hit: HitResult,
    private opts: { post: boolean; replay?: LoggedEvent[] },
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
      });
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

    // ---- eyes (section 8.3 auto mode: open during onset, closed from visual 3), 2 s crossfade ----
    const eyesTarget = this.eyesMode === 'open' ? 0 : this.eyesMode === 'closed' ? 1 : smoothstep(2.5, 3.5, v);
    st.eyesClosed += Math.max(-dtWall / 2, Math.min(dtWall / 2, eyesTarget - st.eyesClosed));

    // ---- look (user-initiated only, velocity-clamped) ----
    st.look = clampLook(st.look, this.lookTarget, dtWall);

    // ---- director ----
    for (const e of this.director.update({ tMin: t, visual: v, latched: st.breakthroughLatched, letGo: st.letGo })) {
      this.events.log(e.type, e.payload, e.t_min);
      if (e.type === 'entity_appear') this.capture(`entity_${String(e.payload.index ?? 0)}`);
      if (e.type === 'message_shown') this.capture('message');
    }
    Object.assign(st.entity, this.director.entity);
    st.challenge = { ...this.director.challenge };
    st.message = { ...this.director.message };

    // ---- render (the pipeline always ends with the SafetyLimiter) ----
    if (this.pipeline) {
      try { this.pipeline.render(st); } catch (e) { console.error(e); }
      this.quality?.frame(dtWallMs);
    }
    for (const name of this.pendingCaptures.splice(0)) this.capture(name);

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

  private repeatPending(): boolean {
    return this.model.depot > 1e-3;
  }

  /** computeLayerWeights (windows, hysteresis, latch) → debug layer override → advanceFade. */
  private updateWeights(v: number, dtWall: number): void {
    this.lw = computeLayerWeights(v, this.lw);
    let target = this.lw;
    if (forcedLayer) {
      target = { ...this.lw };
      for (const k of WEIGHT_KEYS) if (k !== 'room') target[k] = k === forcedLayer ? 1 : 0;
      if (forcedLayer === 'breakthrough') target.breakthroughLatched = true;
    }
    this.shown = advanceFade(this.shown, target, dtWall);
    const lw = this.state.layerWeights;
    for (const k of WEIGHT_KEYS) lw[k] = this.shown[k];
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
      this.pendingCaptures.push(`layer_enter_${LAYER_NAMES[k]}`);
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
    const id = this.sessionId;
    this.pipeline.captureFrame().then(async (blob) => {
      const b64 = await blobToBase64(blob);
      const r = await api.frame(id, name, round3(tMin), b64);
      this.events.log('frame_captured', { name, path: r.path }, tMin);
    }).catch((e) => console.warn('frame capture failed', e));
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
    try { hs.audio?.exitTone?.(); } catch { /* audio is optional */ }
    const roomImg = this.script.room?.image;
    if (roomImg && this.sessionId) this.fadeEl.style.backgroundImage = `url("${sessionAssetUrl(this.sessionId, roomImg)}")`;
    requestAnimationFrame(() => this.fadeEl.classList.add('on'));
    const done = async () => {
      for (const off of this.offs) off();
      try { this.pipeline?.renderer.forceContextLoss(); this.pipeline?.dispose(); } catch { /* ignore */ }
      hs.pipeline = null;
      document.body.classList.remove('in-trip');
      activeTrip = null;
      forcedLayer = null;
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
  const ir = await escapable(mountIntake(root, { sessionId, intake, autofill: !!CFG.autofill }));
  if (ir === 'escape') return 'title';
  intake = ir;
  intake.hold_fraction = 1; // the planner predicts for a full hold; the real fraction is logged at the hit
  if (sessionId) {
    try { await api.intake(sessionId, intake); } catch (e) {
      await messageScreen('error', ['THE BACK END DID NOT ACCEPT THE INTAKE.', String(e)]);
      return 'title';
    }
  }

  // settle
  setScreen('settle');
  const sr = await mountSettle(root, sessionId);
  if (sr === 'cancel') return 'title';
  if (sr === 'error') { await messageScreen('error', ['SOMETHING WENT WRONG WHILE PREPARING THE SESSION.']); return 'title'; }
  let script: TripScript;
  try { script = sessionId ? await api.tripScript(sessionId) : offlineTripScript(intake); } catch {
    script = offlineTripScript(intake);
  }

  // hit
  setScreen('hit');
  const hit = await escapable(mountHit(root));
  if (hit === 'escape') return 'title';

  // trip
  const trip = new Trip(sessionId, script, intake, hit, { post: !!sessionId });
  const result = await trip.run();

  // grounding (always, including after Escape)
  setScreen('grounding');
  const roomUrl = script.room?.image && sessionId ? sessionAssetUrl(sessionId, script.room.image) : null;
  await mountGrounding(root, { roomUrl, timewarp: CFG.timewarp });

  // curve
  setScreen('curve');
  await mountCurve(root, { sessionId, endMin: result.endMin, events: result.events.all, post: !!sessionId });

  // finish → end screen
  if (sessionId) {
    try { await api.finish(sessionId); } catch { /* the end screen reports what is missing */ }
  }
  setScreen('end');
  return mountEnd(root, { sessionId: sessionId ?? 'offline', instant: CFG.timewarp > 1 });
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
  if (CFG.replay) next = await replayFlow(CFG.replay);
  for (;;) {
    if (next === 'title') await titleLoop();
    next = await sessionFlow();
  }
}

void main();
