# Prototype v0 — what works, what to look at, what is still missing

## v0.1 (M9), 2026-10-11: what changed and what to evaluate

**What changed since v0**
- **The breakthrough is no longer the beige placeholder.** It now shows the worlds SDXL generated for your session as 360° panoramas, which crossfade every 25–45 s. A glowing gold and cyan polygon frame surrounds them, set in a dark honeycomb membrane with luminous filaments. During the release you see this as a portal that opens wide. If no image was generated, a procedural nebula world is shown instead.
- **Beings and glyph messages.** The planned entities arrive 5–20 s after the world, come closer, and "speak" once per trip. The message is a ring of an alien glyph alphabet seeded per session. Beings with no image are drawn as procedural glyph beings.
- **Director.** Runs the full sequence: the veil lifts, the world appears, a being arrives with beats every 8–15 s and then departs, and another may follow while you stay high. It also runs difficult passages with relief. Gentle mode never starts a difficult passage and allows at most one short fear flicker.
- **Softer sound.** Lower whine, softer and low-passed carrier, gentler buzz and crackle, and the default volume is 0.5. `-`/`+` still step it by 10%.

**What to evaluate**
1. A **breakthrough** dose all the way through. Does the trip stay spectacular after the waiting room, with no beige stretch? Watch for the portal opening, the world, the being arriving, and the glyph message.
2. Whether the peak feels like a climax. The art-director review still says it does not escalate past v 7.5, and the frame is pushed to the screen edges.
3. The **sound** at the new default volume. Is it still too loud or harsh?
4. **Gentle mode** (intake option) at a strong dose: is it calm throughout?

**Known weak spots**
- With a dark generated world (one of the two test seeds), the peak is dim.
- The difficult passages look murky (olive on purple) instead of sharp acid colours.
- The echo copies of the being can look beige.
- A thin horizontal line can show across the procedural world.

All safety checks pass: the 60 s worst case for the breakthrough plus the 0 → 10 → 0 sweep, and the limiter tests. Still frames are in `verification/gallery/breakthrough/`; `integration_real_v9.png` is a real session at the peak.

Checkpoint v0 was cut on 2026-10-11 for a first hands-on evaluation (M0–M8); v0.1 above adds M9. M10–M11 are not started.

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

- **Breakthrough layer is still the M3 placeholder.** (Superseded in v0.1, see above.) The planner already generates worlds and beings
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
