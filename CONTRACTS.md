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
