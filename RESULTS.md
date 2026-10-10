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
