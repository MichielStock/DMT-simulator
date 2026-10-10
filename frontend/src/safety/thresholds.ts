// PROTECTED (BUILD.md §0.7) — photosensitivity threshold constants from BUILD.md §4.1.
// Generated once from BUILD.md; treat as read-only. Never loosen any value here.
// The same numbers are embedded in tools/flashcheck.py (also protected).
//
// Source: WCAG 2.x SC 2.3.1, Ofcom guidance on flashing images and regular patterns, ITU-R BT.1702.

/** A general-flash transition is a change in relative luminance of at least this (fraction of max). */
export const FLASH_DELTA = 0.10;
/** ...where the darker of the two states is below this relative luminance. */
export const DARK_MAX = 0.80;
/** Saturated red: R / (R + G + B) >= RED_SAT. */
export const RED_SAT = 0.8;
/** Saturated red also needs a minimum linear red level to count (not near-black). */
export const RED_MIN_R = 0.2;
/** Ceiling: no more than this many flashes of either kind in any 1-second window. */
export const MAX_FLASHES_PER_S = 3;
/** ...over any region larger than this fraction of the screen. */
export const AREA_FRACTION = 0.25;
/** Periodic patterns covering more than AREA_FRACTION: Michelson contrast cap. */
export const PATTERN_CONTRAST_MAX = 0.5;
/** Periodic patterns: maximum reversal / oscillation / drift frequency (Hz). */
export const PATTERN_HZ_MAX = 2;
/** Analysis tile grid (columns, rows). */
export const TILE_GRID: readonly [number, number] = [64, 36];
/** Sliding analysis window (ms). */
export const WINDOW_MS = 1000;

// ---- Limiter engagement (deliberately stricter than the ceiling above) ----
/** Engage when a qualifying region reaches this many OPPOSING transitions in the window
 *  (i.e. ENGAGE_AT + 1 transitions, each reversing the previous one: 1.5 flashes vs the ceiling of 3). */
export const ENGAGE_AT = 2;
/** Saturated-red regions use this lower luminance delta... */
export const RED_DELTA = 0.05;
/** ...and engage at the first opposing pair (this many transitions in the window = 1 red flash). */
export const RED_ENGAGE_TRANSITIONS = 2;

// ---- Limiter output behaviour while engaged ----
/** Temporal low-pass: out = mix(prevOut, in, k), k = 1 - exp(-dt / LOWPASS_TAU_S), never above LOWPASS_K_MAX. */
export const LOWPASS_TAU_S = 0.15;
export const LOWPASS_K_MAX = 0.15;
/** Per-pixel luminance slew limit while engaged (relative luminance per second).
 *  0.2/s means a 0.10 change takes >= 0.5 s: at most 2 transitions (1 flash) per second. */
export const MAX_SLEW_PER_S = 0.2;
/** After the window clears, the limiter releases gradually over this many ms (no snap-back flash). */
export const RELEASE_MS = 1000;

// ---- Mean-luminance cap (no full-screen white or near-white frames) ----
/** Output mean relative luminance is soft-compressed above MEAN_KNEE and never exceeds MEAN_TARGET. */
export const MEAN_LUMA_CAP = 0.85;
export const MEAN_TARGET = 0.80;
export const MEAN_KNEE = 0.70;

// ---- Large-area high-contrast pattern guard (backstop for §4.1 "Patterns") ----
/** A tile counts as high-contrast when its Michelson contrast exceeds this (stricter than 0.5). */
export const GUARD_TILE_CONTRAST = 0.45;
/** Guard engages when more than this fraction of tiles is high-contrast (stricter than 0.25). */
export const GUARD_AREA_FRACTION = 0.2;
/** While the guard is on, local contrast is compressed to at most this Michelson contrast. */
export const GUARD_TARGET_CONTRAST = 0.4;

/** Rec. 709 / sRGB relative-luminance weights (applied to LINEAR RGB). */
export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];
