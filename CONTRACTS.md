# CONTRACTS.md — interfaces every agent builds against (frozen at M0)

Read BUILD.md first. This file pins the concrete interfaces that BUILD.md leaves open, so that
parallel agents produce parts that fit together. Change only with a note in NOTES.md.

## Repository root
`/home/mstock/Code/hyperspace` (decision D1 in NOTES.md). Python via `uv run` (venv `.venv`, Python 3.12).
Node 24 at `~/.local/bin/node`. Front end in `frontend/` (Vite + TypeScript + three). Never use `sudo`.

## Back-end HTTP API (FastAPI, `backend/app.py`, port 8765, bound to 127.0.0.1 only)
All JSON. Prefix `/api`. The built front end (`frontend/dist`) is served at `/`; session files at `/sessions/{id}/...`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/status` | → `{ "resident_models": [], "versions": {...}, "fallbacks": [...], "llm": {"runtime": "ollama"|"none", "model": "...", "host": "..."}, "images": "sdxl_lightning"|"sdxl_turbo"|"procedural", "ok": true }` |
| GET | `/api/sessions` | → `[{ "id": "2026-10-10_1530", "date": "...", "dose_step": "...", "peak_visual": 8.6, "deepest_layer": "...", "beings": "1 · JESTER", "has_report": true }]` |
| POST | `/api/session` | `{ "seed": int|null }` → `{ "id": "YYYY-MM-DD_HHMM[_n]", "seed": int }` (creates `sessions/<id>/` with `frames/`, `figures/`, `assets/`) |
| POST | `/api/session/{id}/room` | multipart: `file` (image), `kind`: `photo`|`panorama` → `{ "image": "assets/room.jpg", "depth": "assets/room_depth.png", "source": "photo"|"panorama" }` (strips EXIF, max 2048 px long side) |
| POST | `/api/session/{id}/intake` | an `intake.json` instance → `{ "accepted": true }`; starts planning + asset generation in a background thread |
| GET | `/api/session/{id}/progress` | → `{ "stage": "queued"|"planning"|"room"|"images"|"unloading"|"ready"|"error", "lines": [{"label": "Preparing your room", "done": bool, "detail": "..."}, {"label": "Imagining the other side", ...}, {"label": "Clearing the table", ...}], "ready": bool, "error": str|null }` |
| GET | `/api/session/{id}/trip_script` | → the `trip_script.json` instance (404 until ready) |
| POST | `/api/session/{id}/events` | `{ "events": [ {t_min, type, payload}, ... ] }` → `{ "count": int }` (appends to `event_log.jsonl`) |
| POST | `/api/session/{id}/frame` | `{ "name": "layer_enter_chrysanthemum", "t_min": 2.1, "png_base64": "..." }` → `{ "path": "frames/<name>.png" }` |
| POST | `/api/session/{id}/curve` | `{ "points": [[t_min, intensity], ...] }` → `{ "ok": true }` (writes `curve.json`) |
| POST | `/api/session/{id}/finish` | `{}` → `{ "started": true }`; runs memory model → writer → figures → HTML in a background thread |
| GET | `/api/session/{id}/report_status` | → `{ "stage": "memory"|"writing"|"figures"|"html"|"done"|"error", "done": bool, "report_html": "/sessions/<id>/report.html"|null, "error": str|null }` |
| GET | `/api/session/{id}/stats` | → the stats object below (computed by `backend/report/stats.py:compute_stats`) |
| GET | `/api/session/{id}/replay` | → `{ "seed", "trip_script", "events": [...], "intake" }` |

Environment variables read by the back end: `HYPERSPACE_FORCE_TEMPLATES=1` (never call the LLM),
`HYPERSPACE_NO_IMAGES=1` (never load image models; procedural assets), `HYPERSPACE_OLLAMA_HOST`
(default `http://127.0.0.1:11435`), `HYPERSPACE_LLM_MODEL` (default from `verification/env.json`),
`HYPERSPACE_SESSIONS_DIR` (default `./sessions`), `REPORT_EXPORT_DIR`, `HF_HUB_OFFLINE=1`,
`TRANSFORMERS_OFFLINE=1`. The socket guard (`backend/safety/socket_guard.py`) is installed at app start-up
and refuses any non-loopback outbound connection.

## Session folder (`sessions/<id>/`)
`intake.json`, `trip_script.json`, `event_log.jsonl`, `curve.json`, `stats.json`, `assets/` (room.jpg,
room_depth.png, world_*.png, entity_*_{a,b,c}.png), `frames/`, `figures/`, `simulated-trip-report.md`,
`report.html`, `report.json` (writer output incl. inferred-sentence tags), `planner.log`.

## Stats object (one function, `compute_stats(trip_script, events, curve|None, intake)`)
```json
{ "date": "2026-10-10", "dose_step": "BREAKTHROUGH", "inhaled_pct": 100, "repeat_hits": 0,
  "peak_visual": 8.6, "time_to_peak": "1:49", "duration": "11:06", "deepest_layer": "BREAKTHROUGH",
  "beings_met": "1 · JESTER", "message": "RECEIVED", "difficult_passage": "NONE",
  "memory_match_pct": 75, "ended_early_at": null, "session_minutes": 15.0,
  "sparkline_real": "▁▄▇▇...", "sparkline_you": "▁▆██...", "box": ["╔═══...╗", "...", "╚═══╝"] }
```
`box` is the exact 46-column stats box of BUILD.md §15.3, one string per line, so the end screen, the
report and the tests print the identical thing. Peak is one decimal. Durations `m:ss`.
Layer order for "deepest": none < onset < form_constants < chrysanthemum < waiting_room < breakthrough.
Layer names in events and scripts use snake_case: `room`, `form_constants`, `chrysanthemum`, `waiting_room`, `breakthrough`
(`onset` is the pseudo-layer for visual intensity ≥ 0.5 without any other layer).

## Front-end structure (`frontend/src/`)
- `main.ts` — the screen state machine: title → safety → intake → settle → hit → trip → grounding → curve → end → report.
- `api.ts` — typed fetch wrappers for the API above (relative URLs only, so Vite's proxy and the production server both work).
- `state.ts` — `SharedState` exactly as BUILD.md §11.1 plus `seed`, `tripScript`, `timewarp`, `rng`.
- `pharmacology.ts` — RK4 model, `class PharmacologyModel { constructor(params, sensitivity, clearance); step(dtMin); addHit(dose): boolean; readonly plasma; readonly intensity: {body, visual, auditory}; readonly tMin }`. Fixed sub-step 1/600 min, independent of frame rate and timewarp.
- `layerWeights.ts` — `computeLayerWeights(v, prev): LayerWeights` with the §11.2 windows and 0.5 hysteresis + breakthrough latch.
- `director.ts` — drives entities/behaviours/message/challenge from the trip script and emits events.
- `events.ts` — `EventLog` with `log(type, payload)`, batching `POST /events` every 2 s and on `session_end`; `t_min` from the model clock.
- `pipeline.ts` — `class RenderPipeline` owning the WebGLRenderer, render targets, the layer list and the **final** `SafetyLimiter` pass. `pipeline.render(state)`: every layer renders into the scene target, then `limiter.render(sceneTarget.texture)` draws to the screen. `pipeline.passes` (readonly array of names) always ends with `'SafetyLimiter'`; `frontend/tests/pipeline.test.ts` asserts this, also with `?debug=1`.
- `safety/safetyLimiter.ts` — `class SafetyLimiter { constructor(renderer: THREE.WebGLRenderer); render(input: THREE.Texture, w: number, h: number): void; onEngaged(cb: (info: {kind: 'general'|'red', tiles: number}) => void): void; engaged: boolean; }`. Thresholds in `safety/thresholds.ts` (protected).
- `safety/comfort.ts` — camera-motion limits.
- `layers/*.ts` — each layer: `interface Layer { name: string; init(renderer, state): void; resize(w, h): void; render(renderer, state, target: THREE.WebGLRenderTarget | null): void; dispose(): void }`. Layers composite additively/alpha into the shared scene target in order room → form_constants → chrysanthemum → waiting_room → breakthrough, each multiplying by its `state.layerWeights[name]`.
- `ui/` — plain HTML/CSS/TS screens; `ui/retro.css` holds the §15.1 style; each screen is `mountX(root: HTMLElement, ctx): Promise<Result>`.
- `ui/stats.ts` — fetches `/api/session/{id}/stats` and renders `box` + sparklines; no computation.
- `debugScrubber.ts` — enabled by `?debug=1`; sets `state.intensity.visual` directly and forces layers/entity/message/challenge.
- URL params: `?debug=1`, `?timewarp=N`, `?autofill=<profile>`, `?seed=<int>`, `?autostart=1` (skip title: go straight to safety screen; test convenience).

## Test hooks (Playwright, `tests/e2e/`)
Test ids: `data-testid="safety-checkbox"`, `"safety-continue"`, `"intake-next"`, `"intake-option-<value>"`, `"intake-slider"`,
`"hit-button"`, `"trip-canvas"`, `"exit-corner"`, `"grounding"`, `"curve-canvas"`, `"curve-done"`, `"end-screen"`, `"end-box"`,
`"read-report"`, `"title-screen"`. `window.__hyperspace` exposes `{ state, events: EventLog, screen: string, pipeline, forceIntensity(v), finishEarly() }` for tests only.
Profiles: `tests/e2e/profiles/neutral.json` is a full `intake.json` with neutral answers (clarity 5, set 0, absorption 5/5/5, surrender 5, curiosity, no expectations, default room, strong dose, difficult on, eyes auto, audio on).
`?autofill=<profile>&dose=<step>&gentle=1` override individual fields for tests.

## Events (`event_log.jsonl`)
`{"t_min": float, "type": string, "payload": object}`; types exactly as BUILD.md §6.3. `intensity_sample` payload:
`{ "plasma", "body", "visual", "auditory" }`. `layer_enter`/`layer_exit` payload `{ "layer": name }`. `hit` payload
`{ "dose_step", "dose_rel", "hold_fraction", "n": 0|1|2|3 }`. `session_end` payload `{ "reason": "faded"|"escape"|"cap" }`.

## Amendments recorded at M3 integration (details in NOTES.md)
- Schema files are `shared/schemas/<name>.schema.json` (incl. `expansion.schema.json`), D-C1.
- `PharmacologyModel` starts with no dose; the first hit is `addHit` too; extra members `canHit()`, `repeatHitsUsed/Remaining`, `depot`, `subSteps`, `onSubStep` (D-C7).
- `computeLayerWeights` also returns `roomDistortion`, `fieldModulation`, `vEff`, `breakthroughLatched`; breakthrough fades via `advanceFade(prev, target, wallDtSec)` (D-C8).
- `SafetyLimiter(renderer, { now }?)` with a read-only `status`; `RenderPipeline(canvas, { debug, renderer?, maxPixelRatio? })`; layers write LINEAR RGB into the scene target and never clear it (S4).
- `layer_enter` fires when the entry window is fully crossed (form_constants 3.0, chrysanthemum 5.2, waiting_room 7.6, breakthrough latch 8.0), `layer_exit` on the 0.01 weight crossing (D-F1).
- `window.__hyperspace` also has `sessionId`, `audioContext`, `drawCurve`, `audio?.exitTone()` (D-F integration notes).
- Waiting-room kinds `kifs|mandelbox`; `challenge.onset_offset_s` is seconds after the predicted peak (B2, B3).

## Multi-agent dev servers (added for M4–M8)
Each agent runs its own stack so builds and sessions never collide:
- back end: `HYPERSPACE_SESSIONS_DIR=verification/tmp/<agent>/sessions HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1 uv run uvicorn backend.app:app --host 127.0.0.1 --port <P>` (P in 8771–8779; `run.sh` also honours `HYPERSPACE_PORT`)
- front end dev server (serves TS directly, no shared dist): `cd frontend && HYPERSPACE_API=http://127.0.0.1:<P> npx vite --port <5174–5179> --strictPort`
- Playwright: `E2E_BASE_URL=http://127.0.0.1:<vite port> npx playwright test <spec>` (the config skips its webServer when E2E_BASE_URL is set).
Never run `npx vite build` while another agent may be running one (the lead and the integration agent build).
`state.fieldTexture` is a `THREE.Texture` (256×256, R = activity in 0–1 after the contrast cap, G = raw u, B = slow drift phase) set every frame by the neural-field layer; it is `null` until that layer has rendered once, so readers must fall back gracefully.

## Amendments (assets-backend, M8)
- `assets/room_depth.png`: 8-bit greyscale PNG, same size as `assets/room.jpg` (≤ 2048 px long side), **white = near, black = far**, normalised to the 1st–99th percentile (Depth Anything V2 Small, or the synthetic fallback with the same convention). Panorama depth is continuous across the 360° seam. `assets/room_meta.json`: `{source, size, depth_source: "depth_anything_v2_small"|"synthetic", depth_convention, vram}`.
- `POST /room`: a 2:1 image (±5%) is a panorama (source "panorama", snapped to exactly 2:1) when sent as panorama or when ≥ 1500 px wide; a non-2:1 "panorama" is a photo.
- `breakthrough.world.image` / `.images`: 2048×1024 seamless equirect PNGs (`assets/world_<k>.png`) whenever a world is planned; `world.procedural` says generated (false) vs procedural (true). Poles calmed; §4.1 pattern contrast verified on 24 views.
- `breakthrough.entities[i].sprites`: `assets/entity_<i>_{a,b,c}.png`, RGBA square ≤ 1024, straight alpha, when `procedural` is false. Procedural beings: `sprites: []`, extra key `glyph_sprites` (same three-file format).
- `assets/manifest.json` (fixed path; `provenance` stays `{planner, images}`): `{backend, filter{status}, plan, budget{images_generated, generation_seconds}, assets[{path, kind: room_depth|world|entity, index, variant, generator, seed, prompt, negative_prompt, guidance, filter{ok, reasons, scores}, rejections[], cutout{method, halo}, seam, pattern, people_score, background}], rejections[], fallbacks[], phases (torch VRAM per phase), unload{allocated_mb, resident, ok}}`. Flagged images are never written to disk; accepted raw entity images are kept as `assets/raw/entity_<i>_<v>.jpg`.
- `generate_assets(..., progress)` calls `progress(stage, detail)` with stage `room` | `images` | `unloading`.

## Amendments (integration M4–M8)
- `SharedState.layerWeights` also carries the faded `roomDistortion?` and `fieldModulation?` (0–1, set by main.ts); `fieldTexture: THREE.Texture | null`; additive optional fields `pulsePhase?`, `pulseHz?` (pulse oscillator) and `mic?: {level, centroid} | null` (microphone, only when the option is on and granted). Layers and audio still read only the shared state.
- `window.__hyperspace.audio` is a `HyperspaceAudio` (frontend/src/audio/index.ts), created after the hit, disposed after the end screen. Volume keys `-`/`+` (also `_`/`=`) on every screen; `data-testid="volume"` is the transient "VOL nn%" indicator.
- Scrub mode (D-G1), `window.__hyperspace.{forceLayer, forceChallenge, forceEntity, forceMessage, setEyes, readyForCapture, renderStats}` (D-G3) and the layer hooks `readField()/fieldInfo()/fieldOverride` (D-NF5) are test-only additions; none of them touches the SafetyLimiter.
- `/api/session/{id}/progress`: `stage` now also takes `room`/`images`/`unloading` from the asset pipeline while it runs, and the three lines carry the asset pipeline's details (D-I8).

## Amendments (guard agent, S8 periodicity-aware pattern guard)
- `SafetyLimiter.status` (read-only) also has `periodicFraction` (tiles with periodicity score >= `GUARD_PERIODICITY_MIN` 0.5) and `contrastFraction` (high-contrast tiles regardless of periodicity, i.e. the pre-S8 count); `highContrastFraction` now means periodic (3×3-dilated) AND high-contrast tiles, which is what the guard counts. Exported: `GUARD_PERIODICITY_MIN`, `type LimiterStatus`. Diagnostics-only methods: `periodicityMap(): Float32Array` (64×36, row 0 = bottom) and `timeAnalysis(input, iterations): {baseMs, withPeriodicityMs}`. Nothing disables the limiter or the guard. `frontend/src/safety/periodicity.ts` exports the pure-TS reference (`periodicityScore(profile)`, `sampleProfile`, `pixelPeriodicity`, `gridPeriodicity`, `tilePeriodicity`, `dilatePeriodic`, `fillEnclosed` and the analysis constants).
- Safety test page `safety-test.html?pattern=<p>`: `bw10 red8 stripes static` (unchanged) and the static Michelson-0.9 patterns `rings` (30 px) `hex` (24 px) `diag` (45°, 12 px) `checker` (16 px) `bigstripes` (80 px) `thinlines` (2-px lines every 40 px), aperiodic `photo` (`/safety-test/room.jpg`, full width, top-aligned; `&src=<same-origin url>`, `&crop=<zoom>,<fx>,<fy>`) and `blobs`, and `custom&frag=<urlencoded GLSL>` (the body of `vec3 pattern(vec2 uv, float t)` returning LINEAR RGB, or a full source defining it; uniforms `uRes`, `uTime`). `&area=<0..1>` shows any pattern only in a centred rectangle of that screen fraction (black elsewhere).
- `window.__limiter` (test page only) keeps `pattern, engagedCount, lastInfo, frames, engaged, webgl2, renderer, passes, status()` and adds `area, ready` (pattern/photo texture in use), `shaderError`, `firstFrameMs`, `live` (status copied every frame), `history` (per-frame `{frame, t, engaged, patternGuard, highContrastFraction, periodicFraction, contrastFraction, meanLuminance}` for the first 1200 frames), `periodicityMap()` (64×36, row 0 = top), `timeAnalysis(n)`, `capturePre()` / `capturePost()` (PNG data URLs of the scene before the limiter and of the screen after it).
- Spec `tests/e2e/safety-guard.spec.ts` (needs only the Vite dev server: `E2E_BASE_URL=http://127.0.0.1:<vite> npx playwright test safety-guard`, headed Chrome on DISPLAY) writes `verification/captures/guard-<name>/`.

## Amendments (guard-fix agent, S8b stripe-aware pattern guard)
- `LimiterStatus` also has `stripeFraction` (tiles passing the S8b stripe test, any contrast); `highContrastFraction` now counts pattern tiles = periodic OR stripe (3×3-dilated, plus enclosed tiles) that are high-contrast with range > `GUARD_RANGE_MIN` (new export of safetyLimiter.ts, 0.02). Diagnostics-only `stripeMap(): Uint8Array` (64×36, row 0 = bottom). `periodicity.ts` additionally exports the stripe reference (`countTransitions`, `stripeTransitions`, `centralStart`, `profilePosition`, `tensorOrientation`, `structureTensor`, `pixelStripe`, `gridStripe`, `gridProfile`, `dilateMask`) and the `STRIPE_*` / `GRID_CENTRAL_*` / `GLOBAL_MIN_TRANSITIONS` constants; `limiterShaders.ts` exports `TENSOR_FRAG` and `GUARD_CF_FRAG`. Still exactly two readbacks per frame; nothing disables the limiter or the guard.
- Safety test page: `window.__limiter.stripeMap()` (row 0 = top) and `stripeFraction` in each `history` entry.
- `tests/e2e/safety-guard.spec.ts` has 53 cases (~8 min; 43 S8b evasions); `capture()` takes `{ seconds, after }` (an action right after navigation, e.g. `setRenderScale(0.5)`).

## Amendments (guard-fix agent, S8c local-spectrum pattern guard)
- `LimiterStatus` also has `spectralFraction` (tiles whose 4- or 8-tile window is spectrally sparse, any contrast); `highContrastFraction` counts periodic or stripe tiles (3×3-dilated) OR spectral tiles (undilated), plus enclosed tiles, that are high-contrast. Diagnostics-only `spectralMap(): Uint8Array` (64×36, row 0 = bottom). `periodicity.ts` additionally exports `spectralPeaks`, `spectralTop3`, `spectralHann`, `spectralOrigin` and the `SPECTRAL_*` constants (`SPECTRAL_TOP3_MIN` 0.75); `limiterShaders.ts` exports `SPEC_STATS/ROW/COL/STRIP/PICK_FRAG`, `SLEW_TILE_FRAG`, `SLEW_GLOBAL_FRAG` and `SPEC_COLS/ROWS/KX2/KY2`. The reduce pass now writes sqrt(min), sqrt(max) and kind bits in alpha (≥ 128 = pattern). While the flash backstop is engaged the output pass uses one step factor per frame. Still exactly two readbacks per frame; nothing disables the limiter or the guard.
- Safety test page: `window.__limiter.spectralMap()` (row 0 = top) and `spectralFraction` in each `history` entry.
- `tests/e2e/safety-guard.spec.ts` has 87 cases (~13 min; 34 S8c evasions, of which one legal pattern must NOT engage the guard).
