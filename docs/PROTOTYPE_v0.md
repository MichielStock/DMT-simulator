# Prototype v0 — what works, what to look at, what is still missing

Checkpoint cut on 2026-10-11 for a first hands-on evaluation. Milestones M0–M8 are complete and
the guard + visual-polish pass has landed; M9–M11 are not started.

## Run it

```
./run.sh            # builds the front end if needed, starts the back end on :8765, opens the browser
./run.sh --stop
```

The first session after a cold start loads qwen3:14b and SDXL-Lightning on demand; "intake → ready"
takes 40–60 s on this machine (gate: 3 min). To skip the models: `HYPERSPACE_FORCE_TEMPLATES=1
HYPERSPACE_NO_IMAGES=1 ./run.sh`.

Controls are in `docs/CONTROLS.md`. Escape always ends the trip. Sound volume is `-` / `+`.

## What to evaluate

1. **The flow:** title → safety screen → intake → settling → the hit (hold Space) → trip → grounding →
   draw your curve → end screen with the stats box → report. Try a light step first, then
   breakthrough. Try a repeat hit (hold `H` early) and an early exit (Escape).
2. **The layers in the trip** (in order of depth): the room breathing and tiling, the Klüver form
   constants (tunnels / funnels / spirals / lattices), the chrysanthemum (hyperbolic tiling with Möbius
   flow and Kleinian lace), the waiting room (KIFS / Mandelbox interiors). The gallery of stills is in
   `docs/gallery.html`; before/after the polish pass in `docs/polish_before_after.png`.
3. **The sound:** carrier, buzz locked to the pulse, crackle, pad chords at breakthrough. Nobody has
   listened to it yet; it has only been checked with spectrograms.
4. **The intake and settling copy**, the retro terminal look, and the end screen.

## Known gaps (planned, not bugs)

- **Breakthrough layer is still the M3 placeholder.** The planner already generates worlds and beings
  (SDXL-Lightning behind the safety filter, see `sessions/<id>/assets/`), but the front-end layer that
  shows them, the entities, the glyph messages, the director beats and the difficult passages with
  relief are M9.
- **Form constants are dimmer than the other layers.** They are a full-screen periodic pattern, so the
  photosensitivity pattern rule holds them to a 3:1 luminance range; the next pass will use that window
  at a higher level with hue contrast instead of a near-black base.
- **Waiting room, KIFS kind** (one of the two kinds) still reads dark and sparse; the Mandelbox kind
  passed review.
- **Report** is the M3 template report with the real stats box; the LLM-written report, memory model,
  figures overlay, lab view, export and replay are M10.
- **No `verify_all.sh`, demo clip or `DONE.md` yet** (M11). Performance, privacy and batch-validation
  tests are also M11.

## Safety status

Every frame passes through the `SafetyLimiter` (last pass, no disable path). The protected flicker
tests and the 60-second worst-case flashcheck per layer pass (`RESULTS.md`). The large-area contrast
guard is now periodicity-aware (NOTES S8): it still engages from the first frame on stripes, rings,
lattices, checkerboards and chirped patterns (16 adversarially found evasions are regression tests),
and no longer compresses photographs or aperiodic bright detail. No threshold constant was changed.
