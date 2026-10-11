# RESULTS.md

Per-milestone gate results, visual review verdicts and negative results.

## M0 contracts + M1 pharmacology (contracts/pharmacology agent)

- Schemas: 4 schemas, 15 example instances + 2 e2e profiles valid; enum coverage complete (except expansion.message_theme, exempt). `uv run pytest backend/tests/test_schemas.py`: 17 passed.
- Golden file generated once (8 cases × 251 samples); PROTECTED.
- Python: `uv run pytest backend/tests/test_pharmacology.py`: 19 passed. Typical table reproduced: peaks 0.564 / 2.720 / 5.992 / 8.567, peak time 1.822 min, minutes > 1: 0 / 4.155 / 7.157 / 11.123; channel peaks 1.293 / 1.822 / 2.567 min.
- Population (3000 samples per step, seed 20261010, dt 1/600, vectorised): peak p10/50/90 threshold 0.31/0.57/1.02, light 1.66/2.72/4.14, strong 4.34/5.99/7.45, breakthrough 7.59/8.54/9.19; minutes > 1 threshold 0/0/0.48, light 2.65/4.12/5.59, strong 5.58/7.16/9.11, breakthrough 8.66/10.95/15.84 — all within tolerance of §7.3.
- NEGATIVE RESULT: §7.3 deepest-layer distribution not reproducible with the §11.2 entry thresholds (e.g. light: form constants 37% vs 73% printed; strong: waiting room 4% vs 19%). True values asserted instead; details in NOTES.md "Population table discrepancy".
- TypeScript: `npx vitest run tests/pharmacology.test.ts tests/layerWeights.test.ts`: 51 passed; golden match < 1e-3 (strong, uniform frames: < 1e-6) for uniform 1/60-min frames, irregular frames and timewarp 10, including the repeat-hit case through `addHit`.

## M0–M3 integration gate (2026-10-10)

Server for e2e: `HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1 ./run.sh --serve-only` (log `verification/server.log`); `/api/status` ok, `/` serves `frontend/dist`, `/fonts/VT323-Regular.ttf` 200 font/ttf.

| Gate | Command | Result |
|---|---|---|
| env (M0) | `uv run python scripts/check_env.py` | exit 0 |
| back-end unit + LLM (M0/M1/M2) | `uv run pytest backend/tests -q --timeout 900` | 94 passed, 0 failed (163 s; LLM tests ran live on qwen3:14b) |
| type check | `cd frontend && npx tsc --noEmit` | 0 errors (was 18 in tests/e2e + tools before the integration fix D-I1) |
| front-end unit (M1/M2/M3) | `cd frontend && npx vitest run` | 91 passed (6 files) |
| build | `cd frontend && npx vite build` | ok |
| e2e (M2/M3) | `cd frontend && npx playwright test --reporter=list` | 17 passed, 0 failed (5.7 min): safety-limiter 5, screens 8, session 4 (threshold 37 s, light 57 s, strong 1.3 min, breakthrough 2.2 min at timewarp 10) |
| headless pipeline | `uv run python -m backend.batch.validate --n 20` | runs (0.3 s); at n=20 geometry/sound/profundity/median fail on sampling noise (saved as `verification/validation_n20.json`); `--n 200` re-run: all targets pass (`verification/validation.json`) |

The whole gate set was run twice (before and after the D-I4 font fix) with identical counts.

Captures: `verification/gallery/screens/{title,safety,intake,end}_{1920x1080,3840x2160}.png`; safety captures `verification/captures/safety-*/`; trip frames in `sessions/2026-10-10_1850_3` (threshold), `_1850_4` (light), `_1851` (strong), `_1853` (breakthrough) from the first run; the second run wrote newer sessions with the same seeds.

Visual review (M3, placeholders):
- Title / safety / end screens: PASS: box borders unbroken and on the 46-column grid at both resolutions, nothing wraps, scanlines barely visible, title art matches §15.2.
- Intake: FIX then PASS: `■□` were outside the box font's unicode-range, fell back to a wider font and broke the grid (D-I4); re-captured, now aligned.
- Trip frames: placeholder shaders as intended for M3 (procedural room, soft spirals for form constants, swirl for chrysanthemum, rings for the waiting room, soft glows for beings/message); soft-edged, low contrast, nothing broken. The room placeholder does not yet use the room photo (M4).

Negative results / open items:
- §7.3 deepest-layer distribution not reproducible (pharmacology agent, see NOTES).
- Images are procedural and room depth synthetic (Fallbacks active); the M3 gate runs with forced templates.
- Not yet covered (later milestones): Escape and gentle-mode e2e (M9), replay determinism spec (M10; replays drift at a different timewarp, D-F9), privacy e2e, performance, `tools/capture.ts --demo`, `scripts/verify_all.sh`.

## Audio (audio agent, M7)

Commands (Vite dev server only, port 5178): `cd frontend && npx vite --port 5178 --strictPort`, then
`E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test ../tests/e2e/audio.spec.ts` → **2 passed** (~12 s);
`npx vitest run tests/audio.test.ts` → **20 passed** (full vitest 167/167); `npx tsc --noEmit` → 0 errors.

Offline render (OfflineAudioContext 48 kHz, frame-by-frame suspend/resume every 16 ms, volume 1), `verification/audio-test.json`:

| Render | peak dBFS | max 10-ms-RMS rise in 200 ms | RMS dBFS |
|---|---|---|---|
| max (all 10, breakthrough 1, entity, challenge 1, 20 s) | −5.00 | 9.43 dB (during the start fade + roughness) | −20.2 |
| intensity 2 / 8 (levels follow state) | −29.4 / −18.0 | 5.0 / 5.7 | **−39.6 < −26.8** |
| i6 / i10 | −22.2 / −13.5 | 5.6 / 6.5 | −31.0 / −22.4 |
| breakthrough / challenge→relief / exit+grounding | −7.5 / −10.4 / −20.4 | 6.6 / 9.2 / 10.6 (10-ms-window variance of the 320 Hz ambient noise at −55 dBFS, not an onset) | |
| ceiling stress (+12 dBFS square + noise into the chain) | **−3.44** | — | — |

Buzz at intensity 10: envelope-spectrum peak **11.499 Hz** (= 23 × the 0.5 Hz pulse; oscillator max 11.88 Hz, ≤ 12); live AudioContext smoke test: no errors, lock n = 21–23.

Spectrogram review (listening is impossible here; WAVs in `verification/audio/*.wav`, PNGs made with matplotlib, top: spectrogram 20 Hz–16 kHz log, middle: 2.5 ms envelope 6–9 s, bottom: 10 ms RMS):
- `verification/audio/i2_spectrogram.png` — quiet carrier at 330 Hz with soft harmonics, whine line at 2.8 kHz, 44 Hz rumble, 4.8 Hz buzz ripple, two sparse crackle grains (eyes open, full band); slow 0.5 Hz carrier beat. Reads as the onset "hum". OK.
- `verification/audio/i6_spectrogram.png` — carrier ~830 Hz, whine ~4 kHz, crackle grains now muffled to 1–4 kHz blobs (eyes closed), buzz ~8 Hz clearly visible. OK.
- `verification/audio/i10_spectrogram.png` — 1760 Hz carrier "ringing" with harmonic stack, 6.8 kHz whine, denser soft popcorn, 60 Hz rumble; envelope shows a clean 11.5 Hz buzz riding the pulse swell. First version had a 3 Hz 10 dB beat (fixed-cent detune) and a crackle wash 300 Hz–15 kHz; both fixed (D-A2, Q 12–30 grains at ≤ 5/s). OK.
- `verification/audio/breakthrough_spectrogram.png` — slow detuned pad chord 150–600 Hz crossfading to the next chord at ~10.5 s, entity voices as gliding formant traces 500 Hz–5 kHz from ~9 s (vowel glides, no consonants), carrier and rumble underneath. OK.
- `verification/audio/challenge_spectrogram.png` — from 3 s inharmonic ring-mod lines and cluster chord appear; at 13 s the ring-mod lines vanish and the pad crossfades to the open major relief chord: dissonance resolving to consonance is visible. OK.
- `verification/audio/exit_spectrogram.png` — trip sound fading over 3 s from Escape at 6 s under the E4 → C4 exit third (overlapping swells, no dip), silence, then the low drone + dark air of the grounding ambient fading in from 9 s and out after stop() at 15 s. OK.

Flashcheck: not applicable (audio renders no pixels; no visual layer owned).
Spectrogram script used: `/tmp/claude-1001/-home-mstock-Code-hyperspace/ed38d197-10ec-4fbb-aa1b-14326be0a94b/scratchpad/spec.py` (scratch, not in the repo).

## Chrysanthemum (M6, hyperbolic-waitingroom agent)

- Unit: `cd frontend && npx vitest run tests/hyperbolic.test.ts`: 37 passed (fundamental-triangle angles π/p, π/q, π/r for 8 groups; reflections preserve the disk and hyperbolic distance; folding converges into the triangle in < 28 iterations out to |z| = 0.95; Maskit and Grandma generators satisfy tr b = 2 / tr a = −iμ / tr[a,b] = −2; the crossfade scheduler changes every 6–14 s of model time and never faster than the 0.3 s crossfade even at timewarp 1000 with challenge on). Full front-end suite: 178 passed; `tsc --noEmit` clean.
- Gallery (headless Chromium, RTX 4090 via ANGLE, 1280×720, layer forced through the debug scrubber): `verification/gallery/chrysanthemum/chrysanthemum_v{5,7.5,9}_seed{11,22}.png`, plus challenge `chrysanthemum_v9_seed{11,22}_ch.png`. **Verdict: PASS.** v5: a flower of {7,3}/{8,..} polygons, each one a small petalled flower, rings coloured through the palette, tiles clearly shrinking towards the rim, which becomes scalloped petals. v7.5/v9: Maskit limit-set lace (pearl chains of tangent circles and fine filaments) rings the tiled centre; it reads as lace and pearls, not noise. The neural field shows as faint spirals and rings on the tiles (coupling). Challenge: harsher olive/magenta hues, tighter sheet, faster motion. Earlier iterations were FIX: pastel/near-grey (luminance too high), discs filled instead of outlined (DE sign), and blocky limiter artefacts from too much local contrast. All three were fixed with the B·F luminance scheme (NOTES H4).
- Real-time flashcheck, v = 9, challenge forced and re-forced for the whole capture (mean level 0.98), 20 s at 30 fps, headed Chrome on :1: `verification/captures/flash-chrysanthemum-v9-challenge/`. **PASS**: 0 general flashes, 0 red flashes, 0 pattern frames (max periodic contrast 0.42, area 0); 2 group crossfades inside the window; SafetyLimiter never engaged (an earlier seed-11 run had 4 crossfades and also passed).
- Frame time, 1920×1080, headless Chromium, synchronous render + 1-px readPixels, median over 70 frames, layer-on minus layer-off: **0.3–0.7 ms** (single tiling; a crossfade evaluates two tilings, at most about 2×). The GPU was shared with other agents (99 % utilisation), so these numbers are noisy upper bounds.

## Waiting room (M6, hyperbolic-waitingroom agent)

- Gallery (same set-up, kind forced per run): `verification/gallery/waiting_room/waiting_room_{kifs,mandelbox}_v{7.5,9}_seed{11,22}.png`, challenge `waiting_room_mandelbox_v9_seed11_ch.png`. **Verdict: PASS.** kifs: an octagonal kaleidoscopic Menger hall receding to a vanishing point, with side chambers opening at every level. mandelbox: an endless lattice of ornate Mandelbox blocks around crossing halls, fading into coloured fog. Both read as an enclosing infinite interior with a stable horizon. No banding (static dither) and no step artefacts (pixel-cone epsilon, soft normals). Earlier iterations were FIX: flat purple with blotchy orbit-trap colour, a camera parked inside a smooth fold sphere (fixed by a path sweep, NOTES H6), and neural-field rings overpowering the geometry (coupling reduced to a subtle ±5 %).
- Real-time flashcheck, v = 9, challenge forced (mean 0.98), 20 s: `verification/captures/flash-waiting_room-kifs-v9-challenge/` and `flash-waiting_room-mandelbox-v9-challenge/`. **Both PASS**: 0 flashes, 0 pattern frames (max periodic contrast 0.36 / 0.49, area 0); limiter never engaged. The kifs capture achieved only 24.9 source fps (GPU shared); an earlier kifs run at 43 fps also passed.
- Frame time at 1920×1080 (same method): kifs **≈1.1 ms**, mandelbox **1.7–3.2 ms**, at quality 1 (128 steps). Within the 6 ms budget. Quality knob `WaitingRoomLayer.quality` (0.5–1).
- e2e: `tests/e2e/session.spec.ts` breakthrough (timewarp 10) passed on my stack (ports 8774/5177); the in-session frames (`layer_enter_chrysanthemum/waiting_room`) composite correctly over the other layers.

## Neural field (neural-field agent, M5)

Gate: spectrum test, gallery with all four classes, flashcheck at maximum.

- Unit (CPU reference, `cd frontend && npx vitest run tests/neuralField.test.ts`): **11/11 pass**. Below the critical gain (v = 1, β/β_c = 0.5) peak/median 1.8 (< 3). Above it (v = 6), rings, funnels and spirals have their dominant wavenumber at the linear-stability prediction (±15%), peak/median ≥ 8 and the expected orientation. Hexagons show three directions 60° apart. Seeds reproduce exactly.
- Browser (GPU field read back, `E2E_BASE_URL=… npx playwright test neuralfield-spectrum`): **3/3 pass**.
  - v = 1: peak/median 1.73.
  - v = 6 stripes: k = 0.4418 vs predicted 0.4418, peak/median 6e5.
  - v = 6 hexagons: k = 0.4476 (+1.3%), directions 2.5°/62.5°/117.5° at relative power 1/0.97/0.97.
  - Artefacts are in `verification/neural_field/`.
- Gallery (`FORM_CONSTANTS_GALLERY=1`, 4/4 pass): `verification/gallery/form_constants/{tunnels_seed7,funnels_seed11,spirals_seed12,lattices_seed13}_v{3,5,7.5,9}.png`. **Verdict: PASS.**
  - Every class is unmistakable: concentric tunnel rings, radial funnels, logarithmic spirals, and an expanding hexagonal dot lattice.
  - Edges are soft (Gaussian-smoothed field, no aliasing at the fovea) and there is no black or white anywhere. Colours come from the trip palette: neon gives violet with gold/pink/cyan filaments, lunar gives cool blues.
  - Weakness: v = 3…9 look similar, because the gain is capped at 1.8·β_c for ordered patterns. Intensity shows only as more detail and glow.
  - The lunar palette renders nearly monochrome blue; that is the palette's own character.
- Flashcheck, 20 s real time, headed Chrome on the RTX 4090, v = 9, challenge forced, layer forced: **PASS**.
  - `verification/captures/neural_field_v9_challenge_stripes_x`: max 0.5 general flashes/s, 0 red, 0 pattern frames, max periodic contrast 0.408, 0 motion windows.
  - `verification/captures/neural_field_v9_challenge_hexagons`: max 0.5 flashes/s, 0 pattern frames, contrast 0.401.
  - An earlier run in mixed mode, with the luminance ratio still at 2.4, also passed but measured contrast 0.467. The ratio was lowered to 2.2 at the source for margin.
- End to end: `session.spec` at the strong dose passes with the real layer (1/1).

## Room layer (room-layer agent, M4)

Unit tests: `cd frontend && npx vitest run tests/room.test.ts` → 20/20 pass (geometry selection photo/panorama/default, depth → displacement, ray-consistent displacement, cover fit + comfort-clamped look never shows the border, sphere orientation, pmm/p4m/p6m folds (periodicity, mirrors, rotations, continuity), effect amounts, all modulation rates ≤ 0.5 Hz incl. challenge, tracer decay < 0.5 s, palette selection). `npx tsc --noEmit` clean for the room files.

Worst-case real-time flashcheck (20 s at 30 fps, headed Chrome + RTX 4090, never time-warped, scrub v = 9, room forced, challenge forced):
- photo + continuous user mouse sweeps (tracers, parallax): PASS: 0.5 general flashes/s max, 0 red, 0 pattern frames (max area 0.188), mean luminance ≤ 0.21 (`verification/tmp/room-layer/flash_v9_photo`)
- procedural default room: PASS: 0.0 flashes/s, 0 pattern frames (`verification/tmp/room-layer/flash_v9_default`)
- eyes closed (phosphene field): PASS: 0.0 flashes/s, 0 pattern frames, mean luminance ≤ 0.044 (`verification/tmp/room-layer/flash_v9_eyes`)

Visual review (`verification/gallery/room/`; `*_prelimiter.png` = the scene target before the SafetyLimiter, the plain name = the screen):
- room_photo_v1_prelimiter.png: PASS. The sample photo is undistorted and fully recognisable.
- room_photo_look_prelimiter.png (v 1.5, look at the clamp corner): PASS. Parallax with no tearing at depth edges and no visible mesh border.
- room_photo_v3_prelimiter.png: PASS. Visibly breathing (window mullions and shelves bend) and drifting; the first symmetrical repetition patches appear on the bookcase.
- room_photo_v5_prelimiter.png / room_photo_v7_prelimiter.png: PASS. Kaleidoscopic repetition patches (bookcase, cushions, plant) follow the active field; saturation and hue shift rise; the room is still readable.
- room_photo_eyes_prelimiter.png, room_default_eyes_prelimiter.png, room_flash_v9_eyes_f300.png: PASS. A dim phosphene field showing the neural field in palette colours (mean luminance 0.02–0.04).
- room_default_v1.png / _v3 / _v5: PASS. The procedural interior looks intentional: a corner with a window, daylight on the plank floor, a rug and a picture. It breathes and tiles like the photo. It is a little soft, and the tiling on its plain walls is subtle.
- room_pano_v1_prelimiter.png / room_pano_v3_prelimiter.png: PASS for the mapping (inward sphere, look-around, breathing). The test panorama is a mirrored copy of the sample photo, so a mirror seam is expected.
- room_photo_v1.png / room_photo_v3.png (after the limiter): FIX NEEDED, OUTSIDE THIS LAYER. The SafetyLimiter's always-on large-area contrast guard is engaged on every natural photo (highContrastFraction 0.98 at v = 1) and paints grey blotches over dark-on-bright detail (the plants and the sofa). Details and a suggested fix are in NOTES.md "Integration notes (room-layer agent, M4)". The room layer already caps contrast at source for the periodic content it creates.

## gallery-harness (scrub mode, render galleries, gallery checks, contact sheet, worst-case flashcheck) — 2026-10-10

Harness: sound. `gallery_checks.py --selftest` PASS (noise/blob rejected, stripes/tunnel/funnel/spiral/honeycomb/flower accepted, clean and 8-bit+grain). Normal flow unaffected: `session.spec.ts` threshold + breakthrough 2/2 pass, `pipeline.test.ts` 7/7, `tsc --noEmit` clean. `scripts/gallery.sh` self-start/stop verified (GALLERY_LAYERS=form_constants: 12/12).

Gallery (64 frames, Vite snapshot of the tree at ~20:05, scrub mode, dose breakthrough): 46/64 pass.
- room 16/16 · form_constants 12/12 · chrysanthemum 12/12 · waiting_room 4/12 (stuck 8) · breakthrough 2/12 (placeholder: palette 10, stuck 4).
- Against the M3 placeholders (first runs): form_constants 0/12 (palette 12, stuck 8, blank — near-isoluminant orange/grey), breakthrough 0/12, room/waiting_room placeholders failed palette/stuck — as expected.
Contact sheet: docs/gallery.html.

Visual verdicts (images reviewed):
- Room: PASS — verification/gallery/room/room_v1_s11.png recognisable room; room_v3_s11.png breathing + wallpaper-group glyph tiling masked by the field; v 7.5/9 saturated colour, coherent. FIX (safety) — eyes-closed field room_v3_s11_eyes.png / room_v9_s11_challenge.png: saturated rings on near-black, linear Michelson 0.87 (worst case FAILS, below).
- Form constants: PASS with a note — form_constants_v3_s11.png rings (tunnel), form_constants_v3_s23.png hexagonal dot lattice on a log-polar spiral (funnel/lattice); soft edges, no black/white. v 3…9 nearly identical per seed (no visible growth with intensity) and the s11 rings read a bit like a target; v1 frames show the sub-threshold blob (correct).
- Chrysanthemum: PASS — chrysanthemum_v1_s11.png {7,3} heptagonal tiling with petals, tiles shrinking to the rim; chrysanthemum_v7.5_s23.png / v9_s23 Kleinian lace ring around the tiling; looks intentional and beautiful.
- Waiting room: FIX — waiting_room_v5_s23.png / v9_s11: mandelbox walls read as an interior but washed-out lilac haze (luma std ~0.02), and frames do not change with intensity (stuck).
- Breakthrough: placeholder (soft pink glow) — not reviewable yet.
Worst case (PROTECTED spec, 60 s + setup each, real time, headed Chrome RTX 4090, 59–60 source fps, Vite snapshot): form_constants PASS (max 1.0 flash/s, max periodic contrast 0.40), chrysanthemum PASS (1.0/s, 0.55 on 6% area), waiting_room PASS (0.5/s), breakthrough PASS (0.5/s, placeholder), sweep 0→10→0 PASS (1.0/s, 0.57 on 6%), room FAIL (105 pattern frames, contrast 0.88 on 37%; earlier run 1319 frames on 56%) — verification/captures/worstcase-room/frame_000600.png. Limiter engaged 0× in every run.

## Assets (assets-backend agent, M8 back-end half) — 2026-10-10
Tests: `uv run pytest backend/tests/test_assets.py backend/tests/test_safety_filter.py backend/tests/test_depth.py -q` → **41 passed** (real models, ~5 min); full back-end suite `uv run pytest backend/tests -q -x --timeout 900` → **135 passed**.
Gate (M8 back-end half): `uv run python scripts/measure_vram.py --start --port 8776` → breakthrough session with qwen3:14b + SDXL-Lightning, intake→ready **57.8 s** (< 180 s), resident models after ready `[]`, 9 MB allocated. VRAM table in NOTES.md; raw data `verification/vram.json`.
Flashcheck (§4.1, static assets): 20-s real-time pans (30 fps, 3°/s) through 6 procedural world categories and 2 generated worlds: all PASS after the pattern-safe floor (before: up to 600/600 pattern frames). Glyph beings/sprites are not full-screen periodic patterns; the layer that animates them must re-verify.
Visual review (§16.4 "Breakthrough"), images in `verification/gallery/assets/`:
- `final_worlds_seam_centered.png` (seam rolled to the centre): PASS — no visible seam, poles calm, no text; world 2 shows lantern-lit tents with figures in the distance in this run → crowd gate tightened to 0.3 afterwards; `regen_worlds_people_rejected.png` shows the same session regenerated: crowd world rejected and replaced by an empty jewelled panorama. Soft glow from the pattern floor is visible around bright detail (acceptable, reads as luminous).
- `final_sprites.png` (on light grey and on near-black): PASS — clean cut-outs, no dark halo, no text, robed/abstract figures; some variants keep a halo ring/arch from the generation (part of the figure, intentional-looking).
- `llm_session_sprites.png` / `llm_session_worlds_seam_centered.png` (first run, before the background/crowd gates): FIX → led to A5 (background and crowd gates) and palette words in prompts.
- `glyph_beings.png`: PASS — luminous kaleidoscopic glyph beings, three variants per family (rest / unfolding / dissolving), deterministic.
- `procedural_worlds.png`, `procedural_jungle.png`, `procedural_pan_views.png`: PASS with reservations — seamless, palette-coherent, pattern-safe; the dome/hall are softer and hazier than I would like because of the §4.1 floor (they are the last-resort fallback); the cosmic field is the strongest.
- `room_depth.png`: PASS — Depth Anything depth, white = near (floor and sofa bright, window/back wall dark), edges aligned with the photo.
Unfinished: text detection inside generated images (A4); rembg on GPU (wheel mismatch, A8).

## M4–M8 integration gate (integration agent, 2026-10-10)

Commands and results (all from the repo root unless noted):
- `uv run pytest backend/tests -q --timeout 1200` (incl. GPU/LLM/asset tests): **135 passed**, 0 failed (7 min 52 s).
- `cd frontend && npx tsc --noEmit` clean; `npx vitest run`: **179 passed** (10 files); `npx vite build` ok.
- Production-like server `./run.sh --serve-only` (real qwen3:14b + SDXL-Lightning, no overrides) → `cd frontend && npx playwright test audio safety-limiter screens session neuralfield-spectrum --reporter=list`: **22 passed, 4 skipped** (the opt-in form-constants gallery), 13.2 min. Sessions threshold/light/strong/breakthrough planned by the LLM (`provenance.planner = llm`; strong and breakthrough with `images = sdxl_lightning`). Re-run of the breakthrough session after the final build: 1 passed.
- Scrub-based capture specs against the template + procedural stack (D-I11): `scripts/worstcase_flash.sh` (60 s per layer + sweep, headed Chrome, real time): **6/6 pass** — room 0.5 flashes/s, 0 pattern frames (max periodic contrast 0.661 over 6 % area); form_constants 0.5, 0 (0.458, 0 %); chrysanthemum 0.5, 0 (0.585, 6 %); waiting_room 0.0, 0 (0.591, 6 %; re-run after the last waiting-room change: 0.0, 0, 0.606 over 3 %); breakthrough (placeholder) 0.5, 0; sweep 0→10→0 pass; limiter engaged 0× in every case. `scripts/gallery.sh` + `tools/gallery_checks.py`: **54/64** — room 16/16, form_constants 12/12, chrysanthemum 12/12, waiting_room 12/12, breakthrough 2/12 (still the M3 placeholder: palette 10, stuck 4; M9). `gallery_checks.py --selftest`: PASS. `FORM_CONSTANTS_GALLERY=1 npx playwright test neuralfield-spectrum --grep gallery`: 4 passed.
- Template/procedural path on a second server (port 8779, `HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1`, built front end): `session.spec` **4/4 passed** (5.5 min).
- **M8 gate (intake → ready, real models, breakthrough, neutral intake):** 40.5 s (`verification/tmp/integrate/m8gate.py`, session 2026-10-10_2211: LLM planner, 5 SDXL images in 6.1 s, cut-outs 17.7 s); `scripts/measure_vram.py --start` 58.8 s. Gate < 180 s: **PASS**. `/api/status.resident_models` = [] before the intake and after ready; torch allocated after unload 9 MB.
- **Measured graphics memory** (`scripts/measure_vram.py`, after the `num_ctx` fix):

| Phase | Resident | Peak | Budget (§3.3) |
|---|---|---|---|
| Room depth (at upload) | Depth Anything V2 Small | 0.17 GB (assets agent) | < 2 GB |
| Planning | qwen3:14b (Ollama, num_ctx 8192) | **9.75 GB** (was 13.55 GB without num_ctx) | 6–10 GB ✓ |
| Images | SDXL-Lightning + safety checker + CLIP | 10.56 GB allocated / 11.28 GB reserved; 11.75 GB process | 8–12 GB ✓ |
| Cut-outs | rembg (CPU) | 0.02 GB | — |
| Ready / trip | nothing | 0.53 GB CUDA context of the back-end process | renderer only |

- **Performance sanity** (scrub, 1920×1080 headless Chromium on the RTX 4090, `window.__hyperspace.renderStats` every 0.5 s for 30 s): v 9 (breakthrough placeholder latched), v 7.7 (waiting room + chrysanthemum fading, seeds 11 mandelbox and 5 KIFS), v 6 (room + form constants + chrysanthemum): median frame interval 16.67 ms, p90 16.67 ms, 60 fps, render scale 1.0 throughout (frame interval is vsync-bound; it is not a GPU-time measurement). Not the final perf gate.

## M4–M8 visual review (integration agent, 2026-10-10)

Judged against BUILD.md §16.4 and docs/VISUAL_DIRECTION.md §4. Before this pass the gallery was drab (mid-grey violet plateaus, pastel tiles, grey fog); fixes are D-I9 in NOTES.md. Images in `verification/gallery/<layer>/`.
- **Room — pass (§16.4), partial on the visual bar.** `room/room_v1_s11.png`, `room_v1_s23.png`: the procedural room is recognisable and calm. `room_v3_s11.png`, `room_v5_s23.png`, `room_v9_s23.png`: breathing/drift, wallpaper folding patches, palette tint and the faint neural-field modulation on the walls (rings for s11, a dot lattice for s23) — "alive, patterned surfaces", but hazy around the bright window at v ≥ 5. `room_v5_s11_eyes.png`, `room_v9_s11_challenge.png`: dark luminous phosphene rings (mean luminance ≤ 0.13), no longer a safety fail. **Fix still needed (not mine to make):** a PHOTO room on screen shows the SafetyLimiter guard's grey blotches (`verification/tmp/integrate/rp/p1.png` vs `p1_pre.png`; D-I10).
- **Form constants — pass.** `form_constants/tunnels_seed7_v{5,9}.png`, `funnels_seed11_v7.5.png`, `spirals_seed12_v9.png`, `lattices_seed13_v{5,9}.png`, `form_constants_v{5,7.5,9}_s11.png`, `form_constants_v{5,9}_s23.png`: all four classes clearly present; bands now read as lit tubes with bright crests and dark troughs, soft edges, no black/white stripes. Words: "glowing, tubular, clean"; still somewhat flat in the troughs for the violet palette and v 5–9 look alike (gain cap, D-NF2). `form_constants_v9_s11_challenge.png`: colder magenta/green, narrower tunnel, not brighter.
- **Chrysanthemum — pass.** `chrysanthemum/chrysanthemum_v{5,7.5,9}_s11.png`, `chrysanthemum_v{5,9}_s23.png`: hyperbolic tiling clearly shrinking toward the rim, flower cells with luminous rims, Kleinian pearl chains and lace ring at v ≥ 7.5, dark surround instead of the grey veil. Words: "jewelled, intricate"; a few tiles remain greyish where palette colours mix. `chrysanthemum_v9_s23_challenge.png`: harsh magenta lace on dark green — tight and cold, not brighter.
- **Waiting room — pass (§16.4), partial on the visual bar.** `waiting_room/waiting_room_v{7.5,9}_s23.png`, `waiting_room_v{5,9}_s11.png`: an endless lattice of ornate fractal blocks around crossing halls, now seen obliquely in perspective, with emissive edges that brighten with intensity; no banding or step artefacts. Words: "enclosing, ornate, deep" — but still a violet/blue-dominated haze for these palettes rather than "luminous, jewelled". KIFS kind (`verification/tmp/integrate/wr/wk.png`, seed 5): octagonal hall receding to infinity, multi-hued.
- **Breakthrough — not reviewed: still the M3 placeholder glow** (`breakthrough/breakthrough_v9_s11.png`); M9. Generated assets themselves were reviewed by the assets agent (RESULTS "Assets").
- **Overall:** the layers are coupled (the neural field shows on the room, the chrysanthemum centre tile and the waiting-room walls; one pulse drives all), palettes are coherent; real-session frames `sessions/2026-10-10_2222/frames/layer_enter_*.png` show the sequence room → form constants → chrysanthemum → waiting room → placeholder.

## Guard periodicity (guard agent, S8, 2026-10-11)

The SafetyLimiter's always-on pattern guard now counts and compresses only periodic high-contrast area (NOTES.md S8). Own stack: back end 8775, Vite (no HMR) 5178, headed Chrome on DISPLAY=:1, 1280×720, RTX 4090 (GPU at 210–780 MHz during the probes: it does not boost for this light load).

Commands and results:
- `cd frontend && npx tsc --noEmit`: clean. `npx vitest run`: **219 passed** (11 files; `tests/periodicity.test.ts` 40, protected `safetyLimiter.test.ts` 19 and `pipeline.test.ts` 7 unchanged and green).
- `E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test safety-limiter safety-guard`: **13 passed** (then the guard spec again with 2 adversarial cases added: **10 passed**). Protected cases (flashcheck, 5 s real time): bw10 general max 1.0/s, red8 0.5 general / 1.0 red, stripes 1.5/s with max periodic contrast 0.421 and 0 pattern frames (guard on from frame 1), bw10-debug 1.5/s, static control 0 engagements.
- `WORSTCASE_LAYERS=form_constants,chrysanthemum WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5178 scripts/worstcase_flash.sh`: **2 passed** — form_constants 0.5 flashes/s, 0 pattern frames (max periodic contrast 0.458, area 0); chrysanthemum 0.5/s, 0 (0.459, 0); limiter engaged 0×.

`tests/e2e/safety-guard.spec.ts` (captures in `verification/captures/guard-<name>/`; static patterns at Michelson 0.9 = luminance 0.05/0.95; p = per-tile periodicity score on the GPU, min/median/max over the 2304 tiles):

| Pattern | p min / median / max | periodic tiles | counted (frame 2) | guard frames 1–2 | flashcheck pattern frames (max block contrast) |
|---|---|---|---|---|---|
| rings, 30 px | 0.58 / 0.98 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (0.406) |
| hex lattice, 24 px | 0.99 / 1.00 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (0.395) |
| 45° stripes, 12 px | 0.98 / 1.00 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (0.425; 0.537 and 147 pattern frames before the exact-mean fix) |
| checker, 16 px | 1.00 / 1.00 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (0.400) |
| stripes, 80 px | 1.00 / 1.00 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (0.441) |
| 2-px lines every 40 px | 1.00 / 1.00 / 1.00 | 1.000 | 1.000 | 1, 1 | 0 (not periodic for flashcheck) |
| 36-spoke sunburst (custom) | — | 0.793 | 0.875 | 1, 1 | 0 (0.437; 12/32 blocks over 0.5 before hole filling) |
| rings, 90 px (custom) | — | 0.997 | 1.000 | 1, 1 | 0 (0.421; 0.549 periodic with 4 directions, 75 % blocks bad) |
| **photo** (sample room, full width, top-aligned) | 0 / 0.03 / 0.77 | 0.012 | 0.066 | **0 for 5 s** | 0 (flashcheck itself: 6/32 blocks "periodic", 0.98) |
| **blobs** (40 blooms + 4 filaments on 0.05) | 0 / 0 / 0.70 | 0.048 | 0.072 | **0 for 5 s** | 0 |

Every case: 0 red flashes, general flashes ≤ 0.5/s (the single black → pattern step at navigation). **Pre- vs post-limiter frames** (`capturePre()` / `capturePost()`, saved as `verification/captures/guard-{photo,blobs}/{pre,post}limiter.png`): max |difference| **0** in 8-bit sRGB for both — the limiter now passes aperiodic content through untouched (before S8 the same photo had `highContrastFraction` 0.98 and showed the guard's grey blotches, D-I10).

Adversarial probe (`verification/tmp/guard/adv.sh`, single post-limiter frames through flashcheck's block criterion; pre → post blocks over 0.5): 2-px stripes 1.00 → 0, 4-px checker 1.00 → 0, 120-px stripes and 160-px stripes guard on (periodic 1.0), rings 120 px 0.375 → 0, 30° and 67.5° gratings 1.00 → 0, stripes drifting at 1 Hz 1.00 → 0, dark stripes 0.01/0.06 1.00 → 0, magenta-on-black 45° stripes 1.00 → 0, 3-turn spiral 1.00 → 0; 30 %-area patches of every pattern → 0; 26 %-area patches ≤ 8/32 blocks (not a violation; 1–8 edge blocks at 0.50–0.62). Aperiodic: sparse stars periodic 0.029 / counted 0.092, integer-hash white noise 0.016 / 0.099 — guard off. A sin()-hash "noise" is lattice-periodic and is flagged (guard on; safe direction).

Product layers (scrub, seed 11, 20 samples over 2 s; "contrast-only" = what S3 counted before S8, guard engaged above 0.2): room v1 0.58 → counted **0.00**, room v3 0.28 → 0.01, form constants v5/7.5/9 0.04–0.06 → 0.02–0.04 (41 % of tiles periodic, contrast capped at source), chrysanthemum v5–9 ≤ 0.06 → ≤ 0.005, waiting room v7.5/9 0.13–0.17 → ≤ 0.004, breakthrough v9 0 → 0. Guard off on all of them, so what remains muted in those frames (violet-washed waiting room, flat mauve breakthrough placeholder, pastel form-constant bands; `verification/tmp/guard/layers_sheet.png`) is at the source, not the limiter.

**Cost** (`window.__limiter.timeAnalysis(300)`: per-frame analysis latency incl. the synchronising readback, mean of 300, GPU at idle clocks): before S8 (tile + stats) 0.10–0.14 ms; with S8 (tile + luminance pyramid + stats + periodicity + reduce) **0.40–0.53 ms**, i.e. +0.3–0.4 ms per frame (the first, looped GPU port took 1.3–2.3 ms and was rewritten fully unrolled). Shader compile: ~2 s on a cold Chrome shader cache (first page load only), otherwise ~0.5 s for all limiter shaders.

## Guard S8b: stripe-aware pattern guard (guard-fix agent, 2026-10-11)

Fixes the S8 evasions found by adversarial review (NOTES.md S8b). Own stack: back end 8775 (`HYPERSPACE_SESSIONS_DIR=verification/tmp/guard-fix/sessions`, templates + procedural), Vite (no HMR) 5178 with `HYPERSPACE_API=http://127.0.0.1:8775`, headed Chrome on DISPLAY=:1, 1280×720, RTX 4090.

Commands and results:
- `cd frontend && npx tsc --noEmit`: clean. `npx vitest run`: **230 passed** (11 files; `tests/periodicity.test.ts` 51 = 40 S8 + 11 S8b: transition counting, chirp profile, central-window clamping, tensor orientation, pixel stripes on zone plates k 0.0002–0.0006 / red-only / corner-centred / zone-plate lattice / FM bars 0°, 11.25°, 90° / bar code / Poincaré rings, none on blooms + filaments, white noise, dense dots, a vignette; grid stripes on the 4-ring zone plate, none on 200-px stripes or a vignette; `dilateMask`). Protected `safetyLimiter.test.ts` 19 and `pipeline.test.ts` 7 unchanged and green.
- `E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test safety-limiter safety-guard --workers=1`: **58 passed** (8.6 min): the 5 protected safety-limiter cases (bw10-debug 1.5 general flashes/s, static control no engagement), the 8 S8 periodic cases, **43 new S8b evasion cases** and photo / blobs (pre vs post max |diff| **0** for both).
- `WORSTCASE_LAYERS=form_constants WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5178 scripts/worstcase_flash.sh`: **1 passed** — 21.4 s of trip, limiter engaged 0×, general 0.5 flashes/s, 0 pattern frames (max periodic contrast 0.458, area 0).
- Single-frame screen of all 205 adversarial / control cases (`verification/tmp/guard-fix/probe.mjs` + flashcheck's block criterion on the post-limiter frame; S8 → S8b): every case that had more than 25 % bad blocks after the limiter now has ≤ 25 %, except four aperiodic controls (below). Real-time 5-s captures of 55 cases with `verification/tmp/guard-fix/run.ts`: all evasions guard on from the first frame, never off, flashcheck exit 0 with 0 pattern frames.

S8b evasion cases in `tests/e2e/safety-guard.spec.ts` (5 s real time at 30 fps, 6 s for the alternating case; captures in `verification/captures/guard-<name>/`; "S8" = the S8 limiter on a single frame at ~0.6 s: guard, counted fraction, fraction of flashcheck blocks over 0.5 after the limiter):

| Case | S8 (single frame): guard / counted / post blocks > 0.5 | S8b counted (stripe, periodic) frame 2 | guard frames 1–2 | flashcheck 5 s: pattern frames (max periodic contrast) | flashes general / red |
|---|---|---|---|---|---|
| zone_k0.0003 | 0 / 0 / 1.000 | 0.999 (0.929, 0.000) | 1, 1 | 0 (0.389) | 0.5 / 0.0 |
| zone_k0.0002 | 0 / 0 / 0.875 | 0.996 (0.918, 0.000) | 1, 1 | 0 (0.379) | 0.5 / 0.0 |
| zone_k0.0004 | 0 / 0 / 1.000 | 1.000 (0.965, 0.000) | 1, 1 | 0 (0.396) | 0.5 / 0.0 |
| zone_k0.0006 | 1 / 0.359 / 0.750 | 1.000 (0.986, 0.316) | 1, 1 | 0 (0.400) | 0.5 / 0.0 |
| zonesq_k0.0003 | 0 / 0.095 / 1.000 | 1.000 (0.977, 0.012) | 1, 1 | 0 (0.389) | 0.5 / 0.0 |
| zone_ellip | 0 / 0.109 / 1.000 | 1.000 (0.976, 0.045) | 1, 1 | 0 (0.400) | 0.5 / 0.0 |
| zone_k0.0003_magenta_dark | 0 / 0 / 1.000 | 0.999 (0.929, 0.000) | 1, 1 | 0 (0.391) | 0.5 / 0.0 |
| zone_k0.0003_thin | 0 / 0.076 / 1.000 | 1.000 (0.925, 0.010) | 1, 1 | 0 (0.394) | 0.5 / 0.0 |
| zone_k0.0003_red | 0 / 0.095 / 1.000 | 1.000 (0.977, 0.012) | 1, 1 | 0 (0.390) | 0.5 / 0.5 |
| zone_offcentre | 1 / 0.201 / 0.906 | 0.980 (0.972, 0.155) | 1, 1 | 0 (0.400) | 0.5 / 0.0 |
| zoneplate | 1 / 0.359 / 0.750 | 0.995 (0.853, 0.000) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| zp_fast | 0 / 0.016 / 1.000 | 1.000 (0.962, 0.002) | 1, 1 | 0 (0.396) | 0.5 / 0.0 |
| zp_slow | 0 / 0 / 0.750 | 0.978 (0.839, 0.000) | 1, 1 | 0 (0.374) | 0.5 / 0.0 |
| zp_vslow | 0 / 0 / 0.250 | 0.927 (0.736, 0.000) | 1, 1 | 0 (0.273) | 0.5 / 0.0 |
| zp_square | 0 / 0.071 / 0.875 | 0.984 (0.977, 0.009) | 1, 1 | 0 (0.379) | 0.5 / 0.0 |
| zone_k0.0003_disc30 | 0 / 0.016 / 0.375 | 0.362 (0.234, 0.002) | 1, 1 | 0 (0.000) | 0.5 / 0.0 |
| zone_k0.0003_area30 | 0 / 0 / 0.250 | 0.269 (0.188, 0.000) | 1, 1 | 0 (0.245) | 0.5 / 0.0 |
| zone_k0.0003_corner30 | 0 / 0.06 / 0.250 | 0.351 (0.318, 0.093) | 1, 1 | 0 (0.477) | 0.5 / 0.0 |
| zp_area30 | 0 / 0 / 0.250 | 0.314 (0.236, 0.000) | 1, 1 | 0 (0.281) | 0.5 / 0.0 |
| zonelattice_640x360 | 0 / 0 / 1.000 | 1.000 (0.898, 0.000) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| zonelattice_427x360 | 0 / 0.063 / 1.000 | 1.000 (0.910, 0.010) | 1, 1 | 0 (0.379) | 0.5 / 0.0 |
| fmsq_L480_T24_d0.025_a0 | 0 / 0.188 / 1.000 | 1.000 (1.000, 0.125) | 1, 1 | 0 (0.343) | 0.5 / 0.0 |
| fmsq_L480_T24_d0.03_a0 | 0 / 0.188 / 1.000 | 1.000 (1.000, 0.125) | 1, 1 | 0 (0.366) | 0.5 / 0.0 |
| fmsq_L480_T24_d0.025_a90 | 0 / 0.167 / 1.000 | 1.000 (1.000, 0.111) | 1, 1 | 0 (0.343) | 0.5 / 0.0 |
| fmsq_L480_T24_d0.025_a11.25 | 1 / 0.505 / 0.812 | 1.000 (1.000, 0.348) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| fmsq_L640_T32_d0.02_a0 | 1 / 0.313 / 1.000 | 1.000 (1.000, 0.250) | 1, 1 | 0 (0.365) | 0.5 / 0.0 |
| fmsq_L480_T24_d0.03_a80 | 1 / 0.354 / 0.938 | 1.000 (1.000, 0.269) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| fmsq_L600_T30_d0.022_a30 | 1 / 0.503 / 0.688 | 1.000 (0.998, 0.413) | 1, 1 | 0 (0.389) | 0.5 / 0.0 |
| saw_L400_a0 | 1 / 0.563 / 0.750 | 1.000 (1.000, 0.469) | 1, 1 | 0 (0.362) | 0.5 / 0.0 |
| am_c13_e300_a30 | 1 / 1 / 0.531 | 1.000 (0.650, 1.000) | 1, 1 | 0 (0.000) | 0.5 / 0.0 |
| sq25_slowsine | 1 / 0.678 / 0.500 | 0.678 (0.000, 1.000) | 1, 1 | 0 (0.269) | 0.5 / 0.0 |
| grad_radial_sq13 | 1 / 1 / 0.750 | 1.000 (0.987, 1.000) | 1, 1 | 0 (0.306) | 0.5 / 0.0 |
| ringblk_h | 1 / 0.681 / 0.500 | 0.681 (0.653, 0.872) | 1, 1 | 0 (0.200) | 0.5 / 0.0 |
| ring30_thick | 1 / 0.639 / 0.500 | 0.639 (0.572, 0.841) | 1, 1 | 0 (0.000) | 0.5 / 0.0 |
| poincare_rings | 0 / 0.075 / 0.375 | 0.581 (0.516, 0.023) | 1, 1 | 0 (0.310) | 0.5 / 0.0 |
| persp_floor | 1 / 0.444 / 0.500 | 0.780 (0.650, 0.215) | 1, 1 | 0 (0.368) | 0.5 / 0.0 |
| blue060 | 0 / 0 / 1.000 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.000) | 0.0 / 0.0 |
| darkgrey | 0 / 0 / 1.000 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.000) | 0.0 / 0.0 |
| fp_randbars | 0 / 0.063 / 0.750 | 1.000 (1.000, 0.031) | 1, 1 | 0 (0.315) | 0.5 / 0.0 |
| zp_drift1hz | 0 / 0 / 0.875 | 0.986 (0.894, 0.000) | 1, 1 | 0 (0.379) | 1.5 / 0.0 |
| darkgrey_drift | 0 / 0 / 1.000 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.000) | 0.0 / 0.0 |
| zp_alt_stripes12 | 0 / 0 / 0.875 | 0.995 (0.853, 0.000) | 1, 1 | 0 (0.400) | 1.0 / 0.0 |
| zp_scale05 | 0 / 0.016 / 0.875 | 0.995 (0.853, 0.000) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |

Aperiodic controls (single frame, counted fraction; the guard engages above 0.2): sample photo top crop 0.077, centre crop 0.108, 2× zoom 0.043, at render scale 0.5 0.089; blobs 0.072, at render scale 0.5 0.105; fbm 0.028 / fbm drifting 0.056; dense stars 0.063; rotating stars 0.104; Worley edges 0.189 — guard off on all. Now ON (new false positives): random lines 0.55, Voronoi edges 0.37, tree-branch noise 0.34; fbm fine 0.201 (just on); still on as under S8: turbulence filaments, Worley cells, marble, quasicrystal. flashcheck's own verdict on the post-limiter frame still fails for the centre-crop photo (0.375 of blocks) and its 2× zoom (0.31), both with the guard off and the frame untouched (flashcheck calls the bookshelves periodic), and for tree-branch noise (0.344, guard on) and Worley cells (0.281, guard on; 0.438 under S8).

Looked at (post-limiter capture frames, `verification/tmp/guard-fix/sheet_caps_r1.png`, `sheet_spec.png`): zone plates, zone lattice, FM and sawtooth trains, the bar code and the perspective floor come out as soft grey low-contrast rings / bars; amplitude-modulated stripes become their smooth envelope; stripes around a black centre are flattened next to the black with a soft dark halo; the 30 % disc zone plate is a soft grey disc whose surround is lifted to grey in tile-sized steps (ugly but harmless); the red-only zone plate becomes red / grey rings (luminance contrast compressed, chroma contrast remains); dark-magenta rings become magenta / lavender; saturated-blue stripes stay visibly blue on dark blue at low luminance contrast. Photo and blobs are bit-identical to the input.

Product layers (scrub, seed 11, 20 samples over 2 s; counted = what the guard counts, engaged above 0.2): room v1 0.000 (stripe 0.000), room v3 0.006, form constants v5 / 7.5 / 9 0.023–0.028 (max 0.041; stripe tiles 0.15, but capped at source below the 0.45 tile contrast), chrysanthemum v5–9 ≤ 0.006, waiting room v7.5 / 9 0.000, breakthrough v9 0.000. Guard off on all of them (`verification/tmp/guard-fix/layers_sheet.png`: unchanged from S8).

Cost (`window.__limiter.timeAnalysis(300)`, photo and rings, same session): S8 0.44–0.49 ms per frame, S8b **0.61–0.65 ms** (+0.15 ms: structure-tensor pass with mips, transition counting in the unrolled profile shader, the 9×9 guard-cf pass).

## Guard S8c: local-spectrum pattern guard, gamut-aware compression, global slew, sqrt readback (guard-fix agent, 2026-10-11)

Fixes the round-2 evasions of S8b (NOTES.md S8c). Own stack: back end 8775 (`HYPERSPACE_SESSIONS_DIR=verification/tmp/guard-fix/sessions`, templates + procedural), Vite (no HMR) 5178 with `HYPERSPACE_API=http://127.0.0.1:8775`, headed Chrome on DISPLAY=:1, 1280×720, RTX 4090.

Commands and results:
- `cd frontend && npx tsc --noEmit`: clean. `npx vitest run`: **238 passed** (11 files; `tests/periodicity.test.ts` 59 = 51 + 8 S8c: one grating / egg-crate / hex lattice put their energy in 1 / 2 / 3 peaks, flat and white-noise windows are not sparse, 1-cycle gratings are not candidates, window origins; at 1280×720: crossed chirps (sine, square, 24 and 28 px), a z² hex lattice, a log-polar plaid full screen and in a 30 % corner, three 48-px pairs in edge bands are spectral, blooms / 1/f value noise / white noise are not). Protected `safetyLimiter.test.ts` 19 and `pipeline.test.ts` 7 unchanged and green.
- `E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test safety-limiter safety-guard --workers=1`: **92 passed** (13.7 min): the 5 protected safety-limiter cases (bw10 1.5 general flashes/s, red8 1.0 general / 1.0 red, stripes 2.0 (fine detail; tile 1.5) with max periodic contrast 0.372 and 0 pattern frames, bw10-debug 1.5, static control no engagement), the 8 S8 periodic cases, the 43 S8b cases, **34 new S8c cases** and photo / blobs (pre vs post max |diff| **0** for both).
- `WORSTCASE_LAYERS=form_constants WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5178 scripts/worstcase_flash.sh`: **1 passed** — 21.4 s of trip, limiter engaged 0×, general 0.5 flashes/s, 0 pattern frames (max periodic contrast 0.457, area 0).
- Single-frame screen of the whole 498-case corpus (every attack-geometry-r2 / attack-dynamics-r2 case plus the 205 earlier adversarial and control cases; `verification/tmp/guard-fix/r2/probe2.mjs` + flashcheck's block criterion on the post-limiter frame, `r2/fc_r2b.txt`): 0 shader errors; **every case has ≤ 25 % bad blocks after the limiter** except the centre-crop photo (0.375) and its 2× zoom (0.312), both with the guard off and the frame untouched (flashcheck's own call on the bookshelves, as under S8b). S8b: 178 such failures. No control that was off under S8b is on under S8c; 49 pattern cases newly engage (all sw2 / bc / corner / band / quantisation cases).

S8c evasion cases in `tests/e2e/safety-guard.spec.ts` (5 s real time at 30 fps, 7 s for the legal fading pattern; captures in `verification/captures/guard-<name>/`; "S8b" = flashcheck pattern frames reported by the adversarial review; counted = what the guard counts on frame 2, with the stripe and spectral tile fractions):

| Case | S8b pattern frames (reported) | S8c counted frame 2 (stripe, spectral) | guard frames 1–2 | flashcheck 5 s: pattern frames (max periodic contrast) | flashes general / red |
|---|---|---|---|---|---|
| sw2_a190_p2.75_D1200_T24 | 150 | 1.000 (0.025, 1.000) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| sw2_a190_p3.0_D1300_T24 | 150 | 1.000 (0.013, 1.000) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| sw2_a210_p3.0_D1100_T28 | 150 | 0.918 (0.008, 0.918) | 1, 1 | 0 (0.808) | 0.5 / 0.0 |
| bc_red | 150 | 1.000 (0.025, 1.000) | 1, 1 | 0 (0.373) | 0.5 / 0.5 |
| bc_green_cc | 150 | 1.000 (0.025, 1.000) | 1, 1 | 0 (0.373) | 0.5 / 0.0 |
| bc_sq | 150 | 1.000 (0.045, 1.000) | 1, 1 | 0 (0.389) | 0.5 / 0.0 |
| bc_drift1hz | 29 | 1.000 (0.023, 1.000) | 1, 1 | 0 (0.372) | 1.0 / 0.0 |
| bc_corner30 | 0 (guard 0; 8/32 blocks) | 0.288 (0.000, 0.266) | 1, 1 | 0 (0.362) | 0.5 / 0.0 |
| trichirp_p4_D2200_T22 | 150 | 1.000 (0.054, 1.000) | 1, 1 | 0 (0.354) | 0.5 / 0.0 |
| bichirp_p4_D2200_T22_sq | 150 | 1.000 (0.019, 1.000) | 1, 1 | 0 (0.389) | 0.5 / 0.0 |
| z2hex_k0.0003 | 150 | 0.997 (0.039, 0.944) | 1, 1 | 0 (0.366) | 0.5 / 0.0 |
| zonehex_k0.0006 | 150 | 1.000 (0.016, 0.965) | 1, 1 | 0 (0.383) | 0.5 / 0.0 |
| logpolar_plaid_N100 | 150 | 1.000 (0.000, 0.944) | 1, 1 | 0 (0.372) | 0.5 / 0.0 |
| logpolar_plaid_N100_corner30 | 150 | 0.278 (0.000, 0.247) | 1, 1 | 0 (0.368) | 0.5 / 0.0 |
| logpolar_plaid_N72_corner30 | 150 | 0.272 (0.000, 0.253) | 1, 1 | 0 (0.355) | 0.5 / 0.0 |
| zone_grain0.3_c3 | 150 | 1.000 (0.533, 0.936) | 1, 1 | 0 (0.385) | 0.5 / 0.0 |
| N_bands_tb20_h48 | 143 | 0.389 (0.000, 0.389) | 1, 1 | 0 (0.0) | 0.5 / 0.0 |
| N_bands_tb15_h36 | 143 | 0.278 (0.000, 0.278) | 1, 1 | 0 (0.0) | 0.5 / 0.0 |
| N_bands_tb15_h36_grey | 144 | 0.278 (0.000, 0.278) | 1, 1 | 0 (0.0) | 0.5 / 0.0 |
| N_quant_dark0212 | 141 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.0) | 0.0 / 0.0 |
| N_white_blue20 | 135 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.399) | 0.5 / 0.0 |
| N_cyan_blue_diag12 | 143 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.379) | 0.5 / 0.0 |
| N_white_red20 | 141 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.4) | 0.5 / 0.0 |
| N_white_blue_sine_rings30 | 139 | 1.000 (0.995, 1.000) | 1, 1 | 0 (0.39) | 0.5 / 0.0 |
| N_white_blue_zoneplate | 144 | 1.000 (0.977, 0.938) | 1, 1 | 0 (0.39) | 0.5 / 0.0 |
| N_white_blue_meancap | 144 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.397) | 0.5 / 0.0 |
| N_violet_lilac_drift1 | 101 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.403) | 1.5 / 0.0 |
| N_white_blue_drift19 | 43 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.399) | 1.0 / 0.0 |
| N_flicker_then_black | 59 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.405) | 1.5 / 0.0 |
| N_flicker_then_dim | 57 | 1.000 (1.000, 1.000) | 1, 1 | 0 (0.404) | 1.5 / 0.0 |
| N_flickerzone_pattern_off | 75 | 0.719 (0.700, 0.658) | 1, 1 | 0 (0.751) | 1.0 / 0.0 |
| N_lowc_pattern_off_flicker | 62 | 0.078 (0.578, 0.656) | 0, 0 | 0 (1.0) | 1.0 / 0.0 |
| N_rings_fadeout_flicker | 36 | 0.688 (0.571, 0.688) | 1, 1 | 0 (0.398) | 1.5 / 0.0 |
| N_frame_alt_black | 17 | 1.000 (1.000, 1.000) | 0, 1 | 0 (0.416) | 1.5 / 0.0 |

N_lowc_pattern_off_flicker is a LEGAL pattern (Michelson 0.33): the guard correctly stays off; the S8b failure was the limiter's own fade. Its max periodic contrast 1.0 (4 of 32 blocks, never more) and N_flickerzone_pattern_off's 0.751 (4 blocks) are the blocks straddling the input's own edge between the low-passed flicker zone (grey) and the black / fading right side. N_frame_alt_black: frame 1 is black (guard 0); from frame 2 the guard is 1 on pattern frames and ~0.98 on the black ones (the spec asserts ≥ 0.9 on every later frame).

Looked at (post-limiter capture frames, `verification/tmp/guard-fix/r2/sheet_geo.png`, `sheet_dyn.png`): crossed chirps, the tri-chirp, the z² hex lattice and the log-polar plaid come out as soft light-grey low-contrast lattices; bc_red is red / dark-red egg-crate, bc_green_cc green / pink at nearly equal luminance; the 30 % corner patches are soft grey with the surrounding black lifted to grey in tile-sized steps (the S8b halo, ugly but harmless); the noisy zone plate is soft grey rings with grain; white/blue stripes, rings and zone plate are light grey / periwinkle (luminance contrast gone, chroma stays), violet/lilac lilac / pale violet; edge bands are smooth grey bands with a soft gradient into the black middle; the fading patterns (N_flicker_then_black frame 90, N_lowc frames 50 → 114) now fade as a whole, keeping their (compressed or legal) contrast instead of turning into black-and-grey stripes.

Aperiodic controls (single frame, counted; the guard engages above 0.2): sample photo top crop 0.134, centre crop 0.160, 2× zoom 0.131, render scale 0.5 0.149; blobs 0.074 (render scale 0.5 0.111); fbm 0.028, fbm drifting 0.065, dense stars 0.063, rotating stars 0.102, Worley edges 0.189 — guard off on all. On, as under S8b: fbm fine 0.228, random lines, Voronoi, tree branches, turbulence filaments, Worley cells, marble, quasicrystal, FP_grass / FP_rain / FP_starstreaks.

Product layers (scrub, seed 11, 20 samples over 2 s, `verification/tmp/guard-fix/r2/probe_layers2.mjs`): room v1 counted 0.084 (spectral 0.094; S8b 0.000), room v3 0.019, form constants v5 / 7.5 / 9 0.069–0.076 (max 0.095; 41 % periodic, contrast capped at source), chrysanthemum v5–9 ≤ 0.006 (max 0.020), waiting room v7.5 / 9 0.001, breakthrough v9 0.000 — guard off on all.

Cost (`window.__limiter.timeAnalysis(300)`, photo and rings, same session, idle GPU clocks): S8b 0.61–0.65 ms, S8c **0.85–0.90 ms** per frame (+0.25 ms). The first S8c port (one fragment per window running the greedy peak search) measured 1.9 ms; packing 2×2 bins per texel, rotation twiddles and splitting the search into strip / pick passes brought it down.

## Form constants polish (polish-form_constants-r1, 2026-10-11)

Gallery `GALLERY_LAYERS=form_constants scripts/gallery.sh` against my stack (back end 8772, Vite no-HMR 5175): **12/12 frames pass** (pattern ratios s11 v3–v9 7203 / 2918 / 201 / 44, challenge 203; s23 146 / 122 / 104 / 93, challenge 132). Worst case `WORSTCASE_LAYERS=form_constants WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0`: **PASS** — 21.4 s of trip, limiter engaged 0×, general/red flashes 0.0/s, pattern frames 0 (max area 0.094, i.e. 3 of 32 blocks near the centre), motion windows 0, max mean luminance 0.051. `npx vitest run tests/neuralField.test.ts` 12/12, `npx tsc --noEmit` clean. Frame cost: renderScale 1.0, frameMs 16.67 (vsync) on all 12 frames.

Measurements (linear luminance from the sRGB PNGs; S = HSV saturation of the brighter half):

| frame | p5 | median | p95 | mean | S (bright half) | honest words |
|---|---|---|---|---|---|---|
| v5_s11 (rings, neon) | 0.031 | 0.039 | 0.064 | 0.044 | 0.83 | saturated, neon, dim |
| v7.5_s11 | 0.030 | 0.041 | 0.066 | 0.045 | 0.90 | neon, deep, saturated |
| v9_s11 | 0.031 | 0.046 | 0.074 | 0.050 | 0.95 | electric, intricate, deep |
| v9_s11_challenge | 0.030 | 0.048 | 0.072 | 0.050 | 0.95 | acidic, harsh, busy |
| v5_s23 (lattice, lunar) | 0.031 | 0.034 | 0.063 | 0.040 | 0.75 | cool, cellular, dim |
| v7.5_s23 | 0.030 | 0.034 | 0.065 | 0.040 | 0.82 | jewelled, cellular, cool |
| v9_s23 | 0.031 | 0.036 | 0.073 | 0.043 | 0.87 | jewelled, intricate, cellular |
| v9_s23_challenge | 0.031 | 0.034 | 0.073 | 0.043 | 0.80 | acid, staring, harsh |

Targets: p5 ≤ 0.05 met (0.030–0.031); median 0.05–0.2 NOT met (0.034–0.048, just under); p95 ≥ 0.3 NOT met (0.063–0.074; see NOTES D-P-form_constants-1/limits: a full-screen periodic pattern held under the guard's 0.45 tile test cannot carry 5 % bright area without engaging it); saturation ≥ 0.5 met (0.75–0.95). Compared with the pre-polish frames (grey-blue discs on a flat blue-grey plateau, pastel, v5 ≈ v9): dark valleys, saturated tubes, filaments and filigree, glints, intensity visibly changes detail and chroma. The review bar words "luminous, jewelled, deep, alive, intricate" fit v9 and the lattices partly; v5 frames are still "dim", and the base reads as dark slate, not near-black.

## Room polish (polish-room-r1, 2026-10-11)

Stack: back end 8771, Vite no-HMR 5174, sessions `verification/tmp/polish-room-r1/sessions`. Gallery `GALLERY_LAYERS=room scripts/gallery.sh`: **16/16 frames pass** (final run; an intermediate run failed `blank` on `room_v3_s23_eyes` and `room_v9_s23_challenge`, fixed at source by colour regions, see NOTES D-P-room-5). Worst case `WORSTCASE_LAYERS=room WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0`: **PASS** — general 0.0/s, red 0.0/s, pattern frames 0 (max area 0.062, max periodic contrast 0.736), motion windows 0, max mean luminance 0.069, limiter engaged 0×. vitest `tests/room.test.ts` 23/23, `npx tsc --noEmit` clean.

Measurements (linear luminance from the sRGB PNGs; S = HSV saturation of the brighter half of the pixels):

| frame | p5 | median | p95 | mean | S | honest words |
|---|---|---|---|---|---|---|
| v5_s11 (neon) | 0.014 | 0.054 | 0.409 | 0.104 | 0.54 | vivid, neon, glowing (islands blobby) |
| v7.5_s11 | 0.013 | 0.049 | 0.422 | 0.104 | 0.57 | deep, glowing, neon |
| v9_s11 | 0.013 | 0.050 | 0.423 | 0.105 | 0.57 | luminous window, deep, psychedelic |
| v5_s23 (lunar) | 0.013 | 0.057 | 0.415 | 0.106 | 0.66 | cool, sapphire, moody |
| v7.5_s23 | 0.013 | 0.053 | 0.419 | 0.106 | 0.67 | sapphire, deep, glowing edges (window pale) |
| v9_s23 | 0.013 | 0.054 | 0.419 | 0.106 | 0.66 | deep, cool, jewel-toned |
| v3_s11_eyes | 0.021 | 0.024 | 0.030 | 0.025 | 0.76 | velvety, deep, starlit |
| v5_s11_eyes | 0.021 | 0.024 | 0.032 | 0.025 | 0.76 | deep, starlit, velvety (lace dim) |
| v3_s23_eyes | 0.021 | 0.022 | 0.030 | 0.024 | 0.69 | sapphire-garnet, starlit, soft |
| v5_s23_eyes | 0.021 | 0.022 | 0.032 | 0.024 | 0.69 | jewel-toned, starlit, intricate centre |
| v9_s11_challenge | 0.016 | 0.019 | 0.026 | 0.020 | 0.72 | cold, dark, tight |
| v9_s23_challenge | 0.016 | 0.019 | 0.023 | 0.019 | 0.69 | dark, crowded, ominous |

Targets on the v 7.5 frames: p5 ≤ 0.05 met (0.013); median 0.05–0.2 met on s23 (0.053), borderline on s11 (0.049); p95 ≥ 0.3 met (0.42); S ≥ 0.5 met (0.57 / 0.67). Before this pass (`verification/gallery_before_polish/room/`, gallery of 2026-10-10): pink-white haze over the whole room, pastel, flat; eyes-closed field grey-blue blurred dots on a slate ground.

Photo room (sample `assets/sample/room.jpg` + depth, `verification/tmp/polish-room-r1/shoot.mjs photo`, post-limiter canvas, seed 11; `verification/tmp/polish-room-r1/photo_final/`): guard never engaged (counted 0.145 / 0.142 / 0.063 / 0.064 at v 1 / 3 / 5 / 7.5; pre- vs post-limiter difference only from animation between the two grabs). v 1 "the room itself, natural, calm" (no blotches); v 3 "vivid, warm, a little hazy around the window" (median 0.071, S 0.45); v 5 "saturated, psychedelic, neon-tinged, still the room" (p5 0.009, median 0.064, p95 0.38, S 0.55); v 7.5 "magenta, glowing window, dreamlike" (S 0.56). Eyes closed on the photo session: "deep violet, starlit", but the neural-field overlay's bright centre rings show there (Integration notes).

Frame cost: room layer 1.3–1.8 ms GPU at 1280×720 (v 5/9, eyes open/closed); gallery sidecars renderScale 1.0, frameMs 16.66–16.68 (vsync-bound) on every frame.

## Chrysanthemum polish (polish-chrysanthemum-r1, 2026-10-11)

Gallery (`GALLERY_LAYERS=chrysanthemum … scripts/gallery.sh`, Vite 5176 / back end 8773, post-limiter canvas): **12/12 frames pass** (blank, white, pattern, palette, stuck); pattern scores 8.3–35.6 (radial harmonic 17–18 = the 18-petal outline). Palettes: s11 = neon, s23 = lunar. Every frame renderScale 1.0, frameMs 16.66–16.67 (vsync-bound).

Review words (looked at each PNG; before = `verification/gallery_before_polish/chrysanthemum/`, "dusty mauve/teal kaleidoscope under a grey-violet haze, muddy, the lace dim orange on grey"):
| frame | words | weak spot |
|---|---|---|
| v5_s11 | luminous, jewelled, kaleidoscopic | central cell carries the neural field's concentric pink "target" rings; pink/violet dominate, teal only as accents |
| v5_s23 | luminous, sapphire-deep, crystalline | lace ring dim at v 5 (by design, lace fades in 5 → 8.5) |
| v7.5_s11 | luminous, jewelled, ornate | glowing outline "aura" with small bulbs at a few petal tips |
| v7.5_s23 | deep, luminous, crystalline | Poincaré shrinkage only ~2 rings deep in a still (cells are large (5,4,2) polygons) |
| v9_s11 | luminous, jewelled, ornate | little visible difference from v 7.5 in a still |
| v9_s23 | deep, luminous, crystalline | as v 7.5 |
| v9_s11_challenge | cold, intricate, veined | outer half of the petals soft (detail dissolves to dust under the faster flow): slightly murky there |
| v9_s23_challenge | jewelled, intricate, cold | petal tips soft dust; centre (rings of small cells) is the best shrinkage view of the set |
Also looked at v1/v3 (both seeds): luminous, kaleidoscopic; worst-case capture frames 100/250/400/600: four different groups, one mid-melt, all luminous and intricate.

Measurements (`verification/tmp/polish-chrysanthemum-r1/measure.py`, linear luminance; S = HSV saturation of the brighter half):
| frame | p5 | median | p95 | S bright half |
|---|---|---|---|---|
| v5_s11 | 0.006 | 0.025 | 0.174 | 0.67 |
| v5_s23 | 0.006 | 0.025 | 0.128 | 0.72 |
| v7.5_s11 | 0.007 | 0.044 | 0.204 | 0.64 |
| v7.5_s23 | 0.006 | 0.039 | 0.164 | 0.73 |
| v9_s11 | 0.007 | 0.044 | 0.210 | 0.64 |
| v9_s23 | 0.006 | 0.040 | 0.170 | 0.73 |
| v9_s11_challenge | 0.004 | 0.035 | 0.231 | 0.65 |
| v9_s23_challenge | 0.005 | 0.027 | 0.190 | 0.73 |
Before (v7.5_s23): p5 0.016, median 0.073, p95 0.117, S 0.57 (a 0.07–0.12 plateau). Targets: p5 ≤ 0.05 met; S ≥ 0.5 met; **median 0.05–0.2 not met (0.025–0.044) and p95 ≥ 0.3 not met (0.13–0.23)** — the dark base is 0.007–0.016 and the bright accents are thin. A brighter variant (cores 0.30 / bands 0.107 / base 0.024, iteration zb) reached median 0.031–0.051, p95 0.14–0.24, but turned the lunar base into a royal-blue plateau and raised the guard count to 0.175; reverted.

Limiter pattern guard on the final frames (`pipeline.limiter.status`, max of 4 samples over 1 s): highContrastFraction v5_s11 0.059, v7.5_s23 0.107, v9_s11_challenge 0.108, v9_s23_challenge 0.165 (engages at 0.2; never engaged in the captures). Before this pass's per-cell variation and lace change the same frames counted 0.13–0.68 (guard engaged under the challenge, visible grey blotches).

Worst case (`WORSTCASE_LAYERS=chrysanthemum WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 … scripts/worstcase_flash.sh`, headed Chrome, real time): **PASS** — 690 frames at 30 fps (23.0 s), general flashes max 0.5/s (limit 3), red 0, pattern frames 0 (max periodic area 0.062, max periodic contrast 0.906), motion windows 0, max mean luminance 0.083, limiter engaged 0×.

Tests: `npx vitest run tests/hyperbolic.test.ts` 53 passed (37 before; +16: cell-centre tracking, jewel/dark-base/contrast palettes, 2 s crossfade); full `npx vitest run` 258 passed; `npx tsc --noEmit` clean.

## Waiting room polish (polish-waiting_room-r1, 2026-10-11)
Files: `frontend/src/layers/waitingRoom.ts`, `frontend/src/layers/glsl/waitingRoom.frag.glsl`, `frontend/tests/hyperbolic.test.ts` (+8 waiting-room tests). Decisions D-P-waiting_room-1…6 in NOTES.md.

Gallery (`GALLERY_LAYERS=waiting_room … scripts/gallery.sh` on Vite 5177 / back end 8774): **12/12 frames pass** (blank/white/palette/stuck). Both gallery seeds plan a **mandelbox** (11 neon, 23 lunar); kifs was reviewed from my own captures (`verification/tmp/polish-waiting_room/i36/`, seeds 11/23/12 forced to kifs).

Review words (looked at every frame):
| frame | words |
|---|---|
| v5_s11 (mandelbox, neon) | violet, glowing, intricate — lower-left floor block a large dim violet area (dark but plain) |
| v7.5_s11 | luminous, ornate, deep — violet-dominant, pink/cyan filigree visible but thin |
| v9_s11 | luminous, jewelled, deep — bright pink glow on the block edge, bloom reads as light |
| v9_s11_challenge | acid, cold, intricate — violet + acid-green filigree on dark, tighter |
| v5_s23 (mandelbox, lunar) | sapphire, glowing, intricate |
| v7.5_s23 | luminous, intricate, deep — engraved light-lines on lit blocks, black hall between |
| v9_s23 | luminous, jewelled, alive — blocks ablaze with cyan filigree and bloom, dark recesses |
| v9_s23_challenge | acid, harsh, deep — some mid-violet fill at the bottom-right (a little flat) |
| kifs v5/v7.5 (neon, own captures) | jewelled, kaleidoscopic, dark — violet nave with pink/cyan jewels and lantern windows |
| kifs v9 (lunar, seeds 23/12) | luminous, intricate, deep — beaded cyan filigree rings on a dark-blue lace, lit windows |
Honest limits: the mandelbox views are blue- or violet-dominant per palette (the second light colour shows only on the filigree); the near floor block in the seed-11 view is a big dark area; challenge frames lean on violet.

Measurements (linear luminance, PIL + numpy; satB = mean HSV S of the brighter half):
| frame | p5 | median | p95 | mean | satB |
|---|---|---|---|---|---|
| v5_s11 | 0.006 | 0.025 | 0.156 | 0.045 | 0.70 |
| v5_s23 | 0.008 | 0.047 | 0.237 | 0.071 | 0.83 |
| **v7.5_s11** | 0.008 | 0.030 | 0.215 | 0.060 | 0.67 |
| **v7.5_s23** | 0.010 | 0.062 | 0.349 | 0.101 | 0.77 |
| v9_s11 | 0.009 | 0.034 | 0.279 | 0.075 | 0.64 |
| v9_s23 | 0.011 | 0.075 | 0.448 | 0.127 | 0.72 |
| v9_s11_challenge | 0.011 | 0.045 | 0.305 | 0.085 | 0.53 |
| v9_s23_challenge | 0.011 | 0.037 | 0.253 | 0.074 | 0.56 |
| kifs v7.5 s11 (own) | 0.007 | 0.031 | 0.180 | 0.052 | 0.63 |
| kifs v9 s23 (own) | 0.010 | 0.032 | 0.190 | 0.053 | 0.70 |
Targets at v 7.5: p5 ≤ 0.05 ✓, median 0.05–0.2 ✓ on s23 (0.062) / just below on s11 (0.030), p95 ≥ 0.3 ✓ on s23 (0.349) / below on s11 (0.215) and on kifs (0.18), satB ≥ 0.5 ✓ everywhere. Before (D-I9 frames): v7.5_s23 p5 0.035, median 0.055, p95 0.106, satB 0.55 (a 3:1 plateau).

Limiter: guard never engaged in my monitored captures after the fixes (counted pattern fraction ≤ 0.19 over 6–10 s on all 6 base views + 4 kifs views; backstop 0 engagements).

Worst case (`WORSTCASE_LAYERS=waiting_room WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5177 … scripts/worstcase_flash.sh`, headed Chrome, real time): **PASS** — default seed 11 (mandelbox): general flashes max 0.5/s, red 0, **pattern frames 0** (max area 0.219), motion windows 0, max mean luminance 0.105, limiter engaged 0×. Also with `WORSTCASE_SEED=12` (kifs): PASS, pattern frames 0 (max area 0.188), mean ≤ 0.092. A 60-s run (seed 11) earlier in the session: PASS, pattern frames 0. (Before the kifs fixes, seed 12 failed with 5 pattern frames at area 0.281.)

Frame cost (layer alone, 1920×1080, 30 renders per batch, gl readback to sync, RTX 4090 after the clock ramp-up): mandelbox v9 2.7–3.0 ms (challenge 2.7), mandelbox v7.5 2.7–2.9 ms, kifs v9 1.5–1.6 ms; first batches from idle clocks 6–7 ms. Gallery `render_stats`: frameMs 16.66 (vsync), renderScale 1 on every frame.

Tests: `npx vitest run tests/hyperbolic.test.ts` 75 passed; `npx tsc --noEmit` clean.

## Form constants polish, round 2 (polish-form_constants-r2, 2026-10-11)
Gallery: `GALLERY_LAYERS=form_constants E2E_BASE_URL=http://127.0.0.1:5175 HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-form_constants-r2/sessions scripts/gallery.sh` → 12/12 frames pass (blank, white, pattern, palette, stuck), capture exit 0, checks exit 0. Frame cost (sidecar renderStats): 16.66 ms at render scale 1.0 on every frame (vsync-bound). The 16 class frames `{tunnels_seed7,funnels_seed11,spirals_seed12,lattices_seed13}_v{3,5,7.5,9}.png` were re-rendered from the trip canvas (no DOM overlays) with the polished shader (they had been byte-identical to gallery_before_polish, and lattices_seed13_v9 had "[ESC] EXIT" burned in).

Linear luminance per frame (p5 / median / p95 / max; mean HSV S of the brighter half):

| frame | p5 | median | p95 | max | sat (bright half) | words |
|---|---|---|---|---|---|---|
| v5_s11 (neon, tunnel) | 0.021 | 0.035 | 0.078 | 0.60 | 0.86 | deep, vivid, smooth (outer bands plain) |
| v5_s23 (lunar, lattice) | 0.026 | 0.039 | 0.083 | 0.58 | 0.86 | deep, jewelled, soft |
| **v7.5_s11** | 0.025 | 0.040 | 0.088 | 0.81 | 0.88 | luminous core, deep, neon |
| **v7.5_s23** | 0.028 | 0.042 | 0.109 | 0.74 | 0.87 | jewelled, deep, glowing |
| v9_s11 | 0.028 | 0.045 | 0.103 | 0.96 | 0.89 | luminous, deep, vivid |
| v9_s23 | 0.032 | 0.047 | 0.134 | 0.90 | 0.88 | jewelled, luminous core, deep (teal gaps a little flat) |
| v9_s11_challenge | 0.024 | 0.043 | 0.107 | 0.96 | 0.90 | acidic, harsh, deep |
| v9_s23_challenge | 0.025 | 0.046 | 0.147 | 1.00 | 0.92 | acidic, jewelled, tense |
| classes v9 (tunnel / funnel / spiral / lattice) | 0.020–0.025 | 0.042–0.045 | 0.10–0.14 | 0.92–1.0 | 0.85–0.90 | white-hot core in violet tubes / starburst / vortex / lit honeycomb |

Targets at v 7.5: p5 ≤ 0.05 ✓, median 0.05–0.2 ✗ (0.040–0.042, just below), p95 ≥ 0.3 ✗ (0.09–0.11), bright-half saturation ≥ 0.5 ✓ (0.87–0.88). Judge's targets: p05 0.01–0.03 ✓, median 0.06–0.10 ✗ (0.04–0.05), p95 ≥ 0.25 ✗, max ≈ 0.8 on filaments ✓ (0.74–1.0), bright-half saturation ≥ 0.6 ✓. p99 is 0.26–0.47: pixels at 0.25+ are confined to the bounded high-contrast core (NOTES D-P-form_constants-6/10: brighter annulus bodies force troughs ≥ 0.1 and a teal plateau; a larger core leaves flashcheck's central blocks). Progression v 5 → 7.5 → 9: the core grows (0.18 → 0.21) and goes from pink to white-hot (bodies 0.28 → 0.40, crests 0.50 → 0.85, bloom 0.25 → 0.55), the annulus bodies rise 0.085 → 0.11 with deeper chroma, more filigree and glints, faster drift; p99 0.30 → 0.39 → 0.47 (s11), max 0.60 → 0.81 → 0.96.

SafetyLimiter (pre-limiter frames, my captures, 12–16 samples over 3–4 s each): guard fraction 0.02–0.155 (engages at 0.2; highest: funnels v9 0.144–0.155, spirals v9 0.142–0.145, tunnels 0.11–0.14, lattices 0.02–0.06), never engaged, backstop 0 engagements. flashcheck per frame: at most 4/32 high-contrast periodic blocks (the core), limit > 8.

Worst case (`WORSTCASE_LAYERS=form_constants WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5175 HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-form_constants-r2/sessions scripts/worstcase_flash.sh`, v 9, difficult passage, sensitivity 2.0, real time): **PASS** — general flashes 0.0/s, red flashes 0.0/s, pattern frames 0 (max area 0.125, i.e. the four core blocks), motion windows 0, max mean luminance 0.067, limiter engaged 0×.

Tests: `npx vitest run tests/neuralField.test.ts` 14 passed (2 new: window-pair luminance bound of the annulus plan, bounded core + intensity ramps); full `npx vitest run` 287 passed; `npx tsc --noEmit` clean.

## Chrysanthemum polish r2 (polish-chrysanthemum-r2, 2026-10-11)

Own stack: back end 8773 (`HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-chrysanthemum-r2/sessions`, templates + procedural), Vite no-HMR 5176. Decisions: NOTES.md D-P-chrysanthemum-r2-1…9.

Commands and results:
- `cd frontend && npx tsc --noEmit`: clean. `npx vitest run tests/hyperbolic.test.ts`: 75 passed (+14 r2 cases in 6 blocks: vivid colours on all 5 palettes, hue family kept, hot magenta stays magenta / orange-red turns orange, accent colours, escalation, group zoom). Full `npx vitest run`: 287 passed (11 files).
- `GALLERY_LAYERS=chrysanthemum E2E_BASE_URL=http://127.0.0.1:5176 HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-chrysanthemum-r2/sessions scripts/gallery.sh`: **12/12 frames pass** (pattern scores 9.0–63.9; an earlier run failed v5_s11 pattern at 7.1 with unevenly spaced petals — fixed, D-r2-7).
- `WORSTCASE_LAYERS=chrysanthemum WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5176 HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-chrysanthemum-r2/sessions scripts/worstcase_flash.sh`: **PASS** — 690 frames at 30 fps (23.0 s), limiter engaged 0×, general flashes max 1.0/s (tile area 0.5, whole frame 0.5, fine detail 1.0; limit 3), red 0, pattern frames 0 (max area 0.094, max periodic contrast 0.939), motion windows 0, max mean luminance 0.14.
- Stale rejected frames: the eight `chrysanthemum_*_seed{11,22}*.png` (md5-identical to gallery_before_polish) removed from `verification/gallery/chrysanthemum/`.
- Limiter guard (my probe `verification/tmp/polish-chrysanthemum-r2/quick.mjs`, every frame for 3 s after the 2 s settle, scrub mode): counted fraction max 0.08–0.185 across v5/7.5/9 × s11/s23 × challenge, 0 frames over 0.2 (engages at 0.2). Intermediate iterations that engaged it (0.20–0.23, visible grey blocks) were rejected: band ratio 2.7, fold shading 0.7, no rim sinking.
- Frame cost: every gallery sidecar renderScale 1.0, frameMs 16.66–16.67 (vsync-bound); headless probe 17.4–19.8 ms with the nested tiling and the 3-sample lace density (no adaptive downscale).

Measurements (final gallery PNGs, linear luminance; S = mean HSV saturation of the brighter half; `verification/tmp/polish-chrysanthemum-r2/measure2.py`):

| frame | p5 | median | p95 | p99.9 | S bright half | frameMs / scale |
|---|---|---|---|---|---|---|
| v5_s11 | 0.007 | 0.041 | 0.327 | 0.74 | 0.67 | 16.67 / 1 |
| v7.5_s11 | 0.008 | 0.070 | 0.365 | 0.78 | 0.63 | 16.67 / 1 |
| v9_s11 | 0.008 | 0.079 | 0.393 | 0.80 | 0.60 | 16.67 / 1 |
| v9_s11_challenge | 0.005 | 0.069 | 0.327 | 0.85 | 0.60 | 16.66 / 1 |
| v5_s23 | 0.007 | 0.039 | 0.302 | 0.77 | 0.70 | 16.67 / 1 |
| v7.5_s23 | 0.007 | 0.067 | 0.352 | 0.79 | 0.68 | 16.67 / 1 |
| v9_s23 | 0.007 | 0.077 | 0.365 | 0.80 | 0.66 | 16.66 / 1 |
| v9_s23_challenge | 0.005 | 0.061 | 0.335 | 0.84 | 0.67 | 16.67 / 1 |

r1 (rejected): p95 0.128–0.231, p99.9 ~0.6–0.73, median 0.025–0.044. Targets on v7.5: p5 ≤ 0.05 met (0.007–0.008), median 0.05–0.2 met (0.067–0.070), p95 ≥ 0.3 met (0.352–0.365), S ≥ 0.5 met (0.63–0.68). v5 median 0.039–0.041 (lace still dim at v 5 by design). v1/v3 frames: p95 0.27–0.33, all pass.

Review words (looked at every PNG):
| frame | words | weak spot |
|---|---|---|
| v5_s11 | luminous, neon, jewelled | violet background inside the lace ring is a dark but flat violet; lace dim at v 5 (by design) |
| v7.5_s11 | luminous, jewelled, kaleidoscopic | large-celled group: only ~2 rings of shrinkage visible; little composition change from v 5 |
| v9_s11 | intricate, jewelled, luminous | escalation is the miniature rosettes in the cell cores + star seams + brighter crest: visible side by side with v 7.5, not dramatic |
| v9_s11_challenge | cold, electric, veined | mid-ring cells soft (calm/dust zone under the faster flow); harsh violet/aqua, not a warm colour anywhere (as intended) |
| v5_s23 | luminous, sapphire, jewelled | gold petals slightly ochre at the petal tips |
| v7.5_s23 | luminous, sapphire, jewelled | as v 5 with brighter lace; big cells |
| v9_s23 | jewelled, intricate, luminous | rosettes in the cell cores; the deepest view of the base frames |
| v9_s23_challenge | jewelled, intricate, deep | the best frame: rings of heptagons shrinking toward the rim, aqua spiral lace on navy |
Worst-case capture frames 201/351/501/621/681 (contact sheet `verification/tmp/polish-chrysanthemum-r2/worst_sheet.png`): (7,3,2) tilings, 4–5 rings of shrinking jewel cells in magenta, cyan, gold, green on violet — luminous, intricate, jewelled; one mid-melt frame reads as one tiling dissolving into the next.
None of the frames is pale, washed, foggy, flat, pastel, muddy or grey in my judgement; the honest reservation is the s11/s23 base stills landing on large-celled groups (a seed/time accident of the scheduler, see NOTES D-r2 limits).

## Room polish, round 2 (polish-room-r2, 2026-10-11)

Gallery `GALLERY_LAYERS=room scripts/gallery.sh` against my stack (back end 8771, Vite no-HMR 5174): 16/16 frames pass `gallery_checks.py`; render stats renderScale 1.0, frameMs 16.66–17.07 (vsync). `npx vitest run tests/room.test.ts` 28/28, `npx tsc --noEmit` clean. Worst case `WORSTCASE_LAYERS=room WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 scripts/worstcase_flash.sh`: PASS — 0 pattern frames (max pattern area 0.188, limit 0.25), general flashes ≤ 1.0/s (limit 3), red 0, limiter backstop engaged 0×, max mean luminance 0.133. Room layer GPU cost (1280×720, readPixels-synchronised loop): 1.52–1.67 ms eyes open, 2.16–2.43 ms eyes closed.

Linear luminance / saturation (PIL + numpy; satBH = mean HSV S of the brighter half):

| frame | p5 | median | p95 | satBH |
|---|---|---|---|---|
| room_v7.5_s11 | 0.008 | 0.048 | 0.473 | 0.82 |
| room_v7.5_s23 | 0.010 | 0.056 | 0.457 | 0.84 |
| room_v5_s11 / s23 | 0.009 / 0.011 | 0.052 / 0.059 | 0.452 / 0.450 | 0.78 / 0.87 |
| room_v9_s11 / s23 | 0.010 / 0.012 | 0.059 / 0.060 | 0.477 / 0.461 | 0.77 / 0.80 |
| room_v5_s11_eyes / s23_eyes | 0.014 / 0.014 | 0.032 / 0.030 | 0.305 / 0.277 (r1: 0.032) | 0.80 / 0.86 |
| room_v3_s11_eyes / s23_eyes | 0.014 / 0.014 | 0.024 / 0.024 | 0.184 / 0.194 | 0.82 / 0.88 |
| room_v9_s11_challenge / s23 | 0.006 / 0.006 | 0.008 / 0.009 | 0.328 / 0.279 (r1: 0.026 / 0.023) | 0.86 / 0.88 |

Progression: mean |v9 − v7.5| (linear RGB) 0.047 (s11) / 0.037 (s23), r1 0.026 / 0.017; p95 0.473 → 0.477 and the stills differ in structure (central tunnel + folding annulus at v 9, a small emerging tunnel at v 7.5).
SafetyLimiter guard (counted pattern ∧ high-contrast tiles, max over 4 s, engages > 0.2): eyes open v 5/7.5/9 ≤ 0.047/0.059/0.147 (s11), 0.040/0.044/0.100 (s23); eyes closed v 3/5 ≤ 0.060/0.082; challenge ≤ 0.098; photo v 3/5/7.5 ≤ 0.152/0.114/0.146. Never engaged.
The neural-field overlay request (NOTES, polish-room-r2 integration note) was applied by its owner during this round (overlay off with the eyes closed, multiplicative): the eyes-closed/challenge frames above are without its grey veil.

Review words (looked at every frame):

| frame | words | note |
|---|---|---|
| room_v5_s11 | hot, saturated, glowing | magenta-violet walls, azure-cyan window, rosette patches with feathered cyan glow; right wall a little rust |
| room_v7.5_s11 | hot, glowing, emerging | small cyan tunnel opening in the corner, crimson walls |
| room_v9_s11 | folding, jewelled, deep | large tunnel with a kaleidoscopic annulus, twist, chromatic echoes |
| room_v5_s23 | cool, jewelled, saturated | teal room, azure window (no lavender plateau), blue/hot-pink rosettes |
| room_v7.5_s23 | electric, luminous, deep | blue room, small honeycomb tunnel |
| room_v9_s23 | deep, jewelled, intricate | honeycomb tunnel and lattice annulus |
| room_v5_s11_eyes | electric, neon, banded | magenta/cyan rings with glowing filaments in the blooms; bold bullseye rather than intricate |
| room_v5_s23_eyes | luminous, jewelled, glowing | blue and fuchsia cells with lit rims on a deep ground |
| room_v3_s11_eyes / s23_eyes | glowing, banded / luminous, jewelled | |
| room_v9_s11_challenge | acid, harsh, angular | black ground, cyan/magenta shards lighting tight rings, chevrons |
| room_v9_s23_challenge | acid, cellular, angular | magenta shards revealing cyan-rimmed cells |
| room_default_v1 / v3 / v5 / eyes (seed 8, jewel) | calm room / vivid teal-fuchsia / hot, jewelled / luminous emerald-fuchsia cells | |
| room_photo_v1 / v3 / v5 / v7 / eyes / look (seed 6, ember; sample photo) | the photo itself, no haze / molten gold / molten, saturated / glowing, deep, with an emerging tunnel / warm luminous cells / golden kaleidoscopic | no veil, no blotches; near-monochrome warm (ember palette) |
| room_pano_v1 / v3 (seed 2, verdant) | calm / deep green, a little murky | the weakest frame |

Not met / reservations: s11 eyes-closed is bold and banded more than intricate; s11 v 7.5 median 0.048 (target ≥ 0.05); pano v 3 murky green.

## Waiting room polish, round 2 (polish-waiting_room-r2, 2026-10-11)

Stack: back end 8774, Vite 5177 (`vite.nohmr.config.ts`), sessions `verification/tmp/polish-waiting_room-r2/sessions`. Files: `frontend/src/layers/waitingRoom.ts`, `frontend/src/layers/glsl/waitingRoom.frag.glsl`, `frontend/tests/hyperbolic.test.ts` (+4 waiting-room tests). Decisions D-P-waiting_room-r2-1…9 in NOTES.md.

- Unit: `cd frontend && npx vitest run tests/hyperbolic.test.ts` **79 passed** (75 + 4 new: neon lights are #05d9e8 / #ff2a6d hues at full chroma, lunar block colours both cool, `capRedHue` keeps red share ≤ 0.74 by raising G/B, every palette's lights below the red rule). `npx tsc --noEmit` clean.
- Gallery: `GALLERY_LAYERS=waiting_room E2E_BASE_URL=http://127.0.0.1:5177 HYPERSPACE_SESSIONS_DIR=verification/tmp/polish-waiting_room-r2/sessions scripts/gallery.sh` → **12/12 frames pass**, capture exit 0, checks exit 0.
- Measurements (linear luminance; HSV S of the brighter half), gallery frames:

| frame | p5 | median | p95 | sat (bright half) |
|---|---|---|---|---|
| v5_s11 (neon) | 0.005 | 0.033 | 0.253 | 0.66 |
| v7.5_s11 | 0.005 | 0.044 | 0.356 | 0.58 |
| v9_s11 | 0.006 | 0.052 | 0.437 | 0.54 |
| v5_s23 (lunar) | 0.005 | 0.039 | 0.272 | 0.78 |
| v7.5_s23 | 0.006 | 0.049 | 0.345 | 0.73 |
| v9_s23 | 0.006 | 0.058 | 0.409 | 0.70 |
| v9_s11_challenge | 0.002 | 0.013 | 0.127 | 0.57 |
| v9_s23_challenge | 0.002 | 0.017 | 0.193 | 0.52 |

  v7.5 targets: p5 ≤ 0.05 ✓, median 0.05–0.2 ✗ (0.044 / 0.049: the dark recesses and the corridor are most of the frame; just under), p95 ≥ 0.3 ✓, saturation ≥ 0.5 ✓. Judge's p95 targets (≈ 0.26 / 0.33 / 0.42): s11 0.253 / 0.356 / 0.437, s23 0.272 / 0.345 / 0.409. Mean screen luminance 0.03–0.11.
- Review words (looked at every frame):
  * `waiting_room_v5_s11.png`: **luminous, deep, jewelled** — hot-pink and cyan blocks ranked down a crossing of two halls, near-black recesses, glowing panels, violet depth glow in the centre. Calmer than v7.5 (fewer lit blocks, the second colour's lines at half strength).
  * `waiting_room_v7.5_s11.png`: **luminous, jewelled, intricate** — more blocks ablaze, pink-on-cyan and cyan-on-pink line ornament on every face, white-hot crests.
  * `waiting_room_v9_s11.png`: **luminous, intricate, alive** — the brightest; fine filigree on the near blocks. Weak spot: the near ceiling/floor corners carry broad pink and cyan glow smears (glowing, not muddy, but less crisp than the faces).
  * `waiting_room_v5_s23.png`: **deep, luminous, cool** — cobalt and azure blocks with glowing panels on a navy base, blue depth glow down the halls. Close to monochrome blue by palette (lunar).
  * `waiting_room_v7.5_s23.png`: **luminous, jewelled, deep** — the lunar gold appears as thin bright lines; more panels lit.
  * `waiting_room_v9_s23.png`: **luminous, intricate, deep** — densest ornament; still a blue world.
  * `waiting_room_v9_s11_challenge.png`: **dark, acidic, intricate** — cyan and pink lines on near-black faces (face L ≈ 0.01–0.03), no lilac fill. A few pale-pink clusters where pink and cyan lines overlap with bloom (small area).
  * `waiting_room_v9_s23_challenge.png`: **dark, acidic, harsh** — the same acid pair on black for the lunar seed (it now turns colder/harsher, not lavender); no mint blob; some pale-pink clusters on the near ceiling.
  * v1/v3 frames (`waiting_room_v1_s*.png`, `_v3_s*.png`, layer forced below its window; the shader clamps intensity below v 4): same look as v5 (looked at `v1_s23`: **deep, luminous, cool**).
  * Re-rendered kind-forced frames (were byte-identical M6 originals): `waiting_room_mandelbox_v{7.5,9}_seed{11,22}.png` **luminous, jewelled, deep** (seed 22 is neon; p95 0.34–0.40); `waiting_room_mandelbox_v9_seed11_ch.png` **dark, acidic, intricate**; `waiting_room_kifs_v{7.5,9}_seed11.png` **dark, kaleidoscopic, jewelled-but-sparse** (p95 0.08 / 0.12); `waiting_room_kifs_v{7.5,9}_seed22.png` **dark, violet, flat** (p95 0.04–0.05) — kifs does **not** meet the bar yet (see D-P-waiting_room-r2-8). Neither gallery seed plans kifs.
- Worst case: `WORSTCASE_LAYERS=waiting_room WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0 E2E_BASE_URL=http://127.0.0.1:5177 HYPERSPACE_SESSIONS_DIR=… scripts/worstcase_flash.sh` (seed 11, mandelbox, v 9, challenge + entity + message, sensitivity 2): **PASS** — 690 frames at 30 fps (27.6 achieved), general flashes max 1.0/s (limit 3), red 0, **pattern frames 0** (max area 0.156, i.e. 5 of 32 blocks; was 0.25 before D-P-waiting_room-r2-7c), motion windows 0, max mean luminance 0.116, limiter engaged 0×. Seed 12 (kifs, lunar): PASS, 0 flashes, pattern area max 0.031, mean luminance ≤ 0.031. Guard monitor in scrub on the final shader (6 s per view: s11 v9, s23 v9, s22 v7.5, s11 kifs v9, s11 v9 challenge): pattern guard never engaged, limiter never engaged, max counted `highContrastFraction` 0.135 (< 0.2).
- Frame cost, 1920×1080, layer alone (ray march + bloom), 30 renders per rep, steady state after warm-up: mandelbox **2.6–2.8 ms** (v 5 / 9 / challenge), kifs **1.3–1.4 ms** (< 6 ms budget). Gallery sidecar `render_stats.frameMs` is 16.7 (vsync-bound, renderScale 1).

## Form constants polish, round 3 (polish-form_constants-r3, 2026-10-11)
Gallery `GALLERY_LAYERS=form_constants scripts/gallery.sh` against Vite 5175 / back end 8772: **12/12 frames pass** (blank, white, pattern 98–6154, palette, stuck). `FORM_CONSTANTS_GALLERY=1 npx playwright test neuralfield-spectrum`: 7/7 (v1 p2m 1.74; v6 stripes_x k 0.4418 vs 0.4418 predicted, p2m 6.3e5; v6 hexagons k 0.4476 vs 0.4418, three directions 60° apart). `npx vitest run`: 293/293 (neuralField 16/16). `npx tsc --noEmit`: clean. Worst case `WORSTCASE_LAYERS=form_constants WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0`: **PASS** twice (0 flashes, 0 red flashes, 0 pattern frames, max bad-block area 0.125, max mean luminance 0.087, limiter engaged 0×). Frame cost: 16.66–16.68 ms (vsync) at render scale 1.0 in every gallery sidecar.

Measurements (linear luminance; satHi = mean HSV S of the brighter half; flashcheck pattern_blocks on the gallery PNG):

| frame | p05 | median | p95 | > 0.25 | satHi |
|---|---|---|---|---|---|
| form_constants_v5_s11 | 0.031 | 0.045 | 0.121 | 3.5 % | 0.69 |
| form_constants_v7.5_s11 | 0.035 | 0.049 | 0.164 | 4.2 % | 0.72 |
| form_constants_v9_s11 | 0.038 | 0.054 | 0.270 | 5.1 % | 0.72 |
| form_constants_v5_s23 | 0.035 | 0.047 | 0.106 | 2.4 % | 0.64 |
| form_constants_v7.5_s23 | 0.036 | 0.049 | 0.151 | 4.0 % | 0.63 |
| form_constants_v9_s23 | 0.039 | 0.053 | 0.220 | 4.8 % | 0.62 |
| v9_s11_challenge / v9_s23_challenge | 0.023 / 0.026 | 0.036 / 0.039 | 0.086 / 0.090 | 2.2 / 3.1 % | 0.55 / 0.48 |
| tunnels_seed7 v5 / 7.5 / 9 | 0.033 / 0.036 / 0.036 | 0.046 / 0.051 / 0.051 | 0.135 / 0.250 / 0.356 | 3.9 / 5.0 / 5.8 % | 0.62–0.66 |
| funnels_seed11 v5 / 7.5 / 9 | 0.032 / 0.035 / 0.035 | 0.046 / 0.050 / 0.051 | 0.124 / 0.221 / 0.286 | 3.9 / 4.8 / 5.3 % | 0.68–0.72 |
| spirals_seed12 v5 / 7.5 / 9 | 0.029 / 0.034 / 0.035 | 0.045 / 0.051 / 0.054 | 0.129 / 0.231 / 0.312 | 3.9 / 4.8 / 5.5 % | 0.62–0.65 |
| lattices_seed13 v5 / 7.5 / 9 | 0.032 / 0.035 / 0.036 | 0.046 / 0.051 / 0.052 | 0.105 / 0.153 / 0.211 | 2.4 / 4.2 / 4.8 % | 0.71–0.74 |

(r2 for comparison: p95 0.074–0.147, 1–4 % above 0.25.) Repeated captures of the same v 7.5 frame vary: s11 v 7.5 p95 0.164–0.262 between captures (the core's lit area moves with the drift). Limiter guard `highContrastFraction` (max of 40 samples over 10 s): 0.145–0.166 at v 9, ≤ 0.152 at v 7.5, never engaged.

Review words (looked at every frame listed; class frames also on 2×2 contact sheets):

| frame | words | note |
|---|---|---|
| form_constants_v5_s11 | glowing core, violet, soft | blue neon ring around a lilac/pink core; periphery dark violet with pink/violet neon centre-lines, few sparks |
| form_constants_v7.5_s11 | luminous core, layered, violet | electric-blue and teal rings near the core, engraved contour lines on the outer tubes |
| form_constants_v9_s11 | incandescent core, layered, violet | white-hot core rings, gold sparks, wider neon lines; periphery still a violet field |
| form_constants_v5_s23 | honeycomb, violet, flat-ish | packed cells with dark centres and blue rims, gold-rimmed core cells |
| form_constants_v7.5_s23 | honeycomb, glowing core, violet | white core honeycomb with bloom |
| form_constants_v9_s23 | honeycomb, incandescent, violet | |
| form_constants_v9_s11_challenge | harsh, acid, banded | black core with lime/pink crest rings, lime spark dashes; periphery magenta + green lines on navy/wine (still some broad flank colour) |
| form_constants_v9_s23_challenge | cold, sparse, acid | slate cells, dark phosphor-green walls, lime core honeycomb |
| tunnels_seed7 v5/7.5/9 | glowing, blue-violet, monochrome | lunar palette: near-monochrome; spark dashes on the core rim at 7.5/9 |
| funnels_seed11 v5/7.5/9 | radiant, pink-blue, starburst | white starburst core, pink/blue neon spokes; the most colourful periphery |
| spirals_seed12 v5/7.5/9 | turning, blue-violet, soft | |
| lattices_seed13 v5/7.5/9 | honeycomb, magenta-violet, glowing | crimson rims, dark cell centres, pink/white core cells |

Not met / reservations (see NOTES D-P-form_constants-11, Limits): the periphery cannot carry 0.6–0.8 crest lines (guard 0.29–0.88 in every variant tried), so outside the core it reads as a dark violet/blue world with neon lines, not black with incandescent lines — "violet" and "soft" remain honest words there; p95 ≥ 0.25 at v 9 (and some v 7.5 frames), not at v 5; lunar-palette frames are near-monochrome; challenge periphery still shows broad magenta/navy flank colour; median 0.045–0.049 at v ≤ 7.5 (target ≥ 0.05).

## Waiting room polish r3 (polish-waiting_room-r3, 2026-10-11)

Linear luminance (sRGB-decoded, Rec.709) of the final gallery PNGs; satB = mean HSV S of the brighter half.

| frame | p5 | median | p95 | satB | words |
|---|---|---|---|---|---|
| kifs v5 seed11 | 0.003 | 0.009 | 0.050 | 0.80 | dark, ornate, plum (dimmest frame; magenta/sapphire slabs) |
| kifs v7.5 seed11 | 0.003 | 0.013 | 0.131 | 0.69 | neon lantern-ring, jewelled, dark |
| kifs v9 seed11 | 0.003 | 0.020 | 0.276 | 0.58 | luminous, ornate, neon (pink + cyan rings, no pale rope) |
| kifs v5 seed22 | 0.002 | 0.008 | 0.132 | 0.75 | kaleidoscopic, neon, dark |
| kifs v7.5 seed22 | 0.002 | 0.014 | 0.300 | 0.59 | luminous, kaleidoscopic, jewelled |
| kifs v9 seed22 | 0.002 | 0.021 | 0.369 | 0.55 | blazing, intricate, deep |
| v9 s11 challenge | 0.003 | 0.020 | 0.273 | 0.50 | acid, intricate, dark (cyan crosses, crimson lace, black corners) |
| v9 s23 challenge | 0.003 | 0.032 | 0.378 | 0.46 | electric, dense, a little hazy where the lace crowds |
| mandelbox v9 seed11 ch | 0.002 | 0.020 | 0.278 | 0.50 | acid, angular, intricate |
| v5 / v7.5 / v9 s11 | 0.005 | 0.033 / 0.043 / 0.052 | 0.254 / 0.348 / 0.434 | 0.66 / 0.58 / 0.54 | (unchanged from r2) luminous, jewelled, deep |
| v5 / v7.5 / v9 s23 | 0.005–0.006 | 0.039 / 0.049 / 0.058 | 0.271 / 0.346 / 0.411 | 0.77 / 0.73 / 0.70 | sapphire, gilded threads (sparse), intricate |

Before (r2): kifs p95 0.036–0.122 (seed22 0.043/0.049), challenge p95 0.127/0.129/0.193.
Gallery checks 12/12 pass. Guard (`highContrastFraction`, 10-s monitor): kifs seeds 11/22 v 5/9 max 0.098–0.11, guard never engaged (before the peripheral-thread fade: 0.18–0.27, engaged). Worst case (20 s, no sweep): seed 11 (mandelbox) PASS, 0 pattern frames, max area 0.156, flashes 0.5/s, max mean 0.117; seed 12 (kifs) PASS, 0 pattern frames, max area 0.188, flashes 0.5/s, max mean 0.123; limiter engaged 0×. Layer cost at 1920×1080 (shoot.mjs PERF, 30-frame batches, steady state): kifs v9 1.4–1.5 ms, mandelbox v9 2.5 ms, mandelbox challenge 2.6 ms (first batches 4–7 ms while clocks ramp); gallery render_stats frameMs 16.7 (vsync).

## Audio softening (audio-soft)
These are offline renders (`E2E_BASE_URL=http://127.0.0.1:5176 npx playwright test audio`) at master volume 1.0. At the new default volume of 0.5 every level is 6.0 dB lower; at the old default of 0.8 it was 1.9 dB lower. Speaker levels at default volume are therefore about 4.1 dB lower before any of the timbre changes below. Bands come from `uv run python tools/audio_spectrogram.py --compare verification/tmp/audio-soft/before`: the share of power in each band from 6 s to the end, in dB relative to the total.

| render | peak dBFS before → after | RMS dBFS before → after | centroid Hz | 3–6 kHz share dB | > 6 kHz share dB |
|---|---|---|---|---|---|
| max (all on) | −5.00 → −5.92 | −20.24 → −20.86 | — | — | — |
| i2 (v 2) | −29.42 → −32.58 | −39.62 → −39.81 | 338 → 271 | −26.0 → −59.8 | −25.7 → −62.4 |
| i6 (v 6) | −22.17 → −24.22 | −31.04 → −31.97 | 764 → 647 | −20.0 → −29.1 | −60.2 → −72.5 |
| i10 (v 10) | −13.53 → −15.49 | −22.40 → −23.89 | 1838 → 1561 | −10.0 → −13.6 | −19.5 → −29.6 |
| breakthrough | −7.46 → −6.51 | −20.36 → −19.43 | 1097 → 740 | −13.2 → −18.9 | −22.7 → −34.2 |
| challenge | −10.37 → −9.85 | −23.66 → −23.32 | 1203 → 806 | −13.7 → −18.1 | −21.7 → −33.2 |
| ceiling stress | −3.44 → −3.44 | | | | |

- **Crackle band.** Grains used to be 1.2–6.5 kHz centres at Q 12–30. They are now 550–2400 Hz centres at Q 8–18, inside a 400–3000 Hz bus filter, and −8 dB. In the i10 spectrogram the grain blobs sit between ≈ 300 Hz and 3 kHz and nothing is left at 3–6 kHz. In i2 the single grain sits at ≈ 0.4–3 kHz with a faint tail.
- **Gates.** All pass:
  - largest 200 ms rise 8.44 dB (max render), under 12;
  - level2 −39.81 < level8 −28.04;
  - buzz envelope peak 11.499 Hz = 23 × the 0.5 Hz pulse, oscillator max 11.88 Hz.
  - The envelope prominence of the buzz fell from 11.9 to 6.2 because the AM is shallower. Less margin, but the peak is still the locked buzz.
- **RMS barely moved** (−0.2 to −1.5 dB). It is dominated by the unchanged body rumble and the carrier fundamental, and a shallower AM raises the mean gain slightly. The softening shows up as less high-frequency energy (the band columns) and as the −4.1 dB default volume.
- **Spectrograms, looked at.**
  - i10: four carrier harmonic lines instead of 5–6, a fainter 6.8 kHz whine line, crackle below 3 kHz.
  - i2: a clean 330 Hz carrier with faint 2nd–4th harmonics, the whine at 2.8 kHz about 30 dB down.
  - breakthrough: the pad chords are now the brightest mid-band feature, with entity voices above them.
  - challenge: ring-mod lines and clusters from 3 s, the open major relief chord from 13 s.
- **Not listened to.** There is no audio output here, so these are spectrogram and metric judgements only.

## Director M9 (director agent, 2026-10-11)
Template stack: back end 8772 (`HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1`, sessions in `verification/tmp/director/sessions`), Vite no-HMR 5175.
- `npx tsc --noEmit`: clean. `npx vitest run`: 12 files, 329 tests pass (director.test.ts 25 tests: 10 updated M3 tests + 15 new).
- Hazard Monte Carlo (600 seeds, surrender 5): mean passage 35.3 s free (expected E[min(T,90)] 36.2 s), 8.42 s with space held (expected 8.5 s); test tolerance 10 % for surrender 0/5/10, held and free. Cap: 80 seeds at surrender 0, every passage ≤ 90 s, > 5 capped (flagged `capped: true`), relief 1 for 1–10 s after, 0 after 15.5 s. Gentle: 200 seeds, no challenge events even with `forceChallenge`, at most one flicker, longest measured < 5 s, 20–120 seeds with a flicker.
- E2E `E2E_BASE_URL=http://127.0.0.1:5175 HYPERSPACE_SESSIONS_DIR=verification/tmp/director/sessions npx playwright test escape gentle session`: 6 passed (7.6 min). Escape at the predicted peak (v > 7): fade → grounding ≥ 2.9 s, curve, end screen, report; event log on disk has one `exit_pressed` and `session_end {reason: escape}`; stats `ended_early_at` set. Gentle (strong dose, profile gentle): no challenge events, no flicker for seed 20261012, stats DIFFICULT PASSAGE "GENTLE MODE".
- Breakthrough session (session.spec, seed 20261010, template planner, 2 beings + message): entity 0 (alien) appears 19.6 s after the latch, beats approach/greet/show/work_on/transform/depart every 8 s (planner durations < 8 s clamped), `message_shown` (theme curiosity) 2.2 s into work_on, entity 1 arrives 20 s after entity 0's depart finished; stats box "BEINGS MET 2 · ALIEN", "MESSAGE RECEIVED". Frames entity_0, entity_1, message, peak captured.
- Breakthrough gallery (`GALLERY_LAYERS=breakthrough GALLERY_OUT=verification/tmp/director/gallery`, template stack): 14 frames, gallery_checks 12/12 pass (the two `_entity` frames are outside the checker's naming). Frames are the breakthrough agent's work in progress; my honest words: the forced entity + message frames (`breakthrough_v9_s{11,23}_entity.png`) are luminous and intricate — a glowing sapphire (s23) / gold-and-cyan arched (s11) being centred and close, full rotating glyph rings in cyan and coral, kaleidoscopic echoes around it; the base v 7.5/9 frames without a being are a bright gold/violet line lattice in a glowing decagon frame on a violet ground, luminous in the centre but sparse, and the outer frame panels are flat mid-tone mauve/teal blocks (flat, slightly muddy). In the session capture `entity_0` (taken at intensity 0.6, before the depth condition was added) the being was a faint ghost off to the side; the capture now waits for depth ≥ 0.5 too (not re-run in a full session).

## Breakthrough (breakthrough agent, 2026-10-11)
"Generated worlds, framed": the session's SDXL panoramas inside a rotating polygonal mandala frame, beings in front with kaleidoscopic echoes, glyph rings for the message. Decisions D-B1..D-B10 are in NOTES.md.
- **Gallery** (`GALLERY_LAYERS=breakthrough E2E_BASE_URL=http://127.0.0.1:5174 … scripts/gallery.sh`, REAL back end on 8771 with SDXL worlds; 11.0 min, setup 36–52 s per shot inside the spec's budget): capture exit 0, `gallery_checks.py` **12/12 pass**.
- **Words, honest:**
  - v9/v7.5 s23: luminous, deep, saturated nebula sky (orange cloud, gold sun, cyan) with a glowing robed being (real sprite) haloed by a ring and five mirrored echoes. Reads as a climax. The frame is the weak part: dusty blue/teal/olive flat bands, matte.
  - v9/v7.5 s11: a deep navy cosmos with a magenta-gold comet stream; jewel-bright inside a gold/cyan rim. No being, because seed 11's plan has none and the spec does not force one. Frame bands plum/teal, flat.
  - v9 challenge s23: acid green and violet, a tight green-rimmed aperture, green glyph rings round a cold blue being. Harsh and sharp, not grey: works.
  - v9 challenge s11: violet world with acid-green streaks. Harsh, legible, a bit empty without a being.
  - v1/v3/v5 (forced; in a real trip the layer only latches at v ≥ 8): the frame is closed to a small glowing window. A banded stained-glass tunnel in muted plum/teal/blue. Honest words: **flat, matte, slightly muddy**. This does not meet the bar. In a real session these frames never show, because the layer weight is 0 below the latch except during the 20-s release fade.
  - My own captures (verification/tmp/breakthrough/): r4.png (real world, being, gold/violet glyph rings: striking), t5.png (procedural fallback: an emissive gold/violet lattice dome with a glyph being and rings; vivid, busier, more "geometric" than "world"), t_ch.png (procedural, difficult passage).
- **Worst case** (`WORSTCASE_LAYERS=breakthrough WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0`, template stack 5173/8778, with entity, message and challenge forced): **PASS**. Max 1.0 general flash/s, 0 red, 0 pattern frames (max area 0.094), max mean luminance 0.102. The limiter's flash backstop engaged once (logged event).
- **Pattern guard:** off on the final captures (highContrastFraction ≤ 0.12 real, ≤ 0.165 procedural). Before D-B5 (bright seams) it was engaged: hcf 0.2–0.36 with grey blotches.
- **Cost** at 1920×1080: the layer's own pass measures 0.54 ms (procedural) and 0.56 ms (real worlds, being, rings). This is a CPU-timed loop of 60 renders with a render-target readback as the sync, so treat it as approximate. Budget is 6 ms.
- **Unit tests:** `npx vitest run tests/breakthrough.test.ts` 13/13 (alphabet determinism and 20–30 distinct glyphs, frame budget ≤ 2.4 / Michelson < 0.45, edge-passing < 2 Hz, aperture and veil, schedule 25–45 s with crossfades ≥ 2 s and never a cut, echoes 3–7, morph continuity, rings 2–4 with ≤ 0.5 Hz, message envelope). `npx tsc --noEmit` is clean.

### Breakthrough, round 2 (after the art-director rejection; breakthrough agent, 2026-10-11)
Decisions D-B11..D-B17 in NOTES.md. Changes: the surround tunnel of flat panels is replaced by a near-black log-polar Voronoi membrane with emissive accent filaments; the portal opens to ≥ 80 % of the screen at v ≥ 7.5; the procedural world is rebuilt (nebulae, spiral lattice, jewel galaxies); beings and echoes take accent colours, with a coloured halo ring; glyph rings are bright (L 0.5–0.8) with a dark backing; the difficult passage is green/magenta on black; phases are integrated, so the flash backstop no longer engages for a whole passage.
- **Gallery:** `scripts/gallery.sh` on the REAL stack (8771/5174) took 10.4 min, capture exit 0. Afterwards I re-captured with verification/tmp/breakthrough/cap.mjs (same file names; sidecars rewritten to the gallery fields): v7.5_s11, v9_s11, v9_s11_entity and v9_s11_challenge (after the exposure fix), and v9_s23_challenge (after the polygon-rotation fix, at challenge level 1). New frames: v9_s{11,23}_message (real), v9_s11_procedural (being + rings), v9_s23_procedural and v9_s11_procedural_challenge (template stack). `gallery_checks.py --layers breakthrough`: **12/12 pass**. The new kinds fall outside the checker's naming, so it skips them. Pattern guard: off on every capture (max hcf 0.12).
- **Numbers** (linear luminance; saturation is the mean HSV S over the brighter half):
  - v9_s23: p95 0.645, sat 0.64
  - v9_s23_entity: p95 0.683
  - v9_s23_message: p95 0.686
  - v9_s23_challenge: p95 0.292, sat 0.50
  - v9_s11_entity: p95 0.357
  - v9_s11_message: p95 0.338
  - v9_s11_procedural: p95 0.454
  - v9_s23_procedural: p95 0.396
  - **Below the 0.25 floor:** v9_s11 at 0.158 (sat 0.75), v9_s11_challenge at 0.134 (sat 0.56) and v9_s11_procedural_challenge at 0.213. Seed 11's real world is a mostly dark navy neon cosmos; the exposure lift (≤ ×2.2) raised it only from 0.134.
  - Surround (outer 140-px columns) at v1–v5: p05 0.006, median 0.010–0.012, p95 0.026–0.032. This is now true dark with thin bright lines. At v9 the outer columns are mostly world.
- **Words, honest:**
  - v9_s23 and v7.5_s23: an immersive luminous nebula sky (orange cloud, gold sun, cyan) fills almost the whole frame. The robed being is lavender-blue, haloed by a thin cyan/gold ring, with gold, lavender and teal echoes, and gold/cyan filament polygons sit at the edges. Reads as a climax. The being is still on the pale side (lavender rather than jewel), and its lower edge shows a stair-stepped matte from the sprite itself.
  - v9_s23_message: bright gold and cyan glyph rings stream around the being and read clearly over the nebula. Striking.
  - v9_s11 and v7.5_s11: a magenta-gold flame stream across a deep navy cosmos with glowing blue lights. Vivid, but the right half is dark: luminous rather than overwhelming.
  - v9_s11_entity and v9_s11_message: a golden glass-robed glyph being with a pink head and gold/cyan glyph rings over the flame stream, with coloured echoes. No sprite box. Jewelled and alive.
  - Challenge frames (s11, s23, procedural): acid green and magenta filaments on near-black violet cells, a tighter portal, the world in violet and acid green. Harsh and cold, not grey. s11's world centre is a dim purple murk. s23 shows one bright green horizontal line at the panorama's horizon, from the edge filaments.
  - Procedural frames: luminous violet/magenta/teal nebulae, a gold/pink spiral lattice, jewel galaxies and a straight-line lattice. Bright and colourful. Slightly hazy and pastel in places, and the straight lattice lines read a little like a wireframe.
  - v1–v5: a small-to-mid portal (about 35 % at v5) with gold/cyan double polygons inside a near-black jewel-violet/blue honeycomb membrane with glowing cyan/pink/violet filaments. No longer beige. At v5 the cells still read as dark coloured panels (blue for lunar, violet for neon), not black. In a real trip these frames only show during the release.
- **Worst case** (`WORSTCASE_LAYERS=breakthrough WORSTCASE_SECONDS=20 WORSTCASE_SWEEP=0`, template stack, entity, message and challenge forced): **PASS**. Max 1.0 general flash/s, 0 red, 0 pattern frames (max pattern area 0.188 < 0.25, max periodic contrast 0.96), max mean luminance 0.188. The limiter logged one engagement event. Traced on its own: before D-B13 the backstop was engaged for the whole forced passage; after it, 0 engagements through a full passage (s23 with being and message, template stack).
- **Cost** at 1920×1080 (CPU-timed loop of 60 renders with a readback; approximate): 0.57 ms with a real world, being and rings; 1.43 ms with the procedural world, being and rings. Budget is 6 ms.
- **Unit tests:** `npx vitest run tests/breakthrough.test.ts` 15/15. New tests cover portal coverage of at least 80 % at v ≥ 7.5 for 7- and 12-gons, a narrower portal in a passage, near-black membrane fill and a constant cell count. `npx tsc --noEmit` is clean.

## Integration M9 (integrate-m9, 2026-10-11)
| Check | Result |
|---|---|
| `cd frontend && npx tsc --noEmit` | clean (exit 0) |
| `npx vitest run` | 12 files, 331/331 pass (30.5 s) |
| `npx vite build` | ok (pipeline 508 kB, main 329 kB) |
| real server `./run.sh --serve-only` (8765) + `npx playwright test session escape gentle screens --reporter=line` | 14/14 pass (12.0 min); gentle: flickers [], 0 measured runs |
| same server, `npx playwright test safety-limiter --reporter=line` | 5/5 pass (35.5 s), every case flashcheck PASS |
| real breakthrough session via API + scrub `&session=2026-10-11_1746`, v 9, entity + message forced, 1920×1080 | intake → ready 38.1 s; entity 1.0, depth 0.93, message 0.90; passes end with SafetyLimiter; no page errors; `verification/gallery/breakthrough/integration_real_v9.png` |
| `WORSTCASE_LAYERS=breakthrough WORSTCASE_SECONDS=60 E2E_BASE_URL=http://127.0.0.1:5179 scripts/worstcase_flash.sh` (template stack 8779/5179) | 2/2 PASS. breakthrough: max 1.0 flash/s, 0 red, 0 pattern frames (max area 0.188), max mean L 0.188, limiter engaged 1×. sweep: max 1.0 flash/s, 0 red, 0 pattern frames, max mean L 0.17, limiter engaged 1× |
| `GALLERY_LAYERS=breakthrough E2E_BASE_URL=http://127.0.0.1:5179 scripts/gallery.sh` | capture exit 0, checks 12/12 PASS |

By eye: the real v 9 frame is vivid and cosmic (orange, gold and cyan nebula over dark mountains, a violet robed being inside gold and cyan glyph rings, frame at the screen edges) but cluttered, with beige echo sprites. The template-stack procedural v 9 frames are colourful (violet, cyan, magenta, gold spiral), with soft hazy clouds; a thin horizontal line at mid-height is still visible in v9_s11.
