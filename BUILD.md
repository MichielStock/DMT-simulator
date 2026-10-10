# BUILD.md — Hyperspace simulator

A drug-free, GPU-rendered simulation of what an inhaled N,N-dimethyltryptamine (DMT) experience looks and sounds like, driven by a pharmacological model and the published phenomenology literature.

You "take a hit" at a chosen dose step. A pharmacokinetic–pharmacodynamic model tracks the drug in the blood and at the effect site. That intensity drives five visual layers (room distortions, form constants, hyperbolic geometry, a "waiting room", and the breakthrough world with its beings) plus synthesised sound. Before the hit, a short intake (questions and a photo of your room) shapes the trip. Afterwards, the simulator writes a trip report as you would remember it.

Everything runs locally on one Linux machine with a 24 GB NVIDIA card.

---

## 0. Instructions for the building agent — read this first

### 0.1 Mission

Build the complete, finished product described in this file **in one autonomous run**. Nobody will answer questions or review checkpoints during the build. You are done when, and only when:

1. `scripts/verify_all.sh` exits 0 on the target machine, and
2. `DONE.md` exists, generated from the verification results (section 16.6), and
3. `./run.sh` starts the product and a person can complete a full session without touching a terminal again.

Stretch goals (milestone M12) come **after** that, and only if they keep `verify_all.sh` green.

### 0.2 Autonomy rules

- **Never stop to ask.** When something is ambiguous, use the decision defaults (section 0.5). If they do not cover it, choose the simplest option consistent with this file, record it under "Decisions" in `NOTES.md`, and continue.
- **Safety beats everything.** If a safety requirement (section 4) conflicts with realism, performance, a milestone or a default, choose the safer behaviour, record it, and continue. Never weaken, bypass or make optional anything in section 4.
- **Never game the checks.** Do not loosen thresholds, delete tests, special-case test inputs, or edit protected files (section 0.7) to make checks pass. Fix the product instead.
- **Three strikes, then fall back.** If a component still fails after three serious, different attempts, switch to its fallback (section 0.6), record why, and keep going. The finished product must work end to end even with every fallback active.
- **Core is mandatory, stretch is optional.** Skipping a stretch item is fine. Skipping a core requirement is not.
- **No privileged installs.** Do not use `sudo`. Prefer user-space installs (`uv`, `npm`, pip wheels, standalone binaries in `~/.local`). If something truly needs root, use its fallback and record it.
- **Network only during setup.** Downloads happen in `scripts/setup.sh` and `scripts/fetch_models.py`. The finished product runs fully offline (section 4.6).
- **Look at your own output.** You can open PNG files with your file-reading tool. Use this to inspect every gallery and capture (section 16.4). Never declare a visual milestone passed without having looked at its images.

### 0.3 Order of work: walking skeleton first

1. Setup, contracts and the pharmacology (M0–M1).
2. The safety limiter (M2), before any intense visuals exist.
3. **A thin end-to-end session with placeholders (M3):** safety screen → minimal intake → templated plan → simple placeholder shader per layer → grounding → curve → templated report. From M3 onward, the end-to-end test must stay green after every milestone.
4. Replace placeholders one layer or module at a time (M4–M10), keeping everything runnable.
5. Validation, polish, verification and `DONE.md` (M11).

Commit to git at the end of every milestone with a message naming it.

### 0.4 Resuming after interruptions or context compaction

Keep `PROGRESS.md` as a checklist of milestones and their gates, with one line of status each. At the start of every work block, read `PROGRESS.md`, the "Decisions" and "Fallbacks active" sections of `NOTES.md`, and the section of this file you are working on. Keep tool output short (tail logs, summarise test results) so long runs stay within context.

### 0.5 Decision defaults

| Topic | Default |
|---|---|
| Project directory | `hyperspace-sim/` |
| Product name shown to users | Hyperspace |
| Launch | `./run.sh`: builds the front end if needed, starts the back end, opens the default browser at `http://localhost:8765` |
| Back-end port | 8765 (also serves the built front end) |
| Front-end dev server | 5173 (`./run.sh --dev`) |
| Python | 3.11+, managed with `uv` |
| Node | 20 LTS or newer, `npm` |
| Language-model runtime | Ollama on `localhost:11434` (user-space binary if not installed); fallback `llama-cpp-python` with CUDA; last resort templated text (section 0.6) |
| Language model | the best available open-weights instruct model of roughly 7–14 billion parameters, 4-bit, that passes `backend/tests/test_llm_schema.py` (for example a current Qwen or Llama instruct release); record the exact tag in `NOTES.md` |
| Image model | SDXL-Lightning 4-step UNet (`ByteDance/SDXL-Lightning`) on `stabilityai/stable-diffusion-xl-base-1.0`, fp16; fallback `stabilityai/sdxl-turbo`; last resort procedural assets |
| Image sizes | entities 1024 × 1024; world backdrops 2048 × 1024 |
| Depth model | `depth-anything/Depth-Anything-V2-Small-hf` through the `transformers` depth-estimation pipeline |
| Background removal | `rembg` (BiRefNet model if available, else U²-Net) |
| Image safety | `CompVis/stable-diffusion-safety-checker` plus a CLIP zero-shot check for gore, blood and injury (section 10) |
| Default dose step | strong |
| Difficult passages | on by default, one switch to turn off (gentle mode) |
| Eyes | auto by default (section 8.3) |
| Rendering | full window; adaptive render scale 0.5–1.0 targeting 60 frames per second |
| Random seed | from the clock unless `?seed=` is given; always recorded |
| Sessions | `./sessions/YYYY-MM-DD_HHMM/` |
| Report export | environment variable `REPORT_EXPORT_DIR`; unset by default (no export) |
| Fonts | VT323 (SIL Open Font Licence) for all interface screens, bundled locally; a clean bundled sans or serif for long report text (no network fonts) |
| Interface style | retro terminal (section 15.1): amber `#ffb000` on `#0a0700`, dim amber `#7a5400`, accent cyan `#4fe3ff` |
| Browser | Chromium or Chrome recommended; Firefox should also work |

Verify every model identifier and licence at setup. If one is unavailable or gated, use the listed fallback and record it.

### 0.6 Fallback ladder (the product must always complete a session)

| Component | Primary | Fallback | Last resort |
|---|---|---|---|
| Planner expansion | language model | retry with simpler prompt | templated text from phrase banks (section 9.3) |
| Report writer | language model | retry with shorter target | templated report from phrase banks (section 13.4) |
| World and entity images | SDXL-Lightning | SDXL-Turbo | procedural worlds (geometry) and glyph beings |
| Image safety filter | safety checker + CLIP | — | **show no generated images** (procedural only). Unchecked images are never shown. |
| Room depth | Depth Anything V2 Small | synthetic depth (vertical gradient + edge-aware blur) | flat plane |
| Entity cut-outs | `rembg` | luminance or chroma key against the generated flat background | procedural glyph beings |
| Panorama input | equirectangular sphere | treat as photo | default room |
| Headless GPU rendering for tests | headless Chromium with GPU flags | headed Chromium under Xvfb or the real display | software rendering for functional tests only; mark performance "unmeasured" in `DONE.md` |
| Video encoding (demo, replay) | system `ffmpeg` | `imageio-ffmpeg` (bundled binary) | image sequence plus contact sheet |
| Audio | Web Audio | — | silent session with an on-screen note; never block the session |

Record every active fallback under "Fallbacks active" in `NOTES.md`; `DONE.md` lists them.

### 0.7 Protected files

Generate these once from this file, then treat them as read-only:

- `shared/golden/pharmacology.json` (from the reference code in section 7.4)
- The threshold constants in `tools/flashcheck.py` and `frontend/src/safety/` (from section 4.1)
- The safety tests (section 16.2, "Safety") and the core checks in `scripts/verify_all.sh`

If you find a genuine bug in a protected file, you may fix it only if the fix does not loosen any threshold, and you must explain it in `NOTES.md`.

### 0.8 Sub-agents (optional)

If your harness can run sub-agents in parallel, you may delegate the tracks in section 19 after M3 (once the contracts and the skeleton exist). You remain responsible for integration, the safety limiter and `verify_all.sh`. If not, work serially in milestone order.

---

## 1. What "realistic" and "safe" mean here

### Realistic

The simulator aims to be faithful in **form**, **timing** and **narrative structure**:

- **Form.** Visual content follows documented categories: Klüver's form constants (tunnels, spirals, lattices, cobwebs), the fractal and kaleidoscopic geometry that dominates reports, hyperbolic tilings, immersive "other worlds" and entity encounters.
- **Timing.** A calibrated pharmacological model sets onset, peak and come-down, with body effects arriving first, visual second and auditory last.
- **Narrative.** Which beings you meet, how they behave, whether there is a message, and how often things turn difficult are sampled from published frequencies.

It does **not** claim to reproduce the felt sense of reality, the meaning, or the time distortion. The closest precedent, the Sussex "Hallucination Machine" (Suzuki et al. 2017), reproduced hallucination-like visuals but not the temporal distortion of the real state. The product says this plainly (sections 4.4 and 15.4).

### Safe

The real drug is not involved, so "safe" means protecting the person in front of the screen:

1. **No seizure risk from the visuals.** A photosensitivity limiter is always on and cannot be disabled (section 4.1). This is the most important engineering requirement in the project.
2. **Always an exit.** One key ends the session gently at any moment, including during difficult passages.
3. **Difficult passages are bounded.** Optional, capped in length, always resolve, never graphic.
4. **No real-world dosing information.** Doses are relative steps, never milligrams. Not a dosing guide, not a harm-reduction tool.
5. **Honest outputs.** Every report is labelled as simulated.
6. **Local and private.** The room photo, answers and reports never leave the machine.

Section 4 takes priority over every other section.

---

## 2. Non-goals

Do not implement these, and do not build abstractions "so they would be easy later":

- Real-world dose conversion, milligram labels, or any guidance about using the real drug
- Online features: accounts, sharing, telemetry, cloud inference
- Multiplayer or social features
- Extended-state (continuous infusion) mode
- Tolerance modelling (repeat doses are additive by design; section 7.5)
- Mobile or standalone-headset builds (a WebXR mode on the same PC is a stretch goal)

---

## 3. Hardware, stack and setup

**Target machine:** Linux, NVIDIA card with 24 GB of graphics memory, CUDA available, at least 60 GB of free disk.

**Back end (Python 3.11+, `uv`):** `fastapi`, `uvicorn`, websockets; `ollama` client (or `llama-cpp-python`); `diffusers`, `transformers`, `torch` (CUDA), `accelerate`; `rembg`; `matplotlib`; `jsonschema`; `pytest`.

**Front end (TypeScript, Vite):** `three` (WebGL 2), Web Audio, plain TypeScript modules (no framework needed), `vitest`, Playwright (Chromium) for captures and end-to-end tests.

### 3.1 `scripts/setup.sh` (idempotent; safe to re-run)

1. Check: `nvidia-smi` works and reports at least 20 GB; free disk ≥ 60 GB; Python ≥ 3.11; Node ≥ 20. Install `uv` in user space if missing.
2. `uv sync` for the back end; `npm ci` (or `npm install` the first time) for the front end; `npx playwright install chromium`.
3. Check `torch.cuda.is_available()`.
4. Ensure a language-model runtime (section 0.5), starting Ollama in user space if needed.
5. Run `scripts/fetch_models.py`.
6. Generate a sample room photo for tests at `assets/sample/room.jpg` (image model prompt: "a cosy living room with a sofa, a plant, bookshelves and a window, natural light, photograph"); fall back to a procedural room render.
7. Write `verification/env.json` (GPU, driver, CUDA, torch, Node, browser, chosen models, active fallbacks).

### 3.2 `scripts/fetch_models.py`

Downloads, in this order, with progress and resumable downloads: language model (several GB), SDXL base fp16 weights only plus the Lightning UNet (several GB each), depth model (small), `rembg` model, safety checker, CLIP model. Expect roughly 20–30 GB in total. Each model gets a smoke test (load, one tiny inference, unload). Failures move to the fallback and are recorded.

### 3.3 Graphics memory budget

Models are **loaded one at a time and unloaded before the trip starts**. During the trip the card runs only the renderer (and the optional live-diffusion layer, off by default).

| Phase | Resident on the card | Rough budget |
|---|---|---|
| Intake: planning | language model, 4-bit | 6–10 GB |
| Intake: images | image model, fp16 | 8–12 GB |
| Intake: room | depth and background-removal models | under 2 GB |
| Trip | renderer only | 1–3 GB |
| Report | language model, 4-bit | 6–10 GB |

Measure actual usage at M8 and record it.

---

## 4. Safety requirements (non-negotiable)

### 4.1 Photosensitivity: the `SafetyLimiter`

Form constants are high-contrast periodic stripes and the "chrysanthemum" layer flickers: exactly the kinds of visual that can trigger photosensitive seizures. Safety is enforced **at the source** (each layer is designed within limits) and **as a backstop** (a final post-process pass).

**Thresholds** (from WCAG 2.x success criterion 2.3.1 and the Ofcom and ITU-R BT.1702 broadcast guidelines):

- A *general flash* is a pair of opposing changes in relative luminance of at least 10% of maximum, where the darker state is below 0.80 relative luminance.
- A *red flash* is a pair of opposing transitions involving saturated red (R / (R + G + B) ≥ 0.8).
- **Limit:** no more than **3 flashes of either kind in any 1-second window** over any region larger than **25% of the screen**. Treat this as a ceiling and aim well below it.
- **Patterns:** wherever a periodic pattern covers more than 25% of the screen, cap its Michelson contrast at **0.5**, and keep any reversal, oscillation or drift of the stripes at **2 Hz or below**.

**At the source:**
- The neural-field layer outputs soft-edged patterns and applies the contrast cap from its own known state.
- The hyperbolic layer switches symmetry groups by **crossfade over at least 300 ms**, never by cut.
- No full-screen white or near-white frames; mean screen luminance is capped.
- Breakthrough transitions take at least 2 seconds.
- Retro interface screens (section 15): scanlines are static with contrast at most 0.08; no flicker, rolling bars or animated noise; the cursor blinks at 1 Hz over a small area; the title colour cycle changes hue at roughly constant luminance.

**Backstop — `SafetyLimiter` post-process pass:**
- Runs last, on every frame, in every mode, including `?debug=1` and `?timewarp=`. There is **no setting, flag, URL parameter or key that disables it.**
- Computes relative luminance from linear RGB on a 64 × 36 tile grid; keeps 1 second of per-tile and global history; counts opposing transitions; when any qualifying region reaches 2 within the window, temporally low-passes that region (blend with the previous output frame, clamp per-frame luminance deltas) until the window clears.
- Applies the stricter red-flash rule to saturated-red regions.
- Logs `limiter_engaged` events.

**`tools/flashcheck.py`:** reads a folder of frames or a video, reports flashes per second, red flashes and large-area high-contrast pattern frames, and exits non-zero on any violation. Frames must be captured at real-time speed (never time-warped) for this check.

### 4.2 Exit and pacing

- **Escape**, and a small always-visible exit corner, start a **3-second fade** back to the calm room with a soft tone, then the grounding screen (section 13.1). It works in every state with no confirmation. Logged as `exit_pressed`.
- **Sessions are capped at 30 minutes** from the first hit.
- **Repeat hits:** at most 3, only when visual intensity is below 3 (section 7.5).
- **Audio:** master limiter with a fixed ceiling, no onset faster than 200 ms, volume always reachable.

### 4.3 Psychological content

- **Safety screen** before every session, with the exact copy in section 15.4. Continuing requires ticking the photosensitivity confirmation.
- **Difficult passages** (section 11.7): optional, capped at **90 seconds**, always resolve, always followed by a relief beat.
- **Content limits** apply to every generated image, every language-model output and every procedural effect:
  - No gore, injury, body horror, blood, or graphic death imagery.
  - No sexual or suggestive content. Feminine figures are luminous, robed or made of light and geometry.
  - No real people. Deities are vast, abstract, radiant presences, never the iconography of a specific real religion.
  - Ego dissolution is shown abstractly (outlines dissolving into geometry), never as text claiming the user is dying or harmed.
- **Messages from beings** are abstract and non-directive (attention, play, care, curiosity, wonder). They never tell the user to do anything, never give health, drug or life advice, and never predict real events or mention real people.
- **Grounding** after every session, including sessions ended with Escape.

### 4.4 Information hygiene and honesty

- Doses appear only as named steps and in **model units relative to the half-effect concentration**. Never milligrams, never real concentration units, never real-world equivalents, never advice about real use, not even framed as harm reduction.
- The disclaimer in section 15.4 appears on the safety screen and in every report.
- Every report is labelled **Simulated** in its title, front matter, file name and as a visible watermark in the HTML version.

### 4.5 Comfort

- No camera movement the user did not initiate, except slow constant-velocity drift in the waiting room with a stable horizon or peripheral frame.
- Headset mode (stretch): gaze-locked layers capped in opacity, no acceleration bursts, seated only.

### 4.6 Privacy

- No network access after setup. Enforced by a test (section 16.2): the front end may only request `localhost`; the back end runs with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and a socket guard that refuses non-loopback connections.
- Room photo, intake, logs and reports stay in `sessions/` (and the optional export folder). Strip location metadata from photos on import.

---

## 5. Architecture

```
 ┌────────────────────────── Browser (TypeScript, three.js) ───────────────────────────┐
 │  Intake UI ──► Pharmacology (live) ──► Director ──► Shared state ──► Layers ──► SafetyLimiter ──► screen
 │                                           │              │                                     │
 │                                           │              └──► Audio synth ──► limiter ──► speakers
 │                                           └──► Event log + frame captures ─────────────────┐   │
 └───────────────────────────────────────────────▲───────────────────────────────────────────┼───┘
                                                  │ websocket / HTTP (localhost only)           │
 ┌──────────────────────── Back end (Python, FastAPI) ─────────────────────────────────────────▼───┐
 │  Intake processing ─► Planner stage 1 (priors) ─► Planner stage 2 (language model) ─► Asset generation │
 │  Report: memory model ─► report writer (language model) ─► Markdown + HTML + figures              │
 │  Batch validation (headless; no rendering) · /status reports resident models                     │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Session flow

0. **Title screen** (section 15.2)
1. **Safety screen** (section 15.4)
2. **Intake** (section 8): one question per screen. Planning and generation start in the background as soon as enough answers exist.
3. **Settling screen** until assets are ready **and** `/status` reports no resident models.
4. **The hit** (section 8.4)
5. **Trip**
6. **Return and grounding** (section 13.1)
7. **Draw your curve** (section 13.2)
8. **End screen with session stats** (section 15.3)
9. **Report**, opened from the end screen: HTML page in the browser; the Markdown file is already written to the session folder

### 5.2 Run modes and test hooks

- `./run.sh` — production. `./run.sh --dev` — Vite dev server with hot reload.
- URL parameters (all keep the `SafetyLimiter` on):
  - `?debug=1` — debug scrubber: a slider that sets visual intensity directly, plus buttons to force each layer, an entity, a message and a difficult passage.
  - `?timewarp=N` — runs model time N times faster than real time, for functional end-to-end tests only.
  - `?autofill=<profile>` — fills the intake from `tests/e2e/profiles/<profile>.json`.
  - `?seed=<int>` — fixes the seed.
- Back end: `GET /status` (resident models, versions, active fallbacks).

---

## 6. Contracts (freeze at M0)

Write these as JSON Schema files in `shared/schemas/` with an example instance each, and validate the examples in tests. Change them later only with a note in `NOTES.md`.

### 6.1 `intake.json`
Answers (section 8.2), dose step, hold fraction (section 8.4), options (difficult passages, eyes mode, audio, microphone, live diffusion), room source (`photo` | `panorama` | `default`).

### 6.2 `trip_script.json` (planner output)

```jsonc
{
  "version": 1,
  "seed": 123456789,
  "pharmacology": {
    "dose_step": "breakthrough", "dose_rel": 4.0, "hold_fraction": 1.0,
    "sensitivity": 1.07, "clearance": 0.94,
    "params": { "ka": 4.0, "k10": 0.12, "k12": 0.20, "k21": 0.03, "ke0": [2.5, 1.2, 0.6], "h": 2.0 }
  },
  "predicted": { "peak_visual": 8.5, "deepest_layer": "breakthrough", "minutes_above_8": 3.1 },
  "palette": { "name": "jewel", "colours": ["#...", "#..."] },
  "room": { "source": "photo", "image": "assets/room.jpg", "depth": "assets/room_depth.png" },
  "layers": {
    "form_constants": { "mode": "stripes", "wavelength": 0.9, "spiral_bias": 0.3 },
    "chrysanthemum": { "groups": [[2,3,7],[2,4,5],[2,3,9]], "kleinian": { "trace_a": [2.0, 0.0], "trace_b": [2.0, 0.0] } },
    "waiting_room": { "kind": "fractal" }
  },
  "breakthrough": {
    "reached": true,
    "world": { "category": "dome_temple", "prompt": "...", "image": "assets/world_0.png", "procedural": false },
    "entities": [{
      "type": "jester", "label": "guide",
      "attributes": { "conscious": true, "intelligent": true, "benevolent": true, "sacred": false },
      "disposition": "playful",
      "communication": "two_way",
      "behaviours": ["approach", "greet", "present_object", "transform", "depart"],
      "sprites": ["assets/entity_0_a.png", "assets/entity_0_b.png", "assets/entity_0_c.png"],
      "procedural": false
    }],
    "message": { "present": true, "sealed_text": "...", "glyph_seed": 42 }
  },
  "challenge": { "occurs": false, "onset_offset_s": null, "flavour": null },
  "report": { "length_words": 340, "profundity": false },
  "contingency": { "breakthrough_assets": true },
  "provenance": { "planner": "llm|template", "images": "sdxl_lightning|sdxl_turbo|procedural" }
}
```

### 6.3 `event_log.jsonl` (front-end output)
One object per line: `{"t_min": 2.13, "type": "...", "payload": {...}}`. Types:
`hit`, `hit_blocked`, `intensity_sample` (every 0.5 s: plasma, body, visual, auditory), `layer_enter`, `layer_exit`, `entity_appear`, `entity_behaviour`, `message_shown`, `challenge_start`, `challenge_resolve`, `let_go_held`, `eyes_toggle`, `exit_pressed`, `frame_captured`, `limiter_engaged`, `session_end`.

### 6.4 Golden pharmacology file
`shared/golden/pharmacology.json`: curves from section 7.4 for each dose step at sensitivity and clearance 1, three variability cases, and one repeat-hit case, sampled every 0.1 minutes. Protected (section 0.7).

---

## 7. Pharmacology

### 7.1 Model

The structure follows Eckernäs et al. (2022): two compartments, an effect-site compartment, and a sigmoid maximum-effect relationship to a 0–10 intensity scale. Two additions: an **absorption depot** for inhalation, and **three effect sites** (body, visual, auditory) equilibrating at different rates, which reproduces the finding that bodily effects usually come first, visual second and auditory third.

Concentrations are dimensionless, in units of the half-effect concentration at sensitivity 1.

```
dA/dt    = −ka · A
dC/dt    =  ka · A − (k10 · clearance + k12) · C + k21 · P
dP/dt    =  k12 · C − k21 · P
dCe_i/dt =  ke0_i · (C − Ce_i)            i ∈ {body, visual, auditory}
I_i      =  10 · Ce_i^h / (Ce_i^h + EC50^h),   EC50 = 1 / sensitivity
```

### 7.2 Parameters (per minute; hand-tuned, not fitted)

| Parameter | Value | Meaning |
|---|---|---|
| `ka` | 4.0 | inhalation absorption |
| `k10` | 0.12 | elimination |
| `k12`, `k21` | 0.20, 0.03 | distribution to and from the peripheral compartment |
| `ke0` | 2.5, 1.2, 0.6 | body, visual, auditory effect-site rates |
| `h` | 2.0 | steepness of the intensity curve |

**Dose steps** (model units): threshold 0.4, light 1.0, strong 2.0, breakthrough 4.0.
**Between-session variability:** `sensitivity ~ LogNormal(0, 0.25)`, `clearance ~ LogNormal(0, 0.2)`, drawn by the planner from the session seed.

### 7.3 Calibration targets

Anchors: inhaled experiences have a reported median duration of about 10 minutes (interquartile range 5–15; Lawrence et al. 2022); intravenous effects peak within 2–3 minutes and are negligible after about 30 (Luan et al. 2024); peak intensity rises steeply with dose (Eckernäs et al. 2022).

Typical session (sensitivity and clearance 1), from the reference code:

| Dose step | Peak visual intensity | Peak time | Minutes with visual intensity > 1 |
|---|---|---|---|
| threshold | 0.6 | 1.8 min | 0 |
| light | 2.7 | 1.8 min | 4.2 |
| strong | 6.0 | 1.8 min | 7.2 |
| breakthrough | 8.6 | 1.8 min | 11.1 |

Channel peak times: body 1.3, visual 1.8, auditory 2.6 minutes.

Population (10th / 50th / 90th percentiles; deepest layer reached):

| Dose step | Peak visual | Minutes > 1 | Deepest layer distribution |
|---|---|---|---|
| threshold | 0.3 / 0.5 / 1.0 | 0 / 0 / 0 | none 45%, onset 55% |
| light | 1.7 / 2.6 / 4.1 | 2.8 / 4.1 / 5.4 | onset 22%, form constants 73%, chrysanthemum 5% |
| strong | 4.3 / 6.2 / 7.5 | 5.6 / 7.3 / 9.2 | form constants 12%, chrysanthemum 65%, waiting room 19%, breakthrough 4% |
| breakthrough | 7.4 / 8.4 / 9.2 | 8.4 / 10.9 / 15.6 | chrysanthemum 5%, waiting room 20%, breakthrough 75% |

Both implementations must match the golden file to within 1e-3, and the population table to within sampling error (≥ 2000 samples per dose step).

### 7.4 Reference implementation (ground truth)

```python
import numpy as np

P = dict(ka=4.0, k10=0.12, k12=0.20, k21=0.03, ke0=(2.5, 1.2, 0.6), h=2.0)
DOSES = dict(threshold=0.4, light=1.0, strong=2.0, breakthrough=4.0)

def simulate(dose, sensitivity=1.0, clearance=1.0, T=25.0, dt=1/600, hits=()):
    """Return times (min), plasma C, and intensities I[3] (body, visual, auditory).
    hits: sequence of (requested_time_min, dose); a hit is applied at the first
    moment at or after its requested time when visual intensity is below 3."""
    ka, k12, k21, h = P["ka"], P["k12"], P["k21"], P["h"]
    k10 = P["k10"] * clearance
    ec50 = 1.0 / sensitivity
    y = np.array([dose, 0, 0, 0, 0, 0], float)  # A, C, P, Ce_body, Ce_visual, Ce_auditory
    ke = np.array(P["ke0"])

    def f(y):
        A, C, Pp = y[:3]
        Ce = y[3:]
        return np.concatenate([[-ka * A, ka * A - (k10 + k12) * C + k21 * Pp, k12 * C - k21 * Pp],
                               ke * (C - Ce)])

    n = int(round(T / dt))
    ts = np.arange(n + 1) * dt
    Cs = np.zeros(n + 1)
    I = np.zeros((3, n + 1))
    pending = sorted(hits)
    for i, t in enumerate(ts):
        Ce = np.clip(y[3:], 0, None)
        I[:, i] = 10 * Ce**h / (Ce**h + ec50**h)
        Cs[i] = y[1]
        if pending and t >= pending[0][0] and I[1, i] < 3.0:
            y[0] += pending.pop(0)[1]
        k1 = f(y); k2 = f(y + dt / 2 * k1); k3 = f(y + dt / 2 * k2); k4 = f(y + dt * k3)
        y = y + dt / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return ts, Cs, I
```

The front end implements the same model in TypeScript (RK4, fixed sub-steps per frame, independent of frame rate and of `timewarp`). The back end uses the Python version for planning and batch validation.

### 7.5 Repeat hits (no tolerance)

- A repeat hit adds the selected dose step to the absorption depot. No tolerance term: subjective effects did not diminish across four closely spaced intravenous doses in Strassman et al. (1996).
- **Blocked while visual intensity ≥ 3**; logged as `hit_blocked`, with the cue in section 15.4.
- At most 3 repeat hits per session.
- The planner generates breakthrough assets whenever the dose step is strong or above (`contingency.breakthrough_assets`). If a repeat hit reaches breakthrough without assets, the breakthrough layer runs procedurally.

### 7.6 Display

The heads-up display (toggle `I`; off by default during the trip; always in the report) plots plasma level and the three channel intensities in model units labelled "relative to half-effect level". Never real units.

---

## 8. Intake

About 3 minutes; one question per screen; keyboard navigable. Wording in section 15.4.

### 8.1 Room source

- **Default:** one ordinary photo → depth-displaced mesh with parallax.
- **Optional:** a phone panorama (2:1 equirectangular) → displaced sphere, full 360°, ready for headset mode.
- **Skip:** a built-in default room (simple procedural interior).

Downscale to at most 2048 px on the long side; strip metadata.

### 8.2 Questions → hidden variables

| Question (short) | Input | Variable | Effect |
|---|---|---|---|
| Intention clarity | 0–10 | `clarity` | raises message probability and awe beats |
| Mood now | −5 … +5 | `set` | lowers difficult-passage probability |
| Three absorption-style items | 0–10 each | `absorption` (mean) | scales visual gain and layer richness |
| Preoccupied ↔ ready to let go | 0–10 | `surrender` | lowers difficult-passage probability; speeds resolution |
| Main reason | curiosity / recreation / reflection / spiritual | `intention` | recreation lowers difficult-passage probability |
| Motifs seen before | multi-select | `expectations` | multiplies matching entity weights by 1.5 each |

Basis: Haijen et al. (2018) found clear intentions favoured mystical-type experiences, a positive set and recreational intentions made challenging experiences less likely, and trait absorption and higher doses amplified every part of the acute experience including visuals. Russ et al. (2019) found surrender predicted better and preoccupation adverse experiences. Both are psilocybin studies; the structure is borrowed. The expectation effect follows the rise in jester reports after widely shared jester content.

### 8.3 Options

Dose step (default strong); difficult passages on / gentle mode; eyes auto (open during onset, fading to eyes-closed at visual intensity 3) / open / closed, toggle anytime with `E`; audio on/off; microphone modulation off; live diffusion off.

### 8.4 The hit

Hold space (or the on-screen button) through a breathing animation for up to 4 seconds. Absorbed dose = `dose_step × min(1, hold_seconds / 4)`, recorded as `hold_fraction`. The `AudioContext` is created on the safety-screen click so audio is allowed to play.

---

## 9. Trip planner

A probabilistic program in two stages. Stage one decides structure with plain code and published frequencies; stage two fills in texture with the language model. Everything is seeded and reproducible.

### 9.1 Stage one: sampling from priors (`backend/planner/priors.yaml`)

Every number lives in `priors.yaml` with a source comment. Lawrence et al. (2022) and Davis et al. (2020) are open access; if you can read them during setup, refine values and categories and log changes in `NOTES.md`. Otherwise use the values below as given.

1. Sensitivity and clearance; compute `predicted` with the reference model.
2. Palette, form-constant mode, hyperbolic groups, waiting-room kind.
3. **Encounter**, conditional on deepest layer: chrysanthemum 0.05, waiting room 0.40, breakthrough 0.94 (Michael, Luke & Robinson 2021: 94% of breakthrough reports involved beings, all involved other worlds).
4. **Entity type** (Lawrence et al. 2022, share of encounters), times expectation weights, renormalised:

   | Type | Weight | Sub-types |
   |---|---|---|
   | luminous feminine figure | 24.2 | |
   | deity-like presence | 17.0 | |
   | alien | 16.3 | |
   | creature | 9.2 | reptilian/serpentine 3.0, tentacled 2.4, insectoid 2.3, feline 1.5 |
   | mythological | 8.4 | machine elves 2.9; elves, sprites and others for the rest |
   | jester | 6.5 | |
   | living geometry / unspecified | 18.4 | |

5. **Label** (Davis et al. 2020, non-exclusive): being 0.60, guide 0.43, spirit 0.39, alien 0.39, helper 0.34.
6. **Attributes** (Davis et al. 2020): conscious 0.96, intelligent 0.96, benevolent 0.78, sacred 0.70, agency 0.54.
7. **Disposition:** benevolent/caring (default when benevolent), playful/teasing, busy and indifferent ("working on you"), stern (only inside difficult passages).
8. **Communication** (Davis et al. 2020): entity → user 0.49, two-way 0.40, user → entity 0.02, none or unclear 0.09 (the remainder). Rendered as glyphs.
9. **Message** present: 0.69 (Davis et al. 2020), scaled up with `clarity`.
10. **Number of entities:** 1 (70%), 2–3 (25%), many (5%).
11. **World category** (design vocabulary): geometric chamber, dome or temple-like architecture, infinite hall or city of structures, workshop or machine space, organic jungle-like landscape, cosmic space, carnival or circus.
12. **Difficult passage:** `p = σ(−2.2 + 0.35·(peak − 5) − 0.25·set − 0.15·(surrender − 5) − 0.5·[intention = recreation])`. About 27% at a typical breakthrough with neutral answers, under 5% at a light dose. Gentle mode sets `p = 0` (brief fear flickers remain; section 11.7). Fear inside good encounters is common: 41% of Davis respondents reported fear during encounters dominated by love, kindness and joy.
13. **Report length:** `LogNormal(ln 311, 0.94)` words, clamped to 120–900 (Lawrence et al. 2022: median 311, interquartile range 160–568).
14. **Profundity statement:** 6.1% overall (Lawrence et al. 2022), weighted towards breakthrough sessions.

**Mentions are not occurrences.** Lawrence percentages count what people *wrote*. Use them to calibrate **reports** (section 14), not the renderer.

### 9.2 Stage two: expansion with the language model

- Structured output via Ollama's `format` parameter (JSON Schema `shared/schemas/expansion.json`); validate; up to 3 retries; then the template fallback (section 9.3).
- Input: stage-one skeleton and intake (never the photo). Output: image prompts for the world and each entity (three variants per entity), behaviour beats with rough timing, the sealed message text, and a private summary for the report writer.
- The system prompt includes every content limit in section 4.3 verbatim, plus a prompt style guide: self-luminous, jewelled, intricate, hyper-saturated, alive, "more dimensions than it should have", no text or letters in images, plain dark background for entities.
- After parsing, run a **banned-terms check** (`backend/safety/banned_terms.txt`: gore, sexual, real-person and directive-advice terms); regenerate on any hit.
- Unload the model afterwards (`keep_alive: 0`).

### 9.3 Template fallback

`backend/planner/templates/` holds seeded phrase banks (per world category, entity type, behaviour and message theme) that produce a complete, schema-valid expansion without any model. The message bank contains only abstract, non-directive phrases (e.g. themes of attention, play, care). The product must be fully usable on templates alone; the end-to-end test runs once with templates forced (`HYPERSPACE_FORCE_TEMPLATES=1`).

---

## 10. Asset generation (`backend/assets/`)

Runs during intake. Budget: at most 12 images and at most 90 seconds of generation. Show real progress on the settling screen.

- **Image model:** section 0.5. Negative prompts always include text, letters, watermark, gore, blood, nudity.
- **World backdrops (1–3):** 2048 × 1024 with horizontal wrap-around (patch convolution padding to circular along x, or an equivalent technique), mapped onto a sphere. A procedural mandala dome and floor cover the poles.
- **Entities (up to 4, three variants each):** generated on a flat dark background, cut out to RGBA sprites (section 0.6 for fallbacks).
- **Room:** depth map from the depth model.
- **Image safety filter (non-negotiable):** every generated image passes (a) the safety checker and (b) a CLIP zero-shot check comparing against "gore", "blood", "injury", "corpse", "nudity" versus neutral prompts, with a conservative threshold. A flagged image is regenerated up to 3 times with a new seed and stronger negative prompt, then replaced by a procedural asset. If the filter cannot load, **no generated image is shown**. Log every rejection.
- **Procedural assets:** worlds built from the geometry layers with palette tints; "glyph beings" built from animated glyph clusters and kaleidoscopic silhouettes. These are first-class, not placeholders: they must look intentional.
- **Unload all models** before reporting ready. The front end refuses the hit until `/status` shows no resident models.

---

## 11. Renderer (`frontend/src/`)

Target: 60 frames per second at the window size, with adaptive render scale (0.5–1.0) adjusting to hold it. Every layer reads one **shared state**; nothing reads the clock directly.

### 11.1 Shared state (updated every frame)

```ts
interface SharedState {
  t_min: number;
  plasma: number;
  intensity: { body: number; visual: number; auditory: number };  // 0–10
  layerWeights: { room: number; formConstants: number; chrysanthemum: number; waitingRoom: number; breakthrough: number };
  fieldTexture: WebGLTexture;   // neural-field activity: the coupling signal
  pulse: number;                // shared 0–1 oscillator; audio and geometry pulse together
  challenge: { active: boolean; level: number };   // 0–1
  eyesClosed: number;           // 0–1, crossfaded
  palette: Palette;
  absorptionGain: number;
}
```

**Coupling rule** (the most important design rule for realism): layers never animate independently. Their modulation comes from `fieldTexture`, `pulse` and the intensities, and the neural field keeps running underneath every higher layer. Uncoupled stacks of individually correct effects look fake.

### 11.2 Layer weights

Smoothstep windows on visual intensity `v`, with 0.5 hysteresis on exit:

| Layer | Enters as `v` rises through | Leaves |
|---|---|---|
| Room distortions | 0.5 → 2.0 (amount ramps up) | room fully replaced by 7.5 |
| Form constants | 1.8 → 3.0 | fades over 5.5 → 7.0 (stays as modulation) |
| Chrysanthemum | 4.2 → 5.2 | fades over 7.2 → 8.2 |
| Waiting room | 6.8 → 7.6 | replaced by breakthrough |
| Breakthrough | latched when `v ≥ 8.0` | released when `v < 6.5` (20-second fade) |

Coming down passes back through the layers in reverse and ends on your own room with lingering mild distortions, fading out below `v = 0.5`.

### 11.3 Room layer

Depth-displaced mesh (photo) or sphere (panorama). **Breathing:** low-frequency 3D noise displacement along normals, scaled by distortion level and `pulse`. **Drifting:** texture coordinates advected by a curl-noise flow field. **Colour:** saturation and slight hue rotation rise with `v`. **Symmetrical texture repetition:** wallpaper-group folding in texture space, masked to where `fieldTexture` is active. **Tracers:** temporal feedback buffer when the camera moves. **Eyes-closed field:** as `eyesClosed` rises, the room fades into a dark phosphene field showing the neural field in dim colour (delta/theta emergence correlated with the eyes-closed visual peak in Timmermann et al. 2019). Vocabulary from the Subjective Effect Index.

### 11.4 Form constants: neural field (`layers/neuralField.ts` + GLSL)

The Ermentrout–Cowan / Bressloff et al. mechanism.

- **Grid:** 256 × 256 in cortical coordinates, `x` = log eccentricity, `y` = angle (periodic).
- **Dynamics:** `τ ∂u/∂t = −u + (w * f(u)) + h + σ ξ`, with `w` a difference of Gaussians (local excitation, wider inhibition) via separable Gaussian blurs on ping-pong framebuffers, `f` a sigmoid with gain `β`, and noise `ξ`.
- **Bifurcation:** `β = β₀ + κ · v · absorptionGain`, tuned so the uniform state becomes unstable near `v ≈ 2`.
- **Mode:** stripes vs hexagons via an asymmetry term in `f`, drifting slowly. Occasionally seed rotating spiral waves (rotational dynamics were recently reported as a time-resolved neural signature of the experience).
- **Retino-cortical map:** for each pixel compute `(r, θ)` from the view centre and sample the field at `(log(r + r₀), θ)`. Stripes along `x` → rings and tunnels; along `y` → radial funnels; oblique → spirals; hexagons → honeycomb lattices.
- **Safety at source:** soft edges, contrast cap, drift cap (section 4.1).

### 11.5 Chrysanthemum (`layers/hyperbolic.ts`)

Hyperbolic triangle-group tilings in the Poincaré disk via reflection folding into the fundamental triangle, groups from the trip script, e.g. (2,3,7), (2,4,5), (2,3,9). **Flicker** between groups by crossfade (≥ 300 ms). Animate with Möbius transformations synchronised to `pulse`. **Petals:** map the tiling onto a radially symmetric curved sheet. **Kleinian limit sets** (two-generator groups, e.g. Maskit or Riley parameterisations, as in *Indra's Pearls*) by iterated inversion, with slowly morphing trace parameters. Design guide: the Qualia Research Institute's hyperbolic-geometry essay (not peer reviewed; a phenomenological map).

### 11.6 Waiting room (`layers/waitingRoom.ts`)

A ray-marched kaleidoscopic fractal interior (Mandelbox or kaleidoscopic iterated function system) with slow constant-velocity drift. Stretch: true hyperbolic 3-space following Coulon, Matsumoto, Segerman & Trettel (2022).

### 11.7 Breakthrough, director and difficult passages

**Breakthrough sequence** (`director.ts`, from the trip script):

1. On latch: the geometry thins into a membrane and lifts like a veil (≥ 2 s).
2. The world fades in inside a procedural geometric frame; the zenith dome rotates slowly.
3. Entities arrive 5–20 s later as depth-placed sprites: edge shimmer from `fieldTexture`, n-fold kaleidoscopic echoes, morphing between their three variants by flow-warped crossfade ("self-transforming").
4. Behaviour beats: approach, greet, present an object (a procedural geometric object between entity and viewer), show or teach, "work on" the viewer, transform, depart.
5. **Message:** at the entity's most intense moment, glyphs stream from it in rotating rings, from a procedural alphabet seeded per trip; readable-feeling but not decodable. Two-way communication: mouse movement and key presses perturb the glyphs and the entity responds. The words appear only in the report.
6. As `v` falls below 7, the world dims, the entity recedes, and the layers reverse.

**Difficult passages** (if sampled; never in gentle mode): start near the peak; palette turns harsh, geometry speeds up and tightens, tunnel narrows, carrier tone turns dissonant, disposition becomes stern or indifferent, body outline dissolves into geometry. **Resolution** hazard `λ = λ₀ · (1 + 0.1 · surrender) + λ_hold · [space held]`, `λ₀ = 1/60 s⁻¹`, `λ_hold = 1/10 s⁻¹`, **hard cap 90 s**, then a 15-second relief beat (warm palette, consonant chord, slower geometry). **Gentle mode:** fear flickers of at most 5 seconds only.

**Controls:** mouse look; `E` eyes; hold space to let go; `H` repeat hit; `I` heads-up display; Escape exit.

**Frame captures:** at layer entries, entity appearance, message and peak, capture a frame for the report (`frame_captured`).

### 11.8 Optional live diffusion (off by default)

Real-time image-to-image (StreamDiffusion-style) on a 512 × 512 downscale, strength tied to `v`, composited at low opacity in the waiting room and breakthrough. Asynchronous; never drops the renderer below 60 frames per second; passes through the `SafetyLimiter`; monitor only. Uses graphics memory during the trip, so only enabled by the user.

---

## 12. Audio (`frontend/src/audio/`)

All synthesised with Web Audio.

- **Carrier tone:** pitch about `220 · 2^(3 · auditory / 10)` Hz with a faint high whine partial (ringing, buzzing, humming, static or "carrier wave" sounds are mentioned in 15.4% of reports; Lawrence et al. 2022).
- **Buzz:** amplitude modulation at 4–12 Hz, rising with intensity, locked to `pulse`.
- **Crackle:** band-passed noise grains, rate rising with intensity.
- **Body rumble:** 40–60 Hz following the body channel (body vibration or buzzing is the most mentioned somatic effect, 27.2%).
- **Breakthrough:** tonal shimmer and slow chords; entity "voices" as granular vowel-like textures, never words.
- **Difficult passages:** dissonance and roughness, resolving to consonance.
- **Microphone (optional, off):** loudness and spectral centroid modulate geometry speed and hue.
- **Safety:** master limiter, minimum 200 ms attacks, volume always reachable.

---

## 13. After the trip

### 13.1 Return and grounding (always, including after Escape)

60 seconds: the room photo restores slowly as distortions fade, an optional slow breathing animation, soft ambient sound. Copy in section 15.4.

### 13.2 Draw your curve

Before seeing any data, the user draws their remembered intensity over time on a 0–10 canvas (in the spirit of Temporal Experience Tracing). Then the real visual-intensity curve is overlaid, with peak-time and duration differences. Stored in the session folder.

### 13.3 Memory model (`backend/report/memory_model.py`)

- Salience per event = novelty × emotional weight × layer weight.
- Recall probability `p = σ(a − b · v(t) + c · salience)`: high during onset and come-down, low at the peak.
- The top 3 salient events are always kept as vivid fragments, but events above `v = 7` are shuffled in order.
- Gaps are filled by the writer; every inferred sentence is tagged as inferred.

### 13.4 Report writer (`backend/report/writer.py`)

- Same local language model, reloaded after the trip; template fallback from phrase banks otherwise.
- First person, past tense, informal, like an online trip report. Length from the trip script. Loose arc: setting ("simulated session", dose step), the hit, onset, geometry, the peak, beings and message ("the closest I can get to putting it into words: …"), coming back, afterthoughts.
- Descriptions visibly fail at the peak. A profundity statement only if the trip script says so.
- Content limits apply; banned-terms check; retry on violation.

### 13.5 Outputs

Per session, in `sessions/YYYY-MM-DD_HHMM/`:

- `simulated-trip-report.md`: YAML front matter (`title`, `date`, `simulated: true`, `dose_step`, `peak_visual`, `deepest_layer`, `entities`, `challenge`, `tags: [simulated-trip]`), the disclaimer, the report, captured frames and figures as relative image links.
- `report.html`: the same report plus a **lab view** (plasma and channel curves, layer timeline, the drawn curve against the real one, the remembered report beside the logged events with inferred sentences highlighted), and a visible "Simulated" watermark. Styled per section 15.1; starts with the same stats box as the end screen. Opened from the end screen with `[R]`. The Markdown file also includes the stats box as a fenced code block.
- `intake.json`, `trip_script.json`, `event_log.jsonl`, `frames/`, `figures/`.

If `REPORT_EXPORT_DIR` is set, copy the Markdown file and its images there.

**Replay:** a session is fully determined by its seed, trip script and event log (including user inputs). The report page has a "Replay" button that re-runs it in the browser.

---

## 14. Validation: does it read like the real thing?

`python -m backend.batch.validate --n 200` runs planner, memory model and report writer headlessly (no rendering; the event log is synthesised from the trip script and the reference pharmacology).

- **Dose mix** (assumption; record it): threshold 10%, light 20%, strong 35%, breakthrough 35%, intake answers sampled around neutral.
- A coder prompt (same model) tags each report with these categories. Validate the coder first on 30 synthetic reports with known contents (≥ 90% agreement); if it fails, use a keyword coder and record it.
- **Targets** (share of reports mentioning; Lawrence et al. 2022): entity encounter 45.5%, fractals/geometry/patterns 32.6%, vivid colours 25.2%, any bodily sensation 37.5%, body vibration/buzz 27.2%, ringing-type sound 15.4%, profundity 6.1%; median length 311 words.
- **Acceptance:** each within a factor of 1.5 of its target (profundity: between 2% and 12%); median length within 20%.
- Tune the report writer's mention behaviour and the planner priors, never the renderer. Log every tuning step. `--n 1000` is optional.

---

## 15. Look and feel

### 15.1 Design direction: retro terminal, kept simple

Every screen outside the trip itself looks like an early-1980s computer terminal. The trip is the spectacle; the screens around it are deliberately plain.

- **Colours:** warm near-black background `#0a0700`, amber phosphor text `#ffb000`, dim amber `#7a5400` for secondary text and borders. One accent, cyan `#4fe3ff`, used only where noted.
- **Type:** VT323 only, bundled locally, large (body about 28 px at 1080p, scaling with the window). Headings and menu items in capitals.
- **Furniture:** box-drawing borders (`╔═╗║╚╝`), dotted leaders (`.....`), a blinking block cursor `█`, key hints in brackets (`[ENTER] BEGIN`). Everything sits on a monospace character grid.
- **CRT touches, and only these:** a faint text glow (a small `text-shadow` in amber) and static scanlines at contrast 0.08 or less. No flicker, rolling bars, barrel distortion or animated noise (section 4.1).
- **Typewriter:** short texts and stats print at about 15 ms per character, or line by line for the stats box. Any key shows everything at once. The safety screen text appears immediately, never typed out.
- **Keyboard-first:** every action has a key; the mouse also works.
- **Intake and safety screens** use the same style, one question per screen, with a progress line like `[■■■■□□□□□□] 4/11`.
- **No interface during the trip** except a faint exit corner and the optional heads-up display.
- **Report page:** an amber terminal header and the stats box, then readable long-form text in a bundled clean font on the dark background, then the lab view. Prints cleanly (light print stylesheet).
- **Build them as plain HTML and CSS** with a little TypeScript. No WebGL on these screens.

### 15.2 Title screen

```
 _  ___   _____ ___ ___  ___ ___  _   ___ ___
| || \ \ / / _ \ __| _ \/ __| _ \/_\ / __| __|
| __ |\ V /|  _/ _||   /\__ \  _/ _ \ (__| _|
|_||_| |_| |_| |___|_|_\|___/_|/_/ \_\___|___|

       A DMT EXPERIENCE SIMULATOR   V1.0
        NO DRUGS · NO NETWORK · NO RUSH

         > [ENTER]  BEGIN A SESSION
           [P]      PAST SESSIONS
           [A]      ABOUT
                                      █

 LOCAL MODE · SAFETY LIMITER ON · SESSIONS: 3
```

- The ASCII title (FIGlet "small" font, embedded as text) slowly cycles hue through amber, magenta, cyan and green and back, one full cycle every 10 seconds, smoothly, at roughly constant luminance. Everything else is amber.
- **Arrow keys** move the `>` marker; Enter selects.
- **Past sessions:** a simple table of earlier sessions (date, dose step, peak, deepest layer, beings met); Enter opens that session's report.
- **About:** a short screen with sections 1 ("realistic" and "safe") in plain words, the main references, and the controls.
- The footer shows the real values (sessions count from `sessions/`).
- Enter on "Begin a session" goes to the safety screen.

### 15.3 End screen: session stats

Shown after the curve drawing. The box prints line by line (about 80 ms per line) with an optional, very quiet click per line (respects the sound setting).

```
╔════════════════════════════════════════════╗
║ SESSION COMPLETE · SIMULATED    2026-10-10 ║
╠════════════════════════════════════════════╣
║ DOSE STEP ................... BREAKTHROUGH ║
║ INHALED ............................. 100% ║
║ REPEAT HITS ............................ 0 ║
║ PEAK INTENSITY .................. 8.6 / 10 ║
║ TIME TO PEAK ........................ 1:49 ║
║ DURATION ........................... 11:06 ║
║ DEEPEST LAYER ............... BREAKTHROUGH ║
║ BEINGS MET .................... 1 · JESTER ║
║ MESSAGE ......................... RECEIVED ║
║ DIFFICULT PASSAGE ................... NONE ║
║ MEMORY MATCH ......................... 75% ║
╚════════════════════════════════════════════╝

 INTENSITY  0:00 ────────────────────── 15:00
 REAL  ▁▄▇▇▇▇▇▇▇▆▆▆▅▅▄▄▄▃▃▃▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁
 YOU   ▁▆██████████▇▆▄▃▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

 [R] READ REPORT  [P] REPLAY  [N] NEW SESSION  [T] TITLE

 SAVED TO sessions/2026-10-10_1530/
```

**Stat definitions** (all computed by one function from `event_log.jsonl` and `trip_script.json`, shared by the end screen, the report and the tests, so they always agree):

| Stat | Definition |
|---|---|
| Dose step | the selected step |
| Inhaled | `hold_fraction` as a percentage |
| Repeat hits | number of applied repeat hits (blocked attempts not counted) |
| Peak intensity | maximum visual intensity, one decimal |
| Time to peak | time of that maximum after the first hit, `m:ss` |
| Duration | total time with visual intensity above 1, `m:ss` |
| Deepest layer | highest layer entered (`layer_enter` events) |
| Beings met | number of `entity_appear` events and the type of the first, or `NONE` |
| Message | `RECEIVED` if a `message_shown` event occurred, else `NONE` |
| Difficult passage | `NONE`, `RESOLVED IN m:ss`, or `GENTLE MODE` |
| Memory match | share of the timeline where the drawn curve was within 1.5 intensity points of the real visual curve, both resampled every second from the hit to the session end |

**Sparklines:** 36 columns spanning the session, eight block characters (`▁▂▃▄▅▆▇█`) mapping intensity 0–10. `REAL` in amber, `YOU` (the drawn curve) in cyan. If the session ended with Escape, add a line `ENDED EARLY AT m:ss` below the box.

The box is 46 characters wide; on narrow windows scale the font down rather than wrapping.

### 15.4 Exact copy

**Safety screen** — title "Before you begin":

> This is a simulation of the visuals, sounds and timing that people report from inhaled DMT. It does not reproduce the drug's effects, and its doses do not correspond to real amounts.
>
> Do not continue if you have photosensitive epilepsy or have ever had a seizure triggered by flashing lights or patterns. The simulator limits flashing and high-contrast patterns, but no limiter removes all risk.
>
> Sit somewhere comfortable. If you feel unwell at any point, press Escape and the session will fade back to your room.
>
> If you are feeling very low or anxious today, choose gentle mode, or come back another time.

Checkbox: "I don't have photosensitive epilepsy or a history of light-triggered seizures." Buttons: "Continue" (disabled until ticked), "Exit".

**Intake:**
1. "Add a photo of where you're sitting." Options: "Use a photo", "Use a panorama", "Skip — use a default room".
2. "How clear is your intention for this session?" 0 "No idea" … 10 "Very clear".
3. "How do you feel right now?" −5 "Low" … +5 "Great".
4. "I can get completely lost in music or a film." 0 "Not at all" … 10 "Completely".
5. "Vivid images come to me easily when I close my eyes." Same scale.
6. "I sometimes lose track of my surroundings when I'm absorbed in something." Same scale.
7. "Right now I feel…" 0 "Preoccupied" … 10 "Ready to let go".
8. "What brings you here?" Curiosity · Recreation · Reflection · Spiritual.
9. "Which of these have you seen in videos, art or stories?" Jesters · Machine elves · Aliens · Luminous feminine figures · Insectoid beings · None of these.
10. "Choose a dose step." Threshold — "A shimmer at the edges." Light — "Patterns and colour." Strong — "Deep geometry." Breakthrough — "Through to the other side."
11. "Options." Difficult passages: "Real experiences can turn frightening. Turn this off for a gentle session." Eyes: Auto · Open · Closed. Sound. Microphone ("Let sound in the room shape the visuals").

**Settling screen:** "Settling in…" with progress lines "Preparing your room", "Imagining the other side", "Clearing the table" (the last one while models unload).

**The hit:** "Hold space to inhale." While holding: "Hold…" Released early: nothing extra; the partial dose is the realism.

**Blocked repeat hit:** "Too deep to hold the pipe."

**Grounding:** "You're back." then "Take a few slow breaths." then "When you're ready, draw what you remember."

**Curve screen:** "Draw how intense it felt, from the hit until it faded." Button: "Done".

**Report header:** "Simulated trip report", followed by the first paragraph of the safety screen as the disclaimer.

**End screen:** heading line "SESSION COMPLETE · SIMULATED"; menu "[R] READ REPORT  [P] REPLAY  [N] NEW SESSION  [T] TITLE".

---

## 16. Automated verification

### 16.1 Principles

Every milestone has an automated gate. Visual milestones also need your own visual review (section 16.4). Results go to `verification/` as JSON and images; `verify_all.sh` aggregates them.

### 16.2 Test inventory

**Unit (back end, `pytest`):**
- Pharmacology matches the golden file to 1e-3; population table reproduced within sampling error.
- Priors sampler: frequencies over 10 000 samples match `priors.yaml` within sampling error; seeds reproduce exactly.
- Difficult-passage formula: about 0.27 at peak 8.4 with neutral answers; below 0.05 at peak 2.7; exactly 0 in gentle mode.
- Memory model: recall probability decreases with intensity at fixed salience; top-3 events always kept.
- Schema validation of every example and every generated trip script.

**Unit (front end, `vitest`):**
- TypeScript pharmacology matches the golden file to 1e-3, including at `timewarp` 10.
- Layer-weight windows and hysteresis.
- Glyph alphabet deterministic per seed.
- Director: event order for fixed seeds.

**Language model (`backend/tests/test_llm_*.py`):**
- Expansion valid within 3 tries for 5 seeds.
- Content: 20 expansions and 20 reports pass the banned-terms check.
- Report length within the clamp; the written file carries the "Simulated" label.
- Fallback: with the runtime stopped, the template path produces a complete session.

**Assets:**
- Generation smoke test within the time budget.
- Safety-filter wiring: a mocked "flagged" result triggers regeneration then procedural replacement; a filter load failure results in no generated images.
- `/status` reports zero resident models after the ready signal.

**Safety (protected):**
- A full-screen 10 Hz black/white flicker and a saturated-red 8 Hz flicker, rendered through the `SafetyLimiter` and captured at real time, pass `flashcheck`.
- The render pipeline always ends with the limiter pass (structural test on the composer configuration, including in `?debug=1`).
- Worst case: maximum dose step, maximum sensitivity, difficult passage forced, each layer forced through the scrubber for 60 seconds at real time; `flashcheck` reports zero violations.
- Escape from every state (each layer, entity, message, difficult passage) reaches grounding within 4 seconds.
- Audio: an `OfflineAudioContext` render of the full graph at maximum intensity stays under the limiter ceiling with no attack shorter than 200 ms.

**Render galleries (Playwright):** for each layer, capture frames at fixed intensities (1, 3, 5, 7.5, 9) and fixed seeds into `verification/gallery/`, plus a contact sheet `docs/gallery.html`. Automated checks per frame: not blank (luminance standard deviation above a floor), not pure noise (a spectral-peak check for the form-constant and tiling layers), palette colours present. Also capture the title screen, a safety screen, one intake screen and the end screen (from a fixed example session) at 1920 × 1080 and 3840 × 2160.

**Retro screens:**
- Stats: the shared stats function, run on a fixed example event log and trip script, returns the expected values; memory match is 100% for identical curves and 0% for curves always more than 1.5 apart.
- End to end: the values shown on the end screen equal the report's front matter and stats box.
- The title screen, recorded for 30 seconds at real time, passes `flashcheck` (colour cycle, cursor and scanlines included).

**End to end (Playwright, `tests/e2e/`):**
- Four sessions, one per dose step, with `?autofill=neutral&timewarp=10&seed=<fixed>`: intake, real planner and assets (except the template run), hit, trip, grounding, curve (drawn programmatically), report. Assert: expected event types present; deepest layer matches the trip-script prediction; report files exist with the "Simulated" label and front matter; frames captured.
- One run with `HYPERSPACE_FORCE_TEMPLATES=1` and image generation disabled (procedural everything).
- One run that presses Escape at breakthrough: grounding follows and a report is still produced.
- One gentle-mode run with a difficult passage forced by seed: no `challenge_start` event occurs.
- Replay determinism: replaying a session reproduces the same event sequence.

**Privacy:** an end-to-end run where Playwright fails on any non-localhost request and the back end runs with offline environment variables and the loopback-only socket guard.

**Performance:** headed Chromium with the GPU (Xvfb if needed), 1920 × 1080, 30 seconds at breakthrough via the scrubber: median frame time ≤ 17 ms with render scale ≥ 0.75. If the GPU cannot be reached from the test browser, record "unmeasured" (section 0.6), never "passed".

**Validation:** section 14 with `--n 200`.

### 16.3 Demo capture

`tools/capture.ts --demo` records a real-time (never time-warped) 3-minute excerpt of a strong session from onset to peak, plus a 60-second breakthrough excerpt forced through the scrubber, as `docs/demo.mp4`. The demo itself must pass `flashcheck`.

### 16.4 Visual self-review

At every visual gate, open the gallery images and judge them against this rubric. Write a verdict per layer (pass or fix, with the image paths) in `RESULTS.md`. Fix and re-capture until every item passes.

- **Room:** the photo is recognisable at intensity 1 and visibly breathing or tiling at 3; no tearing at depth edges.
- **Form constants:** each of tunnels, funnels, spirals and lattices recognisably present across the seeds; edges soft; no harsh black/white stripes.
- **Chrysanthemum:** hyperbolic tiling clearly visible (tiles shrinking towards the disk edge); Kleinian limit sets look like lace or pearls, not noise.
- **Waiting room:** reads as an enclosing, infinite interior; no banding or ray-march artefacts.
- **Breakthrough:** world backdrop has no visible seam or pole pinch; entities are cleanly cut out with no background halo; no text or letters in generated images; nothing that violates section 4.3.
- **Title and end screens:** retro and uncluttered; box borders unbroken and aligned on the character grid; text legible at both resolutions; scanlines barely visible; sparklines readable.
- **Overall:** colours coherent with the palette; the layers look coupled (shared motion and rhythm), not stacked; the whole thing looks intentional and beautiful, not like a tech demo.

### 16.5 `scripts/verify_all.sh`

Runs, in order: environment check, unit tests (both ends), language-model tests, asset tests, safety tests, galleries, end-to-end suite, privacy test, performance test, validation (`--n 200`), demo capture with `flashcheck`. Writes `verification/summary.json` with per-check status (`passed`, `failed`, `unmeasured`), timings and artefact paths. Exits non-zero if any core check failed. "Unmeasured" is allowed only for performance and only with the reason recorded.

### 16.6 `DONE.md`

Generated from `verification/summary.json` and `NOTES.md`:

- How to run (`./run.sh`), controls, where sessions and reports go.
- Verification summary table.
- Models in use, measured graphics memory, performance numbers.
- Active fallbacks and every decision made under section 0.2.
- Links to `docs/gallery.html`, `docs/demo.mp4` and one example session's report.
- Known limitations, honestly stated.

---

## 17. Repository layout

```
hyperspace-sim/
  BUILD.md  PROGRESS.md  NOTES.md  RESULTS.md  DONE.md  README.md
  run.sh
  scripts/            setup.sh  fetch_models.py  verify_all.sh  check_env.py
  shared/
    schemas/          intake, trip_script, event_log, expansion (+ examples)
    golden/           pharmacology.json
  backend/
    app.py
    pharmacology.py
    planner/          priors.yaml  sampler.py  expand.py  templates/  prompts/
    assets/           imagegen.py  depth.py  cutout.py  panorama.py  procedural.py  safety_filter.py
    safety/           banned_terms.txt  socket_guard.py
    report/           memory_model.py  writer.py  templates/  figures.py  html.py  prompts/
    batch/            validate.py  coder.py
    tests/
  frontend/
    index.html
    public/fonts/
    src/
      main.ts  state.ts  pharmacology.ts  director.ts  quality.ts
      layers/         room.ts  neuralField.ts  hyperbolic.ts  waitingRoom.ts  breakthrough.ts  glsl/
      audio/          synth.ts  limiter.ts
      safety/         safetyLimiter.ts  comfort.ts
      ui/             retro.css  title.ts  safetyScreen.ts  intake.ts  settle.ts  hit.ts  hud.ts  grounding.ts  curveDraw.ts  endScreen.ts  stats.ts  debugScrubber.ts  report.ts
    tests/
  tests/e2e/          specs + profiles/neutral.json
  tools/              flashcheck.py  capture.ts  replay.ts
  assets/sample/      room.jpg (generated at setup)
  docs/               gallery.html  demo.mp4
  verification/       env.json  summary.json  gallery/  captures/
  sessions/           (gitignored)
```

---

## 18. Milestones and gates (no human checkpoints)

Work in order. After each milestone: run its gate, update `PROGRESS.md`, append to `RESULTS.md`, commit. From M3 onward, the end-to-end test must pass at every commit.

| | Milestone | Gate |
|---|---|---|
| M0 | Setup and contracts: `setup.sh`, `fetch_models.py`, schemas with examples, golden file from section 7.4, `PROGRESS.md`, git | `check_env.py` passes or fallbacks recorded; schema tests pass |
| M1 | Pharmacology in Python and TypeScript, heads-up display | Golden tests pass in both; section 7.3 tables reproduced; repeat-hit blocking works |
| M2 | `SafetyLimiter`, `flashcheck`, safety screen, exit flow | All safety tests that do not need real layers pass. **No intense visual layer before this gate.** |
| M3 | Walking skeleton: every screen of section 5.1 in the retro style (title and end screens included, stats from the shared function), template planner, placeholder shader per layer, template report (Markdown + HTML) | End-to-end suite passes for all four dose steps in `timewarp` |
| M4 | Room layer (photo, panorama, default; eyes-closed field) | Gallery + visual review; `flashcheck`; end to end green |
| M5 | Neural field form constants | Spectrum test (power peak at the predicted wavenumber above threshold, noise level below); gallery shows all four classes; `flashcheck` at maximum |
| M6 | Chrysanthemum and fractal waiting room | Gallery + visual review; `flashcheck`; full procedural trip via scrubber |
| M7 | Audio | Offline audio test passes; levels follow the shared state |
| M8 | Real intake, planner (language model), assets, image safety filter, settling screen | Intake to ready within 3 minutes; models unloaded before the hit; language-model and asset tests; template fallback test |
| M9 | Breakthrough, director, entities, glyph messages, difficult passages, gentle mode, grounding | End-to-end suite incl. Escape and gentle-mode runs; worst-case `flashcheck`; visual review of breakthrough gallery |
| M10 | Full report: curve drawing, memory model, writer, lab view, export, replay | Report and replay tests; end to end green |
| M11 | Validation, polish (section 15), performance, privacy, demo, `DONE.md` | `verify_all.sh` exits 0; `DONE.md` written |
| M12 | Stretch, optional: hyperbolic 3-space waiting room; WebXR headset mode with comfort limits; replay to video; live diffusion | Each item keeps `verify_all.sh` green |

---

## 19. Parallel tracks (if sub-agents are available)

After M3, the lead keeps integration, the limiter and verification, and may delegate:

- **Track A — time and safety:** pharmacology, director, shared state, heads-up display, scrubber, limiter tests, exit and grounding.
- **Track B — visuals:** room, neural field, chrysanthemum, waiting room, breakthrough rendering (against the scrubber and example trip scripts).
- **Track C — back end:** planner, language model, assets, safety filter, report, validation.
- Audio and the intake interface go to whichever track frees up first.

Every track works against the frozen schemas; any rendering change re-runs `flashcheck` before merge.

---

## 20. Working protocol

- **Safety first** (section 4): never weakened, never optional, never behind a setting.
- **Use the scrubber and `timewarp`** for functional work; use real time only for `flashcheck`, performance and the demo.
- **Small runs first:** low resolution, few images, short sessions, then scale up.
- **Do not silently substitute:** every substitution goes in `NOTES.md` and `DONE.md`.
- **Record negative results** in `RESULTS.md`.
- **No premature generality:** the non-goals are excluded on purpose.
- **Keep numbers traceable:** literature numbers live in `priors.yaml` or a constants file with their source.
- **Finish properly:** a working, beautiful, verified product with `DONE.md` beats a larger unfinished one.

---

## 21. References

- Bressloff, Cowan, Golubitsky, Thomas & Wiener (2001). Geometric visual hallucinations, Euclidean symmetry and the functional architecture of striate cortex. *Philosophical Transactions of the Royal Society B* 356:299–330.
- Bressloff et al. (2002). What geometric visual hallucinations tell us about the visual cortex. *Neural Computation*.
- Coulon, Matsumoto, Segerman & Trettel (2022). Ray-marching Thurston geometries. *Experimental Mathematics* 31(4):1197–1277. Code: 3-dimensional.space.
- Davis et al. (2020). Survey of entity encounter experiences occasioned by inhaled N,N-dimethyltryptamine. *Journal of Psychopharmacology*.
- Eckernäs et al. (2022). Population pharmacokinetic/pharmacodynamic modeling of the psychedelic experience induced by N,N-dimethyltryptamine. *Clinical and Translational Science*.
- Ermentrout & Cowan (1979). A mathematical theory of visual hallucination patterns. *Biological Cybernetics*.
- Haijen et al. (2018). Predicting responses to psychedelics: a prospective study. *Frontiers in Pharmacology* 9:897.
- Lawrence, Carhart-Harris, Griffiths & Timmermann (2022). Phenomenology and content of the inhaled N,N-dimethyltryptamine experience. *Scientific Reports* 12.
- Luan et al. (2024). Psychological and physiological effects of extended DMT. *Journal of Psychopharmacology*.
- Michael, Luke & Robinson (2021). An encounter with the other: a thematic and content analysis of DMT experiences from a naturalistic field study. *Frontiers in Psychology* 12:720717.
- Russ et al. (2019). Replication and extension of a model predicting response to psilocybin. *Psychopharmacology*.
- Strassman, Qualls & Berg (1996). Differential tolerance to biological and subjective effects of four closely spaced doses of N,N-dimethyltryptamine in humans. *Biological Psychiatry* 39(9):784–795.
- Suzuki, Roseboom, Schwartzman & Seth (2017). A deep-dream virtual reality platform for studying altered perceptual phenomenology. *Scientific Reports* 7:15982.
- Timmermann et al. (2019). Neural correlates of the DMT experience assessed with multivariate EEG. *Scientific Reports*.
- Micro-phenomenology of the intravenous DMT experience (Imperial College London, 23 participants): bodily effects typically before visual before auditory.
- Spiral brain dynamics track the temporal unfolding of subjective intensity during the DMT experience (bioRxiv preprint, 2026).
- Subjective Effect Index (effectindex.com), Josie Kins: visual effect definitions and replications.
- Gómez-Emilsson, The hyperbolic geometry of DMT experiences (Qualia Research Institute essay; not peer reviewed).
- WCAG 2.x success criterion 2.3.1; Ofcom guidance on flashing images and regular patterns; ITU-R BT.1702.
- StreamDiffusion and StreamDiffusionV2 (real-time diffusion pipelines), for the optional live layer.
