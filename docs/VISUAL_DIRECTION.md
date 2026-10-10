# VISUAL_DIRECTION.md — what "visually striking" means here

The first gallery pass came out **drab**: pastel plateaus, grey veils, muddy mid-tones. That is a
misreading of the safety limits, not a consequence of them. This document is the aesthetic brief for
every visual layer. It sits beside BUILD.md §11 and §16.4 and never overrides BUILD.md §4.

## 1. The look

Self-luminous, jewelled, hyper-saturated, intricate, alive. Think of light seen through stained glass
in a dark room: a **deep dark base** with **glowing saturated colour** and **thin brilliant filaments**.
The reference vocabulary is the trip-report literature and the visionary-art tradition (Alex Grey's
line work, the Qualia Research Institute hyperbolic plates, Klüver's own drawings): never pastel, never
foggy, never flat colour fills.

Rules of thumb:

1. **Dark base, luminous figure.** Backgrounds sit at relative luminance 0.02–0.10. Pattern highlights
   sit at 0.20–0.45. Filaments, edges and "self-luminous" accents may reach 0.7–0.9 as long as they
   cover a small area (well under 25% of the screen). This is both more beautiful and safer than a
   mid-grey plateau.
2. **Saturation is free.** The flash and pattern limits are about luminance. A fully saturated magenta
   at luminance 0.25 next to a fully saturated cyan at luminance 0.25 is zero contrast for the pattern
   rule and maximally colourful. Use hue contrast for richness, luminance for structure.
3. **No veils.** Never add a uniform semi-transparent haze, fog or grey tint over the whole frame to
   "soften" an effect. Softness comes from gradients, glow and depth, not from reducing chroma.
4. **Glow and bloom.** Bright accents get a soft halo (a cheap separable blur of the bright pass, added
   back at low gain). Bloom reads as light, which is what every report describes.
5. **Depth and intricacy.** Layers have foreground, mid-ground and background: fine detail near the
   centre, larger forms outside, parallax with mouse look, slow drift. Flat 2-D fills look like a
   screensaver.
6. **Palette discipline.** Use the trip-script palette (five jewel palettes in `priors.yaml`) with
   the darkest colour as the base and the brightest as the accent. Never the amber UI palette inside
   the trip. Add complementary accents sparingly.
7. **Always moving, never flickering.** Every modulation is ≤ 2 Hz and most are ≤ 0.5 Hz, but
   something is always in motion: drift, breathing, rotation, slow Möbius flow, filament shimmer.
   Stills should look like a frame of a film, not a wallpaper.

## 2. How the safety limits map to this look (do the arithmetic, do not guess)

- **Pattern contrast ≤ 0.5 Michelson** over any periodic pattern covering more than 25% of the
  screen. Michelson = (Lmax − Lmin)/(Lmax + Lmin) ≤ 0.5 means **Lmax ≤ 3·Lmin**. Dark 0.08 and
  bright 0.24 is compliant and rich. Dark 0.30 and bright 0.60 is also compliant and looks like mud.
  Pick the first. Where a layer needs more punch, keep the high-contrast structure to thin lines
  (small area) and keep the broad periodic structure within the 1:3 ratio.
- **Flashes.** Nothing periodic above 2 Hz; crossfades ≥ 300 ms; no cuts. Slow is fine. Bright
  accents that drift are fine. Strobing is not.
- **No near-white frames.** Mean screen luminance stays below ~0.5; a dark base makes this automatic.
- **Red.** Saturated red (R/(R+G+B) ≥ 0.8) over large areas gets the stricter rule; use crimson,
  magenta and orange with a touch of blue or green rather than pure red for broad areas.

Each layer applies its cap **from its own known state** (BUILD.md §4.1): compute the pattern's
luminance range analytically or from a reduction and scale the *luminance* into the compliant window,
keeping chroma. Never desaturate to comply.

## 3. Per-layer prescriptions

**Room (§11.3).** At v=1 the photo is itself, slightly richer (saturation +10%). By v=3 colours are
vivid, edges have faint chromatic fringes, the wallpaper folding is visible where the field is active,
and the breathing is obvious in motion. The eyes-closed field is **dark and luminous**: near-black base
with the neural field drawn as glowing phosphene lines and soft blooms in two palette colours, not a
grey-blue blur.

**Form constants (§11.4).** Klüver drawings in light: a near-black base, the pattern as glowing
ridges with soft dark troughs (ratio ≤ 1:3 over the broad pattern), thin brighter crest lines, bloom,
hue drifting along the radius (tunnel depth cue), slow drift toward or away from the centre
(≤ 0.5 Hz equivalent), chroma from the palette. Tunnels should read as depth, lattices as a
honeycomb of lit cells, spirals as rotating very slowly.

**Chrysanthemum (§11.5).** The signature image of the whole product. Dark base; tiles as jewelled
cells with luminous edges; the Poincaré-disk shrinkage toward the rim obvious; Möbius flow slow and
continuous; Kleinian limit sets as bright pearl strings and lace at high chroma; petal fold with
shading so the sheet has volume; bloom on the edges. No fog. Group changes by ≥ 300 ms crossfade,
and the crossfade itself should be beautiful (one tiling melting into another).

**Waiting room (§11.6).** An enclosing, infinite, lit interior: emissive edges on the fractal
geometry in palette colours, ambient occlusion in the recesses, coloured fog only for depth (never a
grey veil), a stable peripheral frame, constant slow drift. The viewer should want to look around.

**Breakthrough (§11.7).** The generated or procedural world at full chroma behind a glowing geometric
frame; entities with luminous edges and kaleidoscopic echoes; the glyph message as bright rotating rings.
Procedural worlds and glyph beings must look intentional and luminous, not like missing textures.

**Difficult passages.** Harsh means *colder, tighter, faster within the limits, sharper geometry*,
not greyer. Drop the palette to two acidic complementary colours on black, narrow the tunnel, speed the
drift toward 2 Hz but not beyond, add dissonant angular detail; then let the relief beat flood warm
colour back in over 15 s.

## 4. Review bar

A layer passes the visual gate only if, in the gallery at v = 5, 7.5 and 9, a reviewer would describe
the frame with words like luminous, jewelled, deep, alive, intricate. If the honest words are pale,
washed, foggy, flat, pastel or muddy, the layer fails and goes back for another pass. Record the words
used in RESULTS.md.
