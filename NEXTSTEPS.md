# NEXTSTEPS.md — from prototype v0.2 to a deep, reactive, headset-ready v1

Written 2026-10-29 after the user's feedback on v0.2 (`c28a45f`). This is the working plan for the
next blocks. It sits beside `BUILD.md` (the spec, still binding for safety and content) and
`PROGRESS.md` (milestone status). Decisions made while executing go to `NOTES.md` as before.

## 0. What the user asked for (recorded answers)

| Question | Answer |
|---|---|
| Next block | **Finish the core, then VR.** |
| More visually interesting | **Real depth and immersion**, **richer motion and transitions**, **reactivity and interaction** (all three). |
| Realism vs spectacle | **Realism first, spectacle within it.** Keep the phenomenology from the trip-report literature; make every stage as beautiful as it can be. |
| VR hardware | **Quest linked to this PC** (Link / Air Link, OpenXR). Chrome on the PC renders with the 4090; the back end stays loopback-only. |
| Headset availability | Have one, **testing later**. Build and verify against the WebXR emulator first. |
| VR room | **360° phone panorama** (2:1 equirectangular) on a depth-displaced sphere. |
| VR input | **Head only (gaze)** plus **breath via microphone**. No controllers, no hand tracking. |
| VR scope | **The whole session in the headset**: setup and safety as floating panels, the trip, grounding and the end screen. The report is read on the desktop. |

Standing constraints (unchanged): `SafetyLimiter` last in every pipeline with no disable path; no
threshold loosened; protected files per `BUILD.md` §0.7; loopback only; no real-dose information;
every block ends in a runnable checkpoint the user can try (`./run.sh`), capped at 2–3 h of agent time.

## 1. Where v0.2 stands

Done: M0–M9, the start simplification, snapshots and the downloadable report (zip + standalone HTML).
Open items carried over (see `NOTES.md` D-I16+ and `docs/PROTOTYPE_v0.md`):

1. **Safety finding.** The unprotected 20 s fast sweep (0 → 10 → 0) shows 2–3 frames with a
   periodic pattern over 25 % of the screen during rapid layer changes. Present since v0.1. The
   protected 60 s sweep passes. Must be understood and fixed before anything else is built on top.
2. **Climax plateau.** v7.5 and v9 look the same; the frame is pushed to the screen edges; the dark
   generated world (seed 11) is dim; difficult passages murky in places; beige echoes; a horizontal
   seam in the procedural world. Art-director verdict: FAIL (NOTES, judge r2).
3. **Form constants dim** (held to the 3:1 window at a low level); **waiting-room KIFS kind sparse**.
4. **Report rough edges.** PNG frames make the zip 25–60 MB; end-screen snapshot count ≠ strip
   count; lab-view figures use a different font and width; the template writer can quote a message
   that never appeared; the "three minutes of questions" sentence; ~70 s stall after the curve.
5. **Unheard audio** (only spectrograms); **no replay e2e**; **no `verify_all.sh`, demo, `DONE.md`**.

## 2. Block A — finish the core (1–2 workflow rounds, ≈ 2 h each)

Goal: everything above closed, nothing new added, `verify_all.sh` exists and is green.

### A1. Fast-sweep safety finding (safety owner, first)
- Reproduce with `WORSTCASE_SECONDS=20` on the template stack; log which layer pair and which
  intensity produce the pattern frames (`verification/tmp/integrate-v02/worstcase-sweep-20s-*`).
- Hypotheses to test, in order: (a) during a crossfade two periodic layers sum to a higher-contrast
  periodic field than either alone; (b) the limiter's tile history resets or lags at layer switches;
  (c) the periodicity score misses the mixed pattern for ≥ 2 frames. Fix at the layer blend
  (each layer applies its cap from its own known state; the crossfade must not exceed the cap of
  the brighter input) or in the guard's reaction time. No threshold changes. Explain in NOTES.
- Add the 20 s sweep as a **new** regression spec (not by editing the protected 60 s one).

### A2. Climax and the two dim layers (visual owner + art director, one judge round)
- Breakthrough: keep the glowing frame on screen at the peak (70–85 % of the width, visible on all
  sides), escalate v7.5 → v9 (crest brightness, echo count, slow dome rotation, bloom), per-world
  exposure so a dark panorama still reads, acid-on-black passages, no seam, echoes at full chroma.
- Form constants: use the 3:1 window at a higher level (troughs ≈ 0.07, ridges ≈ 0.2), hue contrast
  across the pattern, thin crests < 2 % area at 0.7–0.9, near-black only from non-periodic depth.
  The judge's bar for a full-screen periodic layer is this window, not p05 ≤ 0.06.
- Waiting room KIFS: emissive edges, ambient occlusion in recesses, more structure at v 5–7.5.

### A3. Report and session polish (report owner)
- Zip frames as JPEG q90 at 1920 px (PNG stays on disk); target < 8 MB. Count on the end screen =
  frames in the strip (one shared de-duplicated list). Figures rendered at column width with
  VT323/monospace. Writer never mentions a message, being or passage absent from the event log
  (assert in a test). Replace the intake sentence in `templates/setting.yaml`. Find the 70 s stall
  after the curve (likely waiting for the report before the end screen; the end screen should show
  stats immediately and poll the report in the background).
- Replay e2e (determinism: same event sequence) and a first listen of the audio by the user.

### A4. Ship gates (M11)
- `scripts/verify_all.sh` aggregating every gate in `BUILD.md` §16 (unit, LLM, assets, protected
  safety, galleries, retro screens, e2e, privacy, performance, validation `--n 200`); demo clip;
  README; `DONE.md`. Performance records "unmeasured" rather than "passed" if the GPU is absent.

Checkpoint: **v0.3** — same product, every open item closed, `verify_all.sh` green.

## 3. Block B — depth, motion, reactivity (2–3 rounds), built headset-ready

Realism first: every item below is tied to a feature of the reported experience (BUILD §11, the
style guide, the trip-report literature). Spectacle is how well we render it, not what we add.
Every round ends with the art-director gate on galleries **and** a 30 s motion clip per layer.

### B1. A shared 3D frame ("the rig")
The single most important change, and the groundwork for VR. Today each layer is a full-screen
shader with its own notion of "look". Introduce one camera rig: head pose (yaw, pitch, roll, small
positional offset) + a slow, constant-velocity dolly, exposed to every layer as uniforms. On the
desktop the rig is driven by the mouse (clamped as now); in VR by the headset. Rules: seated,
horizon-locked, no acceleration bursts, drift ≤ the comfort limits in §4 and §C3 below.
- Room: already a depth-displaced mesh/sphere; attach to the rig.
- Form constants: render the tunnel/funnel/spiral/lattice as a **volume** (ray-marched slab or 6–8
  depth-sorted planes) so the tunnel has a far end you move toward; cobweb/lattice as a surrounding
  shell. Keeps Klüver's forms; adds the depth people describe ("moving down a tunnel").
- Chrysanthemum: project the hyperbolic tiling onto the inside of a dome (Poincaré ball seen from
  inside, Coulon/Matsumoto/Segerman/Trettel style as the stretch), Möbius flow continuous, the
  petal fold with real shading. Reported as "a dome of jewelled petals folding" — this is literal.
- Waiting room: the ray-marcher takes the rig's pose (it is already 3D). Stretch: hyperbolic
  3-space (M12 item) as a second kind.
- Breakthrough: world on a sphere dome with **depth parallax** (run Depth-Anything on each
  panorama at generation time → displaced sphere), the frame as a real 3D polygon ring around the
  seat, entities placed at true depth with the echoes behind them, glyph rings orbiting at arm's
  length.

### B2. Motion and transitions ("melting, not crossfading")
- Layer changes become morphs on the rig: the tunnel's far end opens into the chrysanthemum
  dome; the dome's petals fold into the waiting-room walls; the waiting room's far wall is the
  portal that opens into the world (the frame is that wall). Crossfade stays ≥ 300 ms and the
  blend obeys A1's cap rule; the choreography is time-based and ≤ 0.5 Hz.
- Peak escalation: v maps to dome rotation, echo count, crest brightness, flow speed (never above
  2 Hz), with bloom as "light". Beats from the director drive kaleidoscopic folds (symmetry order
  rising for 2–4 s, then relaxing).
- Difficult passage: narrowing, colder, faster within limits, sharper; relief floods warm colour
  back over 15 s with the geometry opening. Already specified; make it visible in motion.

### B3. Reactivity
- **Gaze/mouse:** beings turn toward where you look (within their behaviour script), the glyph
  ring ripples from the gaze point, the frame's nearest facet brightens. Latency ≤ 100 ms,
  magnitude small, never a cut.
- **Let-go hold:** geometry visibly relaxes (fold order drops, drift slows, colour warms) while
  held; the director already lowers hazard.
- **Breath (microphone, opt-in, local only):** an RMS envelope with a 1–2 s attack drives (a) the
  inhale on the hit screen (hold fraction from a detected inhale of up to 4 s, with Space as the
  fallback) and (b) a slow pulse (≤ 0.3 Hz) in the room breathing and form-constant drift. The mic
  modulation path exists (`state.mic`); make it a first-class, visible effect. Nothing recorded.
- **Eyes-closed in VR:** dim the room dome, keep the field; on the desktop `E` as now.
All reactivity passes through the limiter; add a worst-case run with synthetic mouse and mic input.

### B4. What stays off the table in B
Controllers, hands, live diffusion (M12), passthrough, any effect that needs > 2 Hz or a cut.

Checkpoint: **v0.4** — the desktop trip has depth, melts between stages, answers to gaze, hold
and breath; `verify_all.sh` green; art-director PASS on every layer including motion clips.

## 4. Block C — WebXR headset mode (2–3 rounds; first round without the headset)

### C1. Architecture
- **Runtime:** Quest over Link/Air Link → Meta's OpenXR runtime → Chrome on this PC (WebXR
  `immersive-vr`). Nothing changes server-side: the back end stays on 127.0.0.1; the headset is a
  display, not a client. Standalone Quest is explicitly out of scope.
- **Renderer:** three.js `WebXRManager` with the existing pipeline rendered **per eye** at the
  headset's recommended framebuffer scale, adaptive render scale (`quality.ts`) keyed to 72/90 Hz.
  The `SafetyLimiter` runs on each eye's final image (shared thresholds, per-eye tile history) and
  **remains the last pass in XR**; the structural test is extended to the XR composer.
- **The rig from B1** is the only place head pose enters; layers do not touch XR APIs.

### C2. The whole session in the headset
- Pre-trip, grounding and end screens as **world-locked curved panels** in front of the seat
  (canvas-rendered from the same copy, same amber/VT323 look, same key hints). Selection by **gaze
  dwell** (1.2 s with a visible ring) and by the PC keyboard (it is still a PC session). Safety
  screen: the checkbox needs a deliberate dwell; Continue creates the AudioContext as now.
- The hit: the breathing ring floats ahead; inhale by **breath** (B3) or hold Space/dwell.
- Trip: no HUD; the exit is a faint sigil below the horizon — dwell 2 s or Escape on the keyboard →
  3 s fade to the room panorama → grounding in the panorama → curve drawn by gaze (a point moving
  with head yaw over time; simpler: the desktop curve after taking the headset off is the fallback).
- End screen in the panel; **report on the desktop** (and in the zip). A stereo snapshot (left eye)
  per capture point goes into the report as well.

### C3. Comfort and safety in VR (hard rules, from BUILD §4 "Headset mode")
Seated only; horizon lock; no acceleration bursts (dolly at constant velocity, ≤ 0.3 m/s, ramped
over ≥ 2 s); gaze-locked layers (anything attached to the head) capped at opacity 0.6; a vignette
during any dolly; world-locked frame and seat; angular drift ≤ 10°/s; eyes-closed mode darkens
instead of cutting; flash and pattern rules unchanged and tested per eye; the volume keys work;
Escape always works from the keyboard even if the headset tracking is lost (then the session fades
to the room on the desktop window too).

### C4. Room: a phone panorama
Setup accepts a 2:1 equirectangular JPEG (phone panorama apps; also Quest's own camera export).
Depth-Anything on the panorama → displaced sphere (the code path exists for `panorama`); the same
sphere is the grounding room. Stretch: stitch a set of ordinary photos.

### C5. Testing without the headset
- Meta's **Immersive Web Emulator** (Chrome extension) driven by Playwright: enter XR, set the
  pose, capture both eyes, run `flashcheck` per eye, run the worst case per layer at the XR frame
  rate, and the Escape-from-every-state test. Galleries get `xr_left_*` / `xr_right_*` frames.
- Performance gate: Quest 3 per-eye 2064 × 2208 at 90 Hz target, 72 Hz accepted, with render
  scale ≥ 0.6; recorded as "unmeasured" if the emulator cannot report GPU time.
- When the headset is available: a checklist session (the user) with a comfort questionnaire in the
  report (`xr_comfort.json`), and the breath detector tuned on the Quest microphone over Link.

Checkpoint: **v1.0-vr** — the full session in the emulator, verified; then the first real headset
session with the user's panorama.

## 5. Order and time boxes

| Block | Rounds | Checkpoint | Gate |
|---|---|---|---|
| A core | 1–2 | v0.3 | `verify_all.sh` green, art-director PASS on breakthrough/form constants |
| B depth + motion + reactivity | 2–3 | v0.4 | art-director PASS incl. motion clips; worst case with synthetic input |
| C WebXR | 2–3 | v1.0-vr | emulator suite green; comfort rules tested; then a real headset session |

Each round: ≤ 3 builders with disjoint file ownership, one judge round with one fix pass, a
time-boxed integration that leaves a runnable `./run.sh`, a commit per checkpoint. Nothing in C is
started before A1 (the safety finding) is closed.

## 6. Open questions for the user (answer whenever; defaults in bold)

1. Panorama capture: which phone app will you use (**Google Street View / any 2:1 JPEG**)? Do you
   want the setup to also accept a set of normal photos to stitch?
2. Breath detection: should the mic be **opt-in at setup** (default off, per spec) or on by default
   in VR? Any objection to a short calibration breath on the hit screen?
3. Eyes-closed in VR: **darken the room dome and keep the field**, or black out completely?
4. Curve drawing after a VR trip: **take the headset off and draw on the desktop** (simplest) or a
   gaze-drawn curve in the headset?
5. Should the report include a short **replay-to-video** clip (M12 item) once replay is tested?
6. Quest model for the performance target: **Quest 3** assumed.
7. Anything from the literature you especially want to see (jesters, machine elves, the "waiting
   room" door, the "stained-glass" dome)? Motifs raise entity weights in the planner.
