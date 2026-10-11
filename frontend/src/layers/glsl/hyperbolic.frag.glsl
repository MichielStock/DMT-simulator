// Chrysanthemum layer (BUILD.md §11.5): hyperbolic triangle-group tilings in the Poincaré disk by
// reflection folding, warped onto a radially symmetric flower/dome sheet, with a Kleinian (Maskit)
// limit set drawn as a ring of lace / pearl filaments. Output is LINEAR RGB, alpha = layer weight.
//
// Look (docs/VISUAL_DIRECTION.md §3): stained glass in a dark room. A dark base in the darkest palette
// colour; a many-petalled flower (deep notches, petal folds shaded for volume) carrying a Poincaré disk
// whose cells shrink toward the rim; every cell a jewel (lit-glass core at full chroma, band sinking into
// the deep base hue, a thin luminous edge in a bright accent hue with an analytic bloom halo, an inner
// petal in the accent hue; at v 9 star-cut facet seams and a miniature tiling in the core), each cell
// its own hue/brightness
// (dihedral-symmetric about the tiling centre); the Kleinian limit set as pearl strings and lace behind
// the petals; a luminous circle at infinity.
//
// Safety at source (BUILD.md §4.1): the broad periodic structure (cell core vs band) keeps
// Lmax/Lmin ≤ 2.4 (Michelson ≤ 0.41); only thin edges / filaments / pearl rims / facet seams (small
// area, faded out where cells get small) are brighter. No near-white (luminance cap 0.86 on accents,
// mean ≪ 0.5). Per-cell brightness/hue variation keeps rings of equal cells from forming a luminance
// lattice; uneven petals and a rim that sinks into the dark keep the flower outline from reading as a
// regular train (the limiter's pattern guard counts ≤ ~0.17 of tiles in the r2 probes, engages at 0.2).
// Where the Möbius flow would change the pattern faster than ~0.6 Hz at a pixel the cells keep their
// hue but lose most luminance structure; beyond ~2 Hz, or below ~2–5 px, detail dissolves into a dim
// dust. Group changes are crossfades (uMix, ≥ 300 ms per pixel).
precision highp float;
varying vec2 vUv;

uniform vec2 uRes;           // scene target size in pixels
uniform float uWeight;
uniform float uTime;         // state.wallTime (s)
uniform float uPulse;
uniform float uIntensity;    // visual / 10
uniform float uChallenge;    // 0–1
uniform vec2 uLook;

// two tilings for crossfades: wedge angle π/p, mirror-2 normal, circle centre + radius
uniform vec4 uTriA;          // (wedge, n2.x, n2.y, R)
uniform vec2 uCenA;
uniform vec4 uMetaA;         // (|B| folded triangle size, polygon spacing λ (hyperbolic), p, group zoom)
uniform vec4 uTriB;
uniform vec2 uCenB;
uniform vec4 uMetaB;
uniform float uMix;          // 0 = A only, 1 = B only

// Möbius motion z ↦ (a z + b)/(c z + d): now and 0.25 s ahead (for the temporal-frequency guard)
uniform vec4 uMobAB;         // a.re a.im b.re b.im
uniform vec4 uMobCD;
uniform vec4 uMobAB2;
uniform vec4 uMobCD2;

uniform float uZoom;         // screen radius → hyperbolic stretch of the dome
uniform float uDiskR;        // screen radius of the Poincaré disk (the flower opens with intensity)
uniform float uPetals;       // number of petals (2p of the first group)
uniform vec3 uPal[5];        // palette, LINEAR, jewel chroma, normalised to relative luminance 0.2
uniform vec3 uPalC[5];       // for each palette colour the most hue-distant palette colour (accents)
uniform vec3 uDark;          // darkest palette colour (hue of the base), LINEAR, luminance 0.2
uniform vec3 uHarsh[2];      // difficult passage: two acidic complementary colours, luminance 0.2
uniform vec3 uAcc[2];        // the two palette colours that carry the most luminance at full chroma
                             // (neon: yellow, ice-cyan; lunar: amber, sky): filaments, pearl rims, sparks
uniform float uLv;           // escalation 0 (v 5) → 1 (v 9.5): depth, lace density, crest bloom, fold shading

uniform sampler2D uField;
uniform float uHasField;

uniform vec2 uKlein;         // Maskit height (Im μ), shift (−Re μ)
uniform float uLaceRot;      // slow rotation of the lace ring (rad)
uniform float uLaceN;        // repeats around the ring (integer)
uniform float uLace;         // lace brightness 0–1 (always drawn crisp; dim at v 5, full from v 8.5)

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { float d = dot(b, b); return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / d; }
vec2 mob(vec4 ab, vec4 cd, vec2 z) { return cdiv(cmul(ab.xy, z) + ab.zw, cmul(cd.xy, z) + cd.zw); }
float atanh_(float x) { return 0.5 * log((1.0 + x) / (1.0 - x)); }
float hdist(vec2 z, vec2 w) {
  vec2 den = vec2(1.0, 0.0) - cmul(vec2(z.x, -z.y), w);
  return 2.0 * atanh_(min(0.999999, length(z - w) / length(den)));
}

// mix two colours keeping their chroma (a plain linear mix of complementary hues is grey)
vec3 cmix(vec3 a, vec3 b, float t) {
  vec3 c = mix(a, b, t);
  float la = dot(a, LUMA), lb = dot(b, LUMA), lc = dot(c, LUMA);
  float ca = length(a - la), cb = length(b - lb), cc = length(c - lc);
  return max(vec3(lc) + (c - lc) * (mix(ca, cb, t) / max(cc, 1e-4)), 0.0);
}

vec3 palette(float k) {
  // walk through the 5 palette colours: mostly the pure colours, short chroma-preserving transitions;
  // in a difficult passage it collapses onto two acidic complementary colours (docs/VISUAL_DIRECTION.md:
  // colder, sharper, not greyer)
  float f = mod(k, 5.0);
  int i = int(floor(f));
  float t = smoothstep(0.3, 0.7, fract(f));
  vec3 a = uPal[0], b = uPal[1];
  if (i == 0) { a = uPal[0]; b = uPal[1]; }
  else if (i == 1) { a = uPal[1]; b = uPal[2]; }
  else if (i == 2) { a = uPal[2]; b = uPal[3]; }
  else if (i == 3) { a = uPal[3]; b = uPal[4]; }
  else { a = uPal[4]; b = uPal[0]; }
  vec3 c = cmix(a, b, t);
  if (uChallenge > 0.001) {
    vec3 h = cmix(uHarsh[0], uHarsh[1], smoothstep(0.3, 0.7, 0.5 + 0.5 * cos(k * 2.4)));
    c = cmix(c, h, 0.9 * uChallenge);
  }
  return c;
}

// the accent walk: the complementary-most palette colour of each palette entry (petals, halos)
vec3 paletteC(float k) {
  float f = mod(k, 5.0);
  int i = int(floor(f));
  float t = smoothstep(0.3, 0.7, fract(f));
  vec3 a = uPalC[0], b = uPalC[1];
  if (i == 0) { a = uPalC[0]; b = uPalC[1]; }
  else if (i == 1) { a = uPalC[1]; b = uPalC[2]; }
  else if (i == 2) { a = uPalC[2]; b = uPalC[3]; }
  else if (i == 3) { a = uPalC[3]; b = uPalC[4]; }
  else { a = uPalC[4]; b = uPalC[0]; }
  vec3 c = cmix(a, b, t);
  if (uChallenge > 0.001) {
    vec3 h = cmix(uHarsh[1], uHarsh[0], smoothstep(0.3, 0.7, 0.5 + 0.5 * cos(k * 2.4)));
    c = cmix(c, h, 0.9 * uChallenge);
  }
  return c;
}

// colour c (any luminance) at relative luminance L. Out-of-gamut channels are clipped toward the
// colour's own lighter tint (white only for accents brighter than the hue can carry).
vec3 atLum(vec3 c, float L) {
  float l = max(dot(c, LUMA), 1e-4);
  c *= L / l;
  float m = max(c.r, max(c.g, c.b));
  if (m > 0.95) c = mix(vec3(L), c, (0.95 - L) / max(m - L, 1e-4));
  return max(c, 0.0);
}

// Jewel luminance: a hue that cannot carry luminance L at full chroma (blue, violet) settles darker
// (deep sapphire, amethyst) instead of washing out toward lavender: above the hue's own limit only a
// quarter of the excess luminance is kept.
float jewelCap(vec3 c) {               // luminance at which the hue's strongest channel reaches 0.6
  return 0.6 * max(dot(c, LUMA), 1e-4) / max(max(c.r, max(c.g, c.b)), 1e-4);
}
vec3 atLumJ(vec3 c, float L) {
  float Lmax = jewelCap(c);
  return atLum(c, L > Lmax ? Lmax + 0.25 * (L - Lmax) : L);
}

// Lit glass: a hue at full chroma up to the luminance where its strongest channel reaches 0.95 (violet
// ~0.12, magenta ~0.23, cyan ~0.5, yellow ~0.6); above that only 30 % of the excess is kept, so a hue
// that cannot carry the light stays a deep saturated jewel instead of turning pastel.
float glassCap(vec3 c) {
  return 0.95 * max(dot(c, LUMA), 1e-4) / max(max(c.r, max(c.g, c.b)), 1e-4);
}
float glassL(vec3 c, float L) { float cap = glassCap(c); return L > cap ? cap + 0.3 * (L - cap) : L; }
vec3 atLumG(vec3 c, float L) { return atLum(c, glassL(c, L)); }

// accent colour (filaments, pearl rims): one of the two brightest-carrying palette hues; in a difficult
// passage the acid green-cyan
vec3 accent(float u) {
  vec3 c = u > 0.5 ? uAcc[0] : uAcc[1];
  if (uChallenge > 0.001) c = cmix(c, uHarsh[0], 0.9 * uChallenge);
  return c;
}

// Fold z into the fundamental triangle of one tiling. Returns folded z; out: reflections parity,
// number of circle inversions (ring depth), conformal scale factor, and the centre of the cell (polygon)
// containing z in the tiling's own frame: the inverse of the fold applied to A = 0, tracked as an
// (anti-)Möbius matrix Q = F1⁻¹ ∘ F2⁻¹ ∘ … (q = 1 when Q conjugates its argument). The centre is fixed
// to the tiling (the Möbius motion is applied before the fold), so a smooth function of it gives every
// cell its own stable hue and brightness.
vec2 foldTri(vec2 z, vec4 tri, vec2 cen, out float parity, out float depth, out float scale, out vec2 centre) {
  float wedge = tri.x;
  float R2 = tri.w * tri.w;
  parity = 0.0; depth = 0.0; scale = 1.0;
  vec2 qa = vec2(1.0, 0.0), qb = vec2(0.0), qc = vec2(0.0), qd = vec2(1.0, 0.0);
  float q = 0.0;
  for (int i = 0; i < 32; i++) {
    float a = atan(z.y, z.x);
    if (a < 0.0) a += 2.0 * PI;
    float k = floor(a / wedge);
    if (k > 0.0) {
      float m = length(z);
      bool odd = mod(k, 2.0) >= 0.5;
      float a2 = odd ? (k + 1.0) * wedge - a : a - k * wedge;
      z = m * vec2(cos(a2), sin(a2));
      parity += k;
      // inverse: rotation by +k·wedge (even k) or the reflection itself (odd k): diag(e^{iθ}, 1)
      float th = odd ? (k + 1.0) * wedge : k * wedge;
      vec2 e = vec2(cos(th), sin(th));
      if (q > 0.5) e.y = -e.y;                                  // Q ∘ G with Q anti: conj(G)
      qa = cmul(qa, e); qc = cmul(qc, e);
      if (odd) q = 1.0 - q;
    }
    vec2 w = z - cen;
    float l2 = dot(w, w);
    if (l2 < R2) {
      z = cen + w * (R2 / l2);
      scale *= R2 / l2;
      parity += 1.0;
      depth += 1.0;
      // inversion (anti, an involution): [[c, R² − |c|²], [1, −c̄]]
      vec2 ga = cen, gb = vec2(R2 - dot(cen, cen), 0.0), gc = vec2(1.0, 0.0), gd = vec2(-cen.x, cen.y);
      if (q > 0.5) { ga.y = -ga.y; gd.y = -gd.y; }
      vec2 na = cmul(qa, ga) + cmul(qb, gc), nb = cmul(qa, gb) + cmul(qb, gd);
      vec2 nc = cmul(qc, ga) + cmul(qd, gc), nd = cmul(qc, gb) + cmul(qd, gd);
      float sN = 1.0 / max(max(length(na), length(nb)), max(length(nc), length(nd)));
      qa = na * sN; qb = nb * sN; qc = nc * sN; qd = nd * sN;
      q = 1.0 - q;
    } else if (k < 0.5) {
      break;
    }
  }
  parity = mod(parity, 2.0);
  centre = cdiv(qb, qd);
  return z;
}

// Broad-structure luminance levels (absolute, before the sheet envelope): a lit glass core and a
// darker band (the "lead") just inside the edge, ratio 2.4 (Michelson 0.41: under the §4.1 1:3 cap and
// under the limiter guard's 0.45 tile test, so rings of large cells never read as a high-contrast
// periodic pattern); thin edges and their bloom are added on top as small-area accents.
const float L_CORE = 0.29;
const float BAND_RATIO = 2.4;

// One tiling at disk point zm. `pix` = disk units per pixel; `speed` = hyperbolic units per second
// of the Möbius flow here. Returns the cell colour (linear, absolute luminance before the envelope);
// `acc` = thin-accent colour (edges + bloom halo, additive); `vis` = detail visibility (0 where cells
// are below ~2–5 px or would change faster than ~0.6 Hz).
vec3 tiling(vec2 zm, float pix, float speed, vec4 tri, vec2 cen, vec4 meta, out vec3 acc, out float vis) {
  float parity, depth, scale;
  vec2 cc;
  vec2 z = foldTri(zm, tri, cen, parity, depth, scale, cc);
  vec2 n2 = tri.yz;
  float R = tri.w;
  float px = pix * scale;                       // folded units per pixel
  float dCirc = length(z - cen) - R;            // polygon edge (circle mirror)
  float dEpx = max(dCirc, 0.0) / px;            // pixels to the cell edge
  float dS = min(z.y, -dot(z, n2)) / px;        // pixels to the nearest spoke (facet seam)
  float toEdge = clamp(length(z) / max(length(z) + dCirc, 1e-4), 0.0, 1.0);   // 0 centre .. 1 edge
  float ratio = px / max(meta.x, 1e-4);         // ~1 / cell radius in pixels
  float aa = smoothstep(0.5, 0.2, ratio);
  float freq = speed / max(meta.y, 1e-3);
  // where the flow would change the pattern faster than ~0.6 Hz at a pixel (fast rim cells) the cells
  // keep their HUE but lose their luminance structure (iso-luminant mosaic, no edges): the shrinkage stays
  // visible as glittering colour while nothing flickers in luminance; only the unresolvable (< ~2–5 px
  // or > ~2 Hz) dissolves into dust
  float calm = smoothstep(1.3, 0.7, freq);
  vis = aa * smoothstep(2.0, 1.6, freq);

  // every cell its own jewel: hue and brightness from a smooth function of the cell centre (stable under
  // the motion), invariant under the p-fold dihedral symmetry about the tiling centre, so the flower stays
  // a kaleidoscope while cells of one ring still differ (no single repeated cell → no luminance lattice)
  float ccA = mod(atan(cc.y, cc.x) + 2.0 * PI, 2.0 * tri.x);
  float ccF = abs(ccA - tri.x) / tri.x;                             // 0..1, dihedral-invariant angle
  float ccR = length(cc);
  float u1 = 0.5 + 0.5 * sin(6.1 * ccR + 2.7 * ccF + 2.0 * sin(3.3 * ccR * ccF + 1.3));
  float u2 = 0.5 + 0.5 * sin(-7.3 * ccR + 3.1 * ccF + 1.7 * sin(4.1 * ccR - 0.4));
  float hk = depth * 1.62 + 2.4 * u1 + 0.04 * uTime;
  vec3 cCell = palette(hk);
  vec3 cAcc = u2 > 0.45 ? paletteC(hk) : palette(hk + 2.5);   // accent: complementary or a palette neighbour

  // lit glass: a broad glowing core (a plateau, a little hotter at the centre) and a narrow darker band
  // just inside the edge. What is angular inside a cell (cut-gem facets, the inner petals) is mostly HUE
  // contrast at similar luminance (VISUAL_DIRECTION §1.2), with only a small luminance relief
  float big = smoothstep(0.1, 0.03, ratio);                          // 1 for cells ≥ ~33 px inradius
  float Lc = L_CORE * (0.86 + 0.28 * u2) * (1.0 - 0.2 * uChallenge);
  float Lb = Lc / BAND_RATIO;
  float glow = 1.0 - smoothstep(0.6, 0.93, toEdge);
  float L = mix(Lb, Lc * (1.07 - 0.14 * toEdge * toEdge), glow);
  // small cells (rim) flatten toward their mean: no tile-scale luminance lattice where cells are dense
  L = mix(mix(Lb, Lc, 0.62), L, mix(0.3, 1.0, big));
  L *= 1.0 - 0.12 * exp(-dS * dS / 1.5) * (1.0 - toEdge);
  // a petal on every other spoke: each cell carries a small flower in the accent hue
  float f = atan(z.y, z.x) / tri.x;                                // 0 on mirror 1 .. 1 on mirror 2
  float wP0 = 0.6 * sqrt(max(0.0, 1.0 - toEdge * toEdge * 1.15));
  float spine = 1.0 - clamp(f / max(wP0, 1e-3), 0.0, 1.0);
  float wP = wP0;                                                    // slender petals
  float fpx = (f - wP) * tri.x * length(z) / px;                   // signed distance to the petal outline, px
  float petalIn = smoothstep(1.0, -1.0, fpx) * smoothstep(0.98, 0.6, toEdge);
  float petalLine = exp(-fpx * fpx / 1.2) * smoothstep(0.98, 0.6, toEdge);
  // stained glass: the band sinks into the deep base hue (dark yellows/greens would read as olive)
  vec3 body = cmix(cCell, uDark, 0.6 * smoothstep(0.6, 0.97, toEdge));
  // (the inner petals are the accent hue itself: a 70 % mix of complementary hues read as milky lavender)
  body = cmix(cmix(body, palette(hk + 1.0), 0.2 * parity), cmix(cAcc, cCell, 0.35 * (1.0 - spine)), petalIn);   // facets: neighbour hue
  // cut-gem facets: the 2p triangles of a cell alternate ±11 % (a 2p-fold rosette round every cell centre)
  L *= (1.0 + 0.1 * petalIn * (1.0 - toEdge) + 0.11 * (2.0 * parity - 1.0)) * (1.0 - 0.15 * petalLine * (1.0 - petalIn));
  // petals are lit glass too, not flat fills: brightest along their spine (the spoke), darker toward
  // their outline and toward the cell edge
  // (the dimmer margin turns toward the cell's hue instead of just darker: a dark yellow reads as olive)
  L *= mix(1.0, (0.88 + 0.32 * spine * spine) * (1.05 - 0.2 * toEdge), petalIn);
  // the whole cell profile (core and band alike, so the glass keeps its own glow ratio) settles to what
  // its hue can carry at full chroma: violet and blue cells are deep, magenta mid, cyan and amber bright
  // (the inner petals settle to what their own hue carries: a gold petal in a violet cell glows brighter)
  // (inner petals keep only 10 % of what their hue cannot carry: deep jewel petals, never lavender)
  float capP = glassCap(cAcc);
  float kC = max(0.4, glassL(cCell, Lc) / Lc), kP = max(0.35, (Lc > capP ? capP + 0.1 * (Lc - capP) : Lc) / Lc);
  // gold / amber / cyan petals glow brighter (×1.35): yellow only reads as yellow when it is bright,
  // at the cell's luminance it read as olive
  kP *= 1.0 + 0.35 * smoothstep(0.35, 0.55, capP);
  L *= mix(kC, kP, petalIn);
  // fast cells: one common luminance for every hue (a violet cell can carry it at full chroma)
  L = mix(0.075 * (1.0 - 0.2 * uChallenge), L, mix(0.3, 1.0, calm));
  // never more than ~10 % beyond what the pixel's own hue carries: mixed hues (petal over cell) stay
  // saturated instead of clipping toward a pastel tint
  vec3 col = atLum(body, min(L, 1.1 * glassCap(body)));

  // v 9: jewels within jewels. The core of every large, slowly moving cell holds a miniature of the same
  // tiling (the cell's own Poincaré disk: the cell edge is its circle at infinity), an iso-luminant hue
  // mosaic with thin luminous seams, so the escalation from v 7.5 to v 9 is a new level of recursion
  // (fine detail at the centre, VISUAL_DIRECTION §1.5). Only where the cell passes a pixel at ≤ ~0.12 Hz,
  // so the five-times smaller inner cells stay ≤ ~0.6 Hz.
  float nest = smoothstep(0.6, 0.95, uLv) * big * smoothstep(0.66, 0.42, toEdge) * smoothstep(0.16, 0.08, freq) * (1.0 - petalLine);
  // a thin luminous rim along each inner petal (accent hue, small area)
  vec3 nestAcc = atLum(cmix(cAcc, accent(u2), 0.5), 0.2 * petalLine * big * calm);
  if (nest > 0.01) {
    float p2, d2, s2;
    vec2 c2;
    float kIn = 0.97 / max(meta.x, 1e-4);
    // (a zoom of 2.2 inside: a small central jewel ringed by shrinking ones, not one big inset)
    float r1 = min(length(z) * kIn, 0.999);
    float zr = tanh(2.2 * atanh_(r1));
    vec2 z2 = foldTri(z * (zr / max(length(z), 1e-6)), tri, cen, p2, d2, s2, c2);
    float px2 = px * kIn * s2 * (2.2 * (1.0 - zr * zr) / max(1.0 - r1 * r1, 1e-4));
    float dE2 = max(length(z2 - cen) - R, 0.0) / px2;
    float rat2 = px2 / max(meta.x, 1e-4);
    float vis2 = smoothstep(0.35, 0.15, rat2);                       // inner cells ≥ ~4 px
    float t2 = clamp(length(z2) / max(length(z2) + length(z2 - cen) - R, 1e-4), 0.0, 1.0);
    vec3 h2 = palette(hk + 1.3 + d2 * 1.62 + 0.5 * p2);
    // (each inner jewel at what its own hue carries: a gold inset glows, it never sinks to brown)
    float L2 = glassL(h2, mix(Lc, Lc / BAND_RATIO, smoothstep(0.55, 0.95, t2)));
    col = mix(col, mix(col, atLum(h2, min(L2, 1.1 * glassCap(h2))), vis2), nest);
    nestAcc += atLum(cmix(h2, accent(1.0 - u2), 0.6), 0.5 * exp(-dE2 * dE2 / 1.0) * vis2 * nest);
  }

  // thin luminous edge + bloom halo (accents). The line is in a bright-carrying accent hue (gold,
  // ice) blended with the cell's own; its strength falls with the cell size so the edge network never
  // covers a large area: full for cells ≥ ~30 px, a faint thread down to ~6 px (the shrinkage toward the
  // rim stays legible), gone below.
  float edgeVis = smoothstep(0.17 + 0.08 * uLv, 0.035, ratio);   // (more of the rim glitters at v 9)
  float lineAmt = mix(0.3, 1.0, smoothstep(0.09, 0.03, ratio));
  float wGlow = clamp(0.24 / max(ratio, 1e-3), 1.5, 8.0) * (1.0 - 0.5 * uChallenge);
  float line = exp(-dEpx * dEpx / (1.6 - 0.5 * uChallenge));
  float halo = exp(-dEpx / wGlow);
  // facet seams (the mirror spokes through the cell centre) light up near the edge; toward v 9 they
  // run all the way in: every cell becomes a star-cut gem (the visible escalation from v 7.5 to v 9)
  float seam = exp(-dS * dS / 0.8) * mix(smoothstep(0.5, 1.0, toEdge), smoothstep(0.08, 0.5, toEdge), uLv) * 0.4;
  vec3 lineCol = cmix(cCell, accent(u2), 0.6);
  float Lline = (0.74 + 0.14 * uLv + 0.06 * uChallenge) * line * lineAmt + (0.12 + 0.3 * uLv) * seam;
  // the halo (bloom) glows in the cell's own hue, a little toward the accent (an additive complementary
  // halo turned the bands milky)
  float Lhalo = (0.15 + 0.1 * uLv) * halo * (0.8 + 0.2 * uPulse) * lineAmt;
  acc = edgeVis * calm * (atLum(lineCol, Lline) + atLumG(cmix(cCell, accent(u2), 0.25), Lhalo)) + nestAcc;
  return col;
}

// Jos Leys' distance estimate to the limit set of the Maskit group a(z) = μ + 1/z, b(z) = z + 2 with
// μ = −shift + i·height (as popularised in Indra's Pearls renderings). z in strip coordinates.
float kleinDE(vec2 z, float a, float b, out float its) {
  vec2 lz = z + 1.0, llz = z - 1.0;
  float df = 1.0;
  float f = b >= 0.0 ? 1.0 : -1.0;
  its = 0.0;
  for (int i = 0; i < 48; i++) {
    z.x += b / a * z.y;
    z.x = mod(z.x + 1.0, 2.0) - 1.0;
    z.x -= b / a * z.y;
    float s = z.x + b * 0.5;
    if (z.y >= a * 0.5 + f * (2.0 * a - 1.95) / 4.0 * sign(s) * (1.0 - exp(-(7.2 - (1.95 - a) * 15.0) * abs(s)))) {
      z = vec2(-b, a) - z;
    }
    float ir = 1.0 / dot(z, z);
    z *= -ir;
    z.x = -b - z.x;
    z.y = a + z.y;
    df *= ir;
    its += 1.0;
    if (dot(z - llz, z - llz) < 1e-6) break;
    llz = lz; lz = z;
  }
  float y = min(z.y, a - z.y);
  return min(y, 0.3) / max(df, 2.0);
}

// slow angular hue variation of the dust (smooth, ≤ 3 lobes)
float u1Dust(float phi, float rd) { return 0.5 + 0.5 * sin(2.0 * phi + 3.0 * rd) * cos(phi - 1.3); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0 + uLook * vec2(0.6, 0.6);
  float rho = length(p);
  float phi = atan(p.y, p.x);
  float pxScreen = 2.0 / uRes.y;                                    // screen units per pixel

  // neural field, sampled through the retino-cortical (log-polar) map
  float fieldAct = 0.5;
  if (uHasField > 0.5) {
    vec2 fuv = vec2((log(rho + 0.05) - log(0.05)) / (log(2.2) - log(0.05)), phi / (2.0 * PI) + 0.5);
    fieldAct = texture2D(uField, fuv).r;
  }
  // the log-polar map packs the field's bands into concentric rings at the very centre ("target"):
  // the centre is the jewelled central cell, not the field
  fieldAct = mix(0.5, fieldAct, smoothstep(0.12, 0.5, rho));

  // ---- flower / dome sheet: petals scallop the outer rings, the sheet compresses towards the rim
  // petals of uneven length (±12 %), as in a real chrysanthemum, at even spacing (an uneven spacing
  // smeared the flower's single angular harmonic, which tools/gallery_checks.py reads as its radial
  // structure); with the rim sinking into the dark below, a row or column of the screen no longer
  // crosses a bright, strictly regular petal train (the limiter's pattern guard counted it as periodic)
  float phiP = phi;
  float petal = cos(uPetals * phiP * 0.5);
  float petalAmt = 0.42 * smoothstep(0.3, 0.98, rho) * (0.8 + 0.4 * uIntensity);   // deep notches: a flower outline
  float plen = 0.12 * (0.6 * sin(3.0 * phi + 0.7) + 0.4 * sin(5.0 * phi + 2.1)) * smoothstep(0.45, 0.95, rho);
  float rhoW = rho * (1.0 + petalAmt * (1.0 - sqrt(abs(petal))) - 0.04 * (fieldAct - 0.5) + plen);   // broad petals, narrow notches
  // Poincaré disk of screen radius DISK_R: cells shrink (conformally, both ways) toward the rim, where
  // they glitter and sink into the dark base; zoom > 1 makes the central cells smaller (intensity,
  // difficult passage)
  float DISK_R = uDiskR;
  float rn = min(rhoW / DISK_R, 0.99995);
  // (the zoom acts on the centre and relaxes to the plain disk toward the rim, so the shrinking cells
  // stay resolved out to the petals instead of dissolving into dust)
  // (relaxing linearly in rn keeps the cells' aspect ≤ ~2.6 for zoom ≤ 2.4 — radially elongated cells
  // in the outer flower read as petals; the old rn² relaxation stretched them into streaks (aspect > 5)
  // at the zoom needed for small central cells)
  float rd = tanh(mix(uZoom, 1.0, rn) * atanh_(rn));
  vec2 zd = rd * vec2(cos(phi), sin(phi));

  // dome + petal-fold shading: the sheet bulges towards the viewer in the middle, each petal is a
  // ridge between two folded valleys, lit from the upper left (volume, not a flat fill)
  float ridge = abs(petal);
  float fold = smoothstep(0.08, 0.7, rd);
  vec2 er = vec2(cos(phi), sin(phi)), et = vec2(-sin(phi), cos(phi));
  float dPetal = -sin(uPetals * phiP * 0.5) * sign(petal) * uPetals * 0.5;   // d|petal|/dφ
  vec2 grad = er * (-2.0 * rd * uZoom) * 0.35 + et * dPetal * fold * 0.05;
  vec3 nrm = normalize(vec3(-grad, 1.0));
  float lit = dot(nrm, normalize(vec3(-0.45, 0.55, 0.7)));
  // (the folds deepen a little with intensity; deeper folds made the 18 petals a high-contrast angular
  // train that the limiter's pattern guard counted along screen rows and columns)
  float shade = (0.74 + 0.38 * lit) * (1.0 - (0.42 + 0.08 * uLv) * fold * (1.0 - ridge * ridge)) * (1.0 + 0.1 * uLv * fold * ridge * ridge);

  // ---- Möbius motion, per tiling: groups with large cells ((4,4,4), (5,5,2)) are zoomed further
  // (meta.w) so every group shows several rings of cells shrinking toward the rim
  float atn = atanh_(rn);
  vec2 eph = vec2(cos(phi), sin(phi));
  vec2 zdA = tanh(mix(min(2.4, uZoom * uMetaA.w), 1.0, rn) * atn) * eph;
  vec2 zdB = tanh(mix(min(2.4, uZoom * uMetaB.w), 1.0, rn) * atn) * eph;
  vec2 zmA = mob(uMobAB, uMobCD, zdA), zmB = mob(uMobAB, uMobCD, zdB);
  float speedA = hdist(zmA, mob(uMobAB2, uMobCD2, zdA)) / 0.25;       // hyperbolic units per second
  float speedB = hdist(zmB, mob(uMobAB2, uMobCD2, zdB)) / 0.25;
  float pixA = max(length(dFdx(zmA)), length(dFdy(zmA))) + 1e-6;
  float pixB = max(length(dFdx(zmB)), length(dFdy(zmB))) + 1e-6;

  // ---- sheet envelope (slowly varying: ≤ ~1.3x per 100 px), coupled to the neural field
  // (and toward the circle at infinity of each petal the sheet sinks into the dark: depth, and the
  // petal tips no longer form a bright, regular scalloped train against the notches)
  float env = mix(1.0, 0.7, smoothstep(0.45, 1.0, rho / DISK_R)) * mix(1.0, 0.45, smoothstep(0.72, 1.0, rn)) * (0.85 + 0.3 * fieldAct) * shade;

  // ---- dark base: the darkest palette colour (never grey, never the palette mean)
  // (slow breathing from the neural field, ratio ≤ 2.3, so the darkness is deep but never a flat plateau)
  float Ld = mix(0.017, 0.008, smoothstep(0.9, 1.8, rho)) * (1.0 - 0.3 * uChallenge) * (0.85 + 0.3 * fieldAct);
  vec3 dark = atLum(cmix(uDark, palette(1.0 + 1.5 * rd + 0.03 * uTime), 0.25), Ld);

  // ---- the tilings (crossfade melts outward from the centre: each pixel's own transition spans 0.6
  // of the mix range, i.e. ≥ 0.4 of the 2 s crossfade (≥ 0.48 s in a difficult passage); a faint seam of
  // light rides the front)
  float m = smoothstep(0.0, 1.0, clamp((uMix - 0.4 * rd) / 0.6, 0.0, 1.0));
  // unresolved cells (the rim, fast flow) average to a glowing dust in the palette hues that dims toward
  // the circle at infinity — the mean of the detail, not a veil (outside the disk: the dark base)
  float inDisk = 1.0 - smoothstep(0.985, 1.0, rhoW / DISK_R);
  // (in the hue of the luminous rim it leads to: a coloured glow along the petal outline, not a shadow)
  vec3 rimHue = palette(3.0 + 0.6 * sin(phi * 3.0 + 0.05 * uTime));
  vec3 dustHue = cmix(palette(0.5 + 2.0 * u1Dust(phi, rd) + 0.03 * uTime), rimHue, smoothstep(0.75, 1.0, rn));
  vec3 dust = atLumG(dustHue, mix(0.075, 0.06, smoothstep(0.6, 1.0, rn)) * env * (1.0 - 0.3 * uChallenge));
  vec3 fill = mix(dark, dust + dark * 0.5, inDisk);
  vec3 accA = vec3(0.0), accB = vec3(0.0);
  vec3 tA = fill, tB = fill;
  float vA = 0.0, vB = 0.0;
  if (m < 0.999) tA = tiling(zmA, pixA, speedA, uTriA, uCenA, uMetaA, accA, vA);
  if (m > 0.001) tB = tiling(zmB, pixB, speedB, uTriB, uCenB, uMetaB, accB, vB);
  vec3 cellA = mix(fill, tA * env, vA) + accA * vA * env;
  vec3 cellB = mix(fill, tB * env, vB) + accB * vB * env;
  vec3 col = mix(cellA, cellB, m);
  // the circle at infinity: a thin luminous rim where the tiling has shrunk to dust, with a soft halo
  float rimPx = abs(rhoW - DISK_R) / pxScreen;
  float rimAmt = smoothstep(1.4, 1.0, rho) * (1.0 - uChallenge * 0.3);
  col += atLum(cmix(rimHue, accent(0.3), 0.35), (0.5 + 0.12 * uLv) * exp(-rimPx * rimPx / 1.5) * rimAmt);
  col += atLumG(rimHue, (0.09 + 0.04 * uLv) * exp(-rimPx / 9.0) * rimAmt);
  float front = 4.0 * m * (1.0 - m) * step(0.001, uMix) * step(uMix, 0.999);
  col += atLum(palette(2.0 + 2.0 * rd), 0.03 * front * env);

  // ---- Kleinian lace ring (Maskit limit set wrapped around the flower by the conformal log map):
  // the limit set as thin bright filaments with a bloom halo, its round ordinary-set components as
  // jewelled pearls, the interstices sinking to the dark base.
  if (uLace > 0.001) {
    float rho0 = 1.34 * (1.0 + 0.02 * uPulse);
    float k = uLaceN / PI;
    vec2 s = vec2(k * (phi + uLaceRot), -k * log(rho / rho0));     // strip coordinates, y=0 at rho0
    float a = uKlein.x;
    if (s.y > -0.6 && s.y < 1.5) {
      float its;
      float de = kleinDE(s, a, uKlein.y, its);
      float toPx = rho / k / pxScreen;
      float dpx = abs(de) * toPx;                                   // distance to the limit set, pixels
      // local density of the limit set (two more samples 7 px away): where it froths into a fine foam
      // (some traces, low Maskit height) its filaments would cover a large area at accent brightness, so
      // they dim there and only the sparse lace and the large pearls' rims stay brilliant
      float its2;
      vec2 o = vec2(7.0, 4.0) / toPx;
      float dA = abs(kleinDE(s + o, a, uKlein.y, its2)) * toPx;
      float dB = abs(kleinDE(s - o.yx * vec2(1.0, -1.0), a, uKlein.y, its2)) * toPx;
      float dens = (exp(-dpx / 3.0) + exp(-dA / 3.0) + exp(-dB / 3.0)) / 3.0;
      float sparse = 1.0 - 0.7 * smoothstep(0.25, 0.6, dens);
      // the outer half of the strip: the boundary circle with its string of pearls and the cusp lace
      float band = smoothstep(-0.5, 0.1, s.y) * smoothstep(1.45, 1.0, s.y);
      // the lace lies behind the flower sheet: it shows between and around the petals (depth)
      // (fades in by BRIGHTNESS, not opacity: a 20 % blend of the lace over the background read as a
      // murky grey ring at v 5)
      float amt = band * smoothstep(0.0, 0.15, uLace) * smoothstep(0.985, 1.02, rhoW / DISK_R);
      float lb = 0.3 + 0.7 * uLace;
      float lenv = exp(-0.6 * max(0.0, rho - 1.0));
      vec3 lace;
      // in the dense foam every pearl and filament takes one slowly varying hue: pixel-scale speckle of
      // many hues averaged to grey-lavender
      vec3 regionHue = palette(2.0 + 1.2 * sin(0.35 * s.x + 0.8) + 0.02 * uTime);
      float foam = 1.0 - smoothstep(0.3, 1.0, sparse);
      vec3 filHue = cmix(cmix(palette(its * 1.37 + 3.0), accent(fract(its * 0.37)), 0.5), accent(0.0), foam);
      if (de < 0.0) {
        // pearl: lit glass disc at full chroma (a hotter pole, a darker limb) with a luminous inner rim
        vec3 pc = cmix(palette(its * 1.37 + 0.5), regionHue, foam);
        float body = 1.0 - exp(-dpx / 14.0);
        // (tiny pearls of the dense foam stay dark: dots of colour in the dark, not a bright froth)
        lace = atLumG(pc, (0.03 + 0.2 * body) * lenv * mix(1.0, 0.6, 1.0 - sparse)) + atLum(filHue, (0.2 + 0.1 * uLv) * exp(-dpx / 2.5) * lenv * sparse);
      } else {
        lace = col * 0.3 + atLum(uDark, 0.015 + 0.01 * fieldAct);
      }
      float wG = 5.0 - 2.0 * uChallenge;
      vec3 fil = atLum(filHue, (0.72 + 0.12 * uLv) * exp(-dpx * dpx / 0.8) * lenv * sparse);
      vec3 glo = atLumG(filHue, (0.16 + 0.06 * uLv) * exp(-dpx / wG) * lenv * (0.85 + 0.15 * uPulse) * sparse);
      vec3 laceCol = (lace + fil + glo) * lb;
      col = mix(col, laceCol, amt);
    }
  }

  // no near-white: thin accents may reach 0.86, nothing beyond; static dither against banding
  float L1 = dot(col, LUMA);
  if (L1 > 0.86) col *= 0.86 / L1;
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * 0.5;
  gl_FragColor = vec4(max(col, 0.0), clamp(uWeight, 0.0, 1.0));
}
