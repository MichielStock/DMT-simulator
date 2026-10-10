# Hyperspace

A local, offline simulator of a short-acting psychedelic experience: a pharmacology model drives
layered procedural visuals (room → form constants → chrysanthemum → waiting room → breakthrough),
followed by grounding, drawing your own intensity curve, a session-stats end screen and a written
report that is always labelled **Simulated**. Every frame passes through a photosensitivity
`SafetyLimiter`; Escape always ends the session. Doses are shown only as named steps and in model
units, never as real-world amounts. See `BUILD.md` for the full specification.

## Run

```
./scripts/setup.sh      # once (downloads models; the only step that uses the network)
./run.sh                # builds the front end if needed, starts the back end, opens http://localhost:8765
./run.sh --dev          # Vite dev server on :5173 with hot reload
./run.sh --stop
```

Environment switches: `HYPERSPACE_FORCE_TEMPLATES=1` (no language model), `HYPERSPACE_NO_IMAGES=1`
(procedural assets only), `REPORT_EXPORT_DIR` (copy reports elsewhere).

## Controls

Keyboard-first; full table in `docs/CONTROLS.md`. In the trip: `Esc` or the exit corner ends the
session (3-second fade, then grounding), `E` eyes, `I` heads-up display, hold `H` for a repeat hit,
hold `Space` to let go.

## Where things go

Each session is a folder `sessions/YYYY-MM-DD_HHMM/` with `intake.json`, `trip_script.json`,
`event_log.jsonl`, frames, figures, `simulated-trip-report.md` and `report.html`.

## Development

- Tests: `uv run pytest backend/tests -q`; `cd frontend && npx tsc --noEmit && npx vitest run`;
  e2e: `cd frontend && npx playwright test` (starts or reuses the server on 8765).
- Progress and decisions: `PROGRESS.md`, `NOTES.md`, `RESULTS.md`. `DONE.md` will hold the final
  verification summary.
