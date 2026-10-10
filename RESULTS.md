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
