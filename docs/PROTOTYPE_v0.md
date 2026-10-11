# Prototype v0 — what works, what to look at, what is still missing

## v0.2 (start + report), 2026-10-11: what changed and what to evaluate

**What changed since v0.1** (your request: "simplify the start", "the report with snapshots can be downloaded", "simple, fun and aesthetically pleasing")
- **A much shorter start.** Title → safety screen → one setup screen → one prepare screen. With the defaults it is four key presses: `Enter` (title), `Space` + `Enter` (safety), `Enter` (setup), then hold `Space` when the ring turns cyan. The eleven intake screens are gone. The setup shows only the dose as four cards (`1`–`4`), the mode toggle (`G`: difficult passages on / gentle) and a drop zone for your room photo (`O` / drag and drop, `X` removes). The other questions (clarity, set, absorption, surrender, intention, motifs, eyes / sound / microphone) are on an optional `D` "more questions" screen; every answer still has a neutral default.
- **Settling and the hit are one screen.** A slowly breathing circle (12 s cycle) with the three progress lines under it; when the session is ready the ring turns cyan and "HOLD SPACE TO INHALE" appears.
- **Downloadable report with snapshots.** The trip saves up to 6 periodic snapshots (every 80 model-seconds while the visuals are deep) besides the layer entries and the peak. On the end screen "`n` SNAPSHOTS SAVED" shows the count and `[D] DOWNLOAD` saves `simulated-trip-report-<id>.zip`: a standalone `report.html` (fonts and images inlined, opens offline), the Markdown report, `stats.json`, the full-resolution frames (`frames/*.png`) and the lab-view figures (`figures/*.png`). Past sessions have the same `D` key, and the report page has a `[D] DOWNLOAD .ZIP` action bar.
- **A redesigned report page.** A header, the stats box beside an "in this report" index, the peak frame as a hero image, a 3-column snapshot strip with `m:ss · what` captions, the written report, the lab view, and "remembered vs logged" as a match figure.
- **One visual language on every screen.** Double-framed amber panels with the title set into the border, inverted primary buttons for what `Enter` does, a block-letter logo, and cyan only for "ready / done / calm". There is no flicker or animated noise; the only animations are the breathing circle, the 1 Hz cursor and the 10 s title hue cycle.

**What to evaluate**
1. **The start.** Is the path from the title to the hit short and clear enough? Is the setup screen readable at a glance? Try dropping a photo of your room onto it.
2. **The prepare screen.** Waiting 40–60 s for the models: does the breathing circle make the wait pleasant? Is the cyan "ready" moment obvious?
3. **The download.** Press `D` on the end screen and open `report.html` from the zip with no server running. Do the snapshots tell the story of the trip?
4. **The look overall.** Simple, fun and aesthetically pleasing, or still too much like a terminal dump?

**Known gaps in v0.2**
- The zip is large: about 25 MB for a strong session with 8 frames at 1920×1080, and 38–58 MB for a breakthrough session, because the frames are stored as PNGs. Storing them as JPEGs in `export.py` would bring it under ~15 MB. The standalone `report.html` already uses JPEGs (~6 MB).
- Counts differ between screens. The end screen counts every saved frame ("8 SNAPSHOTS SAVED"), but the report strip leaves out the peak and trims to a multiple of 3 ("6 frames"), and `GET /frames` does not drop duplicate frames.
- In the real strong session (2026-10-11_2044), the peak frame and the "3:04 · form constants" snapshot show chrysanthemum-like hyperbolic flowers, but the stats say the deepest layer is form constants. The labels follow the layer weights, not what the picture looks like.
- The LLM writer quoted a message ("You are not alone…") in a strong session whose log has no message (the stats box says MESSAGE NONE). The quote is not in the italic "filled in" text. The writer prompt and validation should forbid this.
- Lab-view figures (width, font, legend) were not restyled (`figures.py`). The report's setting paragraph still says "about three minutes of questions" (`templates/setting.yaml`).
- Replay (`P` on the end screen, `R` on the report page) exists, but no end-to-end test covers it in this round.
- Nobody has listened to the sound yet (unchanged from v0.1).

- **Safety, open item (pre-existing):** the worst-case sweep compressed to 20 s (`WORSTCASE_SECONDS=20`, not the protected 60 s default) fails flashcheck with 3 frames where a high-contrast periodic pattern covers more than 25 % of the screen (max area 0.281). The v0.1 code fails the same way (2 frames), so this round did not cause it. The protected 60 s breakthrough and sweep runs both pass with 0 pattern frames. The safety owner should look at the pattern guard during fast layer transitions.

Gates for v0.2 (RESULTS.md "Integration v0.2"): tsc, vitest 345/345, pytest 141/141, vite build, real-server e2e 16/16, safety-limiter 5/5, and worst case breakthrough + sweep at the protected 60 s all pass. The 20 s sweep fails as described above.


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

Checkpoint v0 was cut on 2026-10-11 for a first hands-on evaluation (M0–M8); v0.1 above adds M9. M10–M11 are not started. (Superseded in v0.2: most of M10 is done; M11 is not started.)

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

1. **The flow:** (v0.2: title → safety → setup → prepare/hit, see above) title → safety screen → intake → settling → the hit (hold Space) → trip → grounding →
   draw your curve → end screen with the stats box → report. Try a light step first, then
   breakthrough. Try a repeat hit (hold `H` early) and an early exit (Escape).
2. **The layers in the trip** (in order of depth): the room breathing and tiling, the Klüver form
   constants (tunnels / funnels / spirals / lattices), the chrysanthemum (hyperbolic tiling with Möbius
   flow and Kleinian lace), the waiting room (KIFS / Mandelbox interiors). The gallery of stills is in
   `docs/gallery.html`; before/after the polish pass in `docs/polish_before_after.png`.
3. **The sound:** carrier, buzz locked to the pulse, crackle, pad chords at breakthrough. Nobody has
   listened to it yet; it has only been checked with spectrograms.
4. **The intake and settling copy**, the retro terminal look, and the end screen. (Superseded in v0.2: one setup screen and one prepare screen, see above.)

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
  figures overlay, lab view, export and replay are M10. (Superseded in v0.2: LLM writer, memory model, lab view, snapshots and the .zip export work; see the v0.2 gaps above.)
- **No `verify_all.sh`, demo clip or `DONE.md` yet** (M11). Performance, privacy and batch-validation
  tests are also M11.

## Safety status

Every frame passes through the `SafetyLimiter` (last pass, no disable path). The protected flicker
tests and the 60-second worst-case flashcheck per layer pass (`RESULTS.md`). The large-area contrast
guard is now periodicity-aware (NOTES S8): it still engages from the first frame on stripes, rings,
lattices, checkerboards and chirped patterns (16 adversarially found evasions are regression tests),
and no longer compresses photographs or aperiodic bright detail. No threshold constant was changed.
