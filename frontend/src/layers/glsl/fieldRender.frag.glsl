// Retino-cortical rendering of the neural field (BUILD.md 11.4): every screen pixel at (r, theta)
// from the view centre samples the cortical field at (log(r + r0), theta). Stripes along x -> rings
// and tunnels, along y -> radial funnels, oblique -> spirals, hexagons -> lattices.
// Look (docs/VISUAL_DIRECTION.md 3, "Kluever drawings in light"; NOTES D-P-form_constants-6..14):
//  * a CORE around the vanishing point (an ellipse of 0.18-0.21 x 0.20-0.23 screen heights): a
//    near-black ground in the palette's darkest colour, fat lit tubes (lattice: cells with luminous
//    rims) with a thin brilliant crest line on every ridge that feeds a separable bloom;
//  * a dark jewelled ANNULUS outside it: violet-black troughs (the palette's darkest colour); every band
//    a lit tube whose luminance peaks on its centre-line (body shoulders -> centre-line glow -> thin crest
//    line, all inside the broad-pattern ratio); hue cycling through the jewel palette with log
//    eccentricity (stained glass, depth cue); a finer filament layer (contour lines of the field at 3x
//    the cortical frequency) inside the tubes; a parallax mid-ground (the field at a larger scale, offset
//    with the view) tinting the troughs; lattices as a honeycomb of cells with luminous rims over a dark
//    inner gradient; sparse sparks (short incandescent arcs riding the crest lines) feeding the bloom.
// Output: rgb = LINEAR colour, a = luminance of the BLOOM FEED (core crests and bodies, sparks, star).
// SAFETY AT SOURCE (BUILD.md 4.1, NOTES D-P-form_constants-6 / -11):
//  * soft edges (the field is Gaussian-smoothed, edge width > 2 cells), anti-aliased (the pattern fades
//    to a calm level where a wavelength covers fewer than ~4 px), drift <= 0.3 Hz (TS side);
//  * outside the core the whole periodic structure (troughs, bodies, centre-lines, crest lines, rims,
//    filaments) has luminance in [To, To * Ro] with Ro <= 2.35 (Michelson <= 0.40) and To >= uTFloor;
//    the local ratio is tied to an exact upper bound of the envelope within a radius uWin (0.33 screen
//    heights = the diagonal of flashcheck's 160x180-px blocks, > the limiter guard's 5x5-tile window):
//    Ro = min(uRatio, uWinC env / envMax), so ANY two points of such a window keep brightest / darkest
//    <= uWinC = 2.6 (Michelson 0.44); tested on the CPU replica (neuralField.ts annulusPlan);
//    hue and chroma (which carry no luminance contrast) do the rest;
//  * the high-contrast core is bounded (< 9 % of a 16:9 screen, inside flashcheck's four central blocks);
//  * only APERIODIC accents (sparks gated by co-moving 3-D value noise, the central star) exceed the
//    window elsewhere, and they are sparse outside the guard footprint of the core.
in vec2 vUv;
uniform sampler2D uField;
uniform float uAspect;
uniform vec2 uCentre;          // view centre offset (mouse look), screen units
uniform float uR0;
uniform float uX0;             // log r at field x = 0
uniform float uScale;          // radial scale (challenge: tunnel narrows)
uniform float uPxH;            // scene height in pixels
uniform float uLambda;         // wavelength (cells)
uniform vec3 uCols[6];         // linear palette colours for the tube bodies (cyclic order)
uniform int uNCols;
uniform float uBright;         // pulse factor (multiplicative, common: contrast unchanged)
uniform float uHueShift;       // slow palette walk (0-1)
uniform float uChallenge;
uniform float uDepth;          // 0-1 from visual intensity (3 -> 9)
uniform vec3 uAccent;          // filament colour
uniform vec3 uAccent2;         // second filament colour
uniform vec3 uDeep;            // the palette's darkest colour (trough / ground)
uniform vec3 uMidC;            // mid-ground tint (a second dark palette hue)
uniform vec3 uGlintC;          // spark colour (brightest chromatic palette colour)
uniform vec3 uGlintC2;         // second spark colour
uniform vec3 uCrestC;          // crest colour (brightest palette colour)
uniform vec2 uDrift;           // field drift (cells), so the sparks ride with the pattern
uniform float uTime;           // field time (s)
uniform float uLattice;        // 0-1 hexagon weight (honeycomb cells with luminous rims)
uniform float uGlintL;         // spark peak luminance
uniform float uGlintTh;        // spark noise threshold (lower = more sparks)
uniform float uCoreL;          // central star luminance
uniform float uCyc;            // hue cycles per unit log eccentricity (stained-glass bands)
uniform float uFilig;          // filament layer strength (0-1)
uniform float uMid;            // mid-ground strength (0-1)
uniform float uDustMax;        // nebula dust: at most this x the trough (<= Ro)
// luminance plan (linear relative luminance)
uniform float uB0;             // centre-line luminance of the lit annulus (inside uEnvR.x)
uniform float uRatio;          // centre-line / trough ratio of the lit annulus where the envelope is flat
uniform float uTFloor;         // trough floor of the lit pattern
uniform vec2 uEnvR;            // depth envelope: log-gradient ramps 0 -> uK2 between these radii (screen heights)
uniform float uK2;             // final log-gradient (per screen height)
uniform vec3 uLight;           // side light: (direction angle, log depth a: lit / dark side = e^(2a), unused)
uniform float uWin;            // window radial extent the ratio is guaranteed over (screen heights)
uniform float uWinC;           // max/min guaranteed over any such window
uniform float uCoreTrough;     // core: trough luminance (near-black)
uniform float uCoreBody;       // core: tube-body luminance
uniform vec2 uCoreR;           // core zone: full inside uCoreR.x, none beyond uCoreR.y (screen heights)
uniform float uCrestL;         // crest-line luminance (core)
uniform float uCrestW;         // crest-line half width (px)
out vec4 outColor;

const float TAU_ = 6.2831853;

// cyclic walk through the body colours (s in [0, 1), wraps without a hard edge)
vec3 cycleCol(float s) {
  float n = float(uNCols);
  float x = fract(s) * n;
  int i = int(floor(x));
  int j = i + 1 >= uNCols ? 0 : i + 1;
  vec3 a = uCols[0], b = uCols[0];
  for (int k = 0; k < 6; k++) { if (k == i) a = uCols[k]; if (k == j) b = uCols[k]; }
  return mix(a, b, smoothstep(0.15, 0.85, x - float(i)));
}

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// colour c at luminance L (desaturated at constant L where out of gamut)
vec3 atLum(vec3 c, float L) {
  vec3 col = c * (L / max(lum(c), 1e-4));
  float m = max(col.r, max(col.g, col.b));
  if (m > 1.0) col = mix(col, vec3(L), (m - 1.0) / max(m - L, 1e-4));
  return col;
}

// hue rotation about the grey axis (Rodrigues), luminance restored by the caller via atLum/vivid
vec3 hueRot(vec3 c, float t) {
  const vec3 k = vec3(0.57735);
  float cs = cos(t), sn = sin(t);
  return max(vec3(0.0), c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs));
}

// chroma at constant luminance: s = 0 grey, s = 1 the gamut edge along the colour's own hue (one
// channel at 0); s in between scales the chroma. Saturated red is kept below the red-flash share
// (R / (R+G+B) < 0.8) with a touch of blue (crimson, docs/VISUAL_DIRECTION.md 2).
vec3 vivid(vec3 c, float s) {
  float l = lum(c);
  vec3 d = c - vec3(l);
  float neg = max(max(-d.r, -d.g), -d.b);
  float pos = max(max(d.r, d.g), d.b);
  float kmax = min(neg > 1e-6 ? l / neg : 1e3, pos > 1e-6 ? (1.0 - l) / pos : 1e3);
  // near-grey input has no reliable hue (a mix of complementary colours, or half-float noise): amplify
  // it only a little, so no pixel-to-pixel hue speckle appears
  float cr = max(pos, neg) / max(l, 1e-4);
  vec3 o = vec3(l) + d * min(kmax, mix(1.0, 6.0, smoothstep(0.04, 0.3, cr))) * s;
  float sum = o.r + o.g + o.b;
  if (o.r > 0.75 * sum) { o.b += (o.r - 0.75 * sum) * 0.8; o *= l / max(lum(o), 1e-5); }
  return max(o, vec3(0.0));
}

// value noise on a lattice periodic in y with period py (the angle wraps), smooth in t
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p, float py) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, py), y1 = mod(i.y + 1.0, py);
  float n000 = h3(vec3(i.x, y0, i.z)), n100 = h3(vec3(i.x + 1.0, y0, i.z));
  float n010 = h3(vec3(i.x, y1, i.z)), n110 = h3(vec3(i.x + 1.0, y1, i.z));
  float n001 = h3(vec3(i.x, y0, i.z + 1.0)), n101 = h3(vec3(i.x + 1.0, y0, i.z + 1.0));
  float n011 = h3(vec3(i.x, y1, i.z + 1.0)), n111 = h3(vec3(i.x + 1.0, y1, i.z + 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

// |grad| of 0.5 + 0.5 tanh(k u / 0.8) per cortical cell at texture coordinate t (central differences)
float shAt(vec2 t, float k) { return 0.5 + 0.5 * tanh(k * texture(uField, t).g / 0.8); }
float gradPx(vec2 t, float h, float k) {
  vec2 dx = vec2(h / float(FIELD_N), 0.0), dy = vec2(0.0, h / float(FIELD_N));
  return length(vec2(shAt(t + dx, k) - shAt(t - dx, k), shAt(t + dy, k) - shAt(t - dy, k))) / (2.0 * h);
}

// log of the aperiodic illumination envelope at screen position ps (screen heights from the view
// centre): a radial depth falloff and a side light whose direction turns slowly
float lnEnvR(float rs) {
  float xr = clamp((rs - uEnvR.x) / (uEnvR.y - uEnvR.x), 0.0, 1.0);
  return uK2 * (uEnvR.y - uEnvR.x) * 0.5 * xr * xr + uK2 * max(0.0, rs - uEnvR.y);
}
float lnEnv(vec2 ps) {
  float rs = length(ps);
  float ca = dot(ps, vec2(cos(uLight.x), sin(uLight.x))) / max(rs, 1e-4);
  return -lnEnvR(rs) - uLight.y * (1.0 - ca) * smoothstep(0.12, 0.45, rs);
}
// exact upper bound of lnEnv over the disc of radius w around ps: the radial term is largest at the
// smallest radius, the light term smallest at the smallest radius and the angle closest to the light
float lnEnvMax(vec2 ps, float w) {
  float rs = length(ps);
  float r0 = max(rs - w, 0.0);
  if (rs <= w) return -lnEnvR(0.0);
  float phi = acos(clamp(dot(ps, vec2(cos(uLight.x), sin(uLight.x))) / rs, -1.0, 1.0));
  float caMax = cos(max(0.0, phi - asin(w / rs)));
  return -lnEnvR(r0) - uLight.y * (1.0 - caMax) * smoothstep(0.12, 0.45, r0);
}

// field coordinate of screen point p (screen heights, view-centred, radial scale applied)
vec2 cortical(vec2 p) {
  float r = length(p) + 1e-5;
  return vec2((log(r + uR0) - uX0) / TAU_, atan(p.y, p.x) / TAU_);
}

void main() {
  vec2 p0 = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 p = (p0 - uCentre) * uScale;
  float r = length(p) + 1e-5;
  float rs = r / uScale;                                  // screen heights from the view centre
  float lx = log(r + uR0);
  vec2 fc = cortical(p);
  vec4 fld = texture(uField, fc);
  // footprint of one screen pixel in cells (conformal map: same along x and y)
  float cellsPerPx = float(FIELD_N) / TAU_ * uScale / (uPxH * (r + uR0));
  float resolve = 1.0 - smoothstep(uLambda / 6.0, uLambda / 3.0, cellsPerPx);
  float filRes = 1.0 - smoothstep(uLambda / 16.0, uLambda / 9.0, cellsPerPx);   // >= ~12 px per band
  float bandPx = uLambda / cellsPerPx;                    // one band period in px
  float lat = uLattice;
  float ch = uChallenge;

  // ---- field shape ----
  float sh = 0.5 + 0.5 * tanh(mix(0.0, fld.g, resolve) / 0.8);
  // ridge and valley lines of the raw field u from its Hessian: across a ridge (lattice: around a cell
  // centre) u ~ u0 - k d^2 / 2 along the most negative curvature direction, so the distance to the ridge
  // line is |grad u . v| / |lambda| (cells); valleys (the walls between lattice cells) likewise along the
  // most positive curvature direction
  const float HC = 1.5;
  vec2 ex = vec2(HC / float(FIELD_N), 0.0), ey = vec2(0.0, HC / float(FIELD_N));
  float u0 = fld.g;
  float uLx = texture(uField, fc - ex).g, uRx = texture(uField, fc + ex).g;
  float uDy = texture(uField, fc - ey).g, uUy = texture(uField, fc + ey).g;
  float uXY = (texture(uField, fc + ex + ey).g - texture(uField, fc + ex - ey).g
             - texture(uField, fc - ex + ey).g + texture(uField, fc - ex - ey).g) / (4.0 * HC * HC);
  vec2 gu = vec2(uRx - uLx, uUy - uDy) / (2.0 * HC);
  float uXX = (uLx + uRx - 2.0 * u0) / (HC * HC), uYY = (uDy + uUy - 2.0 * u0) / (HC * HC);
  float hm = 0.5 * (uXX + uYY), hd = sqrt(max(0.25 * (uXX - uYY) * (uXX - uYY) + uXY * uXY, 0.0));
  float lHi = hm + hd, lLo = hm - hd;                      // principal curvatures
  vec2 vHi = abs(uXY) > 1e-7 ? normalize(vec2(uXY, lHi - uXX)) : (uXX >= uYY ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 vLo = vec2(-vHi.y, vHi.x);
  float dCells = abs(dot(gu, vLo)) / max(-lLo, 1e-5);     // to the ridge line (cells)
  float dCr = dCells / cellsPerPx;                        // px
  float qd = dCells / uLambda;                            // periods
  float onRidge = step(0.0, -lLo) * smoothstep(0.5, 0.7, sh) * resolve;
  float dV = abs(dot(gu, vHi)) / max(lHi, 1e-5) / cellsPerPx;   // px to the valley line
  float onValley = step(0.0, lHi) * (1.0 - smoothstep(0.35, 0.55, sh)) * resolve;
  // isoline helper (gradient of the soft profile in px)
  float fw = max(gradPx(fc, 1.0, resolve) * cellsPerPx, 1e-5);

  // ---- band profile e (0 trough .. 1 brightest), shared by annulus and core ----
  // a lit tube: a dim body, a broad glow peaking on the centre-line and the thin crest line on top
  // (sharper and narrower in a difficult passage: lines, not fills)
  float body = pow(smoothstep(mix(0.42, 0.5, ch), mix(0.9, 0.85, ch), sh), mix(1.4, 2.6, ch));
  float glow = exp(-pow(qd / mix(0.11, 0.07, ch), 2.0)) * onRidge;
  float crest = (1.0 - smoothstep(uCrestW, uCrestW + 1.0, dCr)) * onRidge * filRes;
  // annulus: a neon line (about 2 px) with a soft halo, the band body only faintly lit around it
  float ridgeGate = step(0.0, -lLo) * smoothstep(0.42, 0.62, sh) * resolve;
  float line2 = (1.0 - smoothstep(uCrestW + 0.4, uCrestW + 1.6, dCr)) * ridgeGate * filRes;
  float halo = exp(-dCr / mix(2.5, 4.0, uDepth)) * ridgeGate;
  // lattices: a honeycomb of cells (the basins of the field's maxima) separated by thin dark walls (its
  // valley lines); each cell has a thin luminous rim just inside its wall over a dark inner gradient
  // (darkest at the cell centre); the triple points are darkest
  float lineOk = filRes * smoothstep(0.3, 0.12, fw);
  float wall = (1.0 - smoothstep(0.5, 1.3, dV)) * onValley;
  float rimW = mix(2.0, 3.0, uDepth);
  float rim = smoothstep(0.6, 1.4, dV) * (1.0 - smoothstep(rimW, rimW + 1.6, dV)) * onValley * lineOk;
  float cellGrad = mix(0.36, 0.04, smoothstep(0.1, 0.9, sh));
  float eLat = max(cellGrad * (1.0 - wall), rim);
  // finer filament layer: nested contour lines of the field inside every tube (lattice: concentric
  // rings inside every cell), the engraved multiple outlines of the Kluever drawings; more with intensity
  float fil3 = 0.0;
  for (int k = 0; k < 4; k++) {
    float lev = k == 0 ? 0.47 : (k == 1 ? 0.66 : (k == 2 ? 0.57 : 0.76));
    if (k >= 2 && uDepth < 0.35 + 0.3 * float(k - 2)) break;
    fil3 = max(fil3, 1.0 - smoothstep(0.55, 1.4, abs(sh - lev) / fw));
  }
  fil3 *= lineOk * uFilig * (1.0 - smoothstep(0.0, 0.5, crest)) * (1.0 - lat);
  // the trough is a shadow between two glowing tubes: darkest midway, lighter toward the tubes
  float shade = 0.28 * pow(smoothstep(0.06, 0.5, sh), 1.5);
  float eBand = max(shade, 0.3 * body + 0.25 * mix(glow, halo, filRes));
  eBand = mix(eBand, 1.0, mix(glow, line2, filRes));       // the neon line on top
  float e = mix(eBand, eLat, lat);
  e = max(e, mix(0.72, 0.55, lat) * fil3);
  e = mix(e, 0.3, 1.0 - resolve);                         // unresolved fovea: a calm low level

  // ---- luminance plan (aperiodic, radial) ----
  // core: near-black ground, bright tubes / cells, crest lines (slightly elliptical: taller than wide,
  // so it stays inside flashcheck's four central blocks)
  float rsc = length(vec2(p.x, p.y * 0.9) / uScale);
  float cz = 1.0 - smoothstep(uCoreR.x, uCoreR.y, rsc);
  // lit annulus: centre-lines at uB0 x envelope over troughs at centre-line / Ro; Ro tied to an upper
  // bound of the envelope within uWin so that ANY window of extent <= uWin keeps max / min <= uWinC
  vec2 ps = p / uScale;
  float le = lnEnv(ps);
  float leMax = lnEnvMax(ps, uWin);
  float Bo = uB0 * exp(le);
  float Ro = min(uRatio, uWinC * exp(le - leMax));
  float To = max(Bo / Ro, uTFloor);
  Bo = max(Bo, To);
  float La = To * pow(Bo / To, e);                        // log interpolation: soft valleys
  // core: fat lit tubes with narrow near-black gaps, a glow along the ridge, the crest line on top
  float eCoreBand = pow(smoothstep(mix(0.04, 0.3, ch), mix(0.4, 0.8, ch), sh), mix(0.7, 2.2, ch)) * mix(0.85, 1.0, glow);
  float eCoreLat = mix(0.6, 0.18, smoothstep(0.3, 0.92, sh)) * (1.0 - wall);
  float eCore = mix(eCoreBand, eCoreLat, lat);
  eCore = max(eCore, 0.85 * fil3);
  float Lc = mix(uCoreTrough, uCoreBody * mix(1.0, 0.5, ch), eCore);
  float L = mix(La, Lc, cz);

  // ---- colour (hue and chroma; the luminance is set from the plan) ----
  // depth cue: the band colour cycles through the jewel palette with log eccentricity (stained glass)
  // and drifts in time; the hue turns slightly across each tube (iridescence)
  float cyc = uCyc * lx + uHueShift;
  vec3 bodyC = cycleCol(cyc);
  bodyC = hueRot(bodyC, (0.25 + 0.3 * uDepth) * (0.5 - max(glow, line2)) * (1.0 - lat));
  // centre-line / crest: the hot partner of the band colour (the next palette colour), at full chroma
  vec3 crestC = cycleCol(cyc + 0.5 / float(uNCols));
  // troughs: the palette's darkest colour at low chroma (violet-black); the parallax mid-ground (the
  // field at 0.6x the scale, offset only 0.45x with the view: a deeper, out-of-focus layer) tints them
  // in a second, cool palette hue (iso-luminant: it adds no luminance structure)
  vec2 pm = (p0 - 0.45 * uCentre) * uScale * 0.6;
  vec2 fm = cortical(pm) + vec2(0.31, 0.17 + 0.004 * uTime);
  float shm = 0.5 + 0.5 * tanh(texture(uField, fm).g / 0.8);
  float mid = smoothstep(0.62, 0.95, shm) * uMid * (1.0 - lat);
  float neb = vnoise(vec3(fc.x * 9.0, fc.y * 12.0, uTime * 0.03), 12.0);
  // aperiodic nebula in the troughs (screen-space value noise, two octaves, slow): dust lit by the tunnel,
  // luminance inside the window (<= uDustMax x the trough, <= Ro)
  vec2 nq = ps * 3.5 + vec2(0.0, 0.01 * uTime);
  float neb2 = 0.65 * vnoise(vec3(nq, 0.05 * uTime), 1e4) + 0.35 * vnoise(vec3(nq * 2.7 + 3.1, 0.07 * uTime), 1e4);
  float dust = 0.6 * smoothstep(0.4, 0.9, neb2) * (1.0 - smoothstep(0.1, 0.35, e)) * (1.0 - lat) * (1.0 - ch);
  La = max(La, To * mix(1.0, min(uDustMax, Ro), dust));
  vec3 trC = mix(uDeep, uMidC, clamp(0.8 * mid + 0.5 * dust + 0.1 * (neb - 0.5), 0.0, 1.0));
  float trSat = mix(0.28, 0.5, max(mid, dust)) * (1.0 - 0.6 * ch);
  L = mix(La, Lc, cz);
  // element weights
  // colour follows the light: the dim flanks of a tube stay near the violet-black ground, only its lit
  // part takes the jewel colour at full chroma (light in colour on a dark ground, not a coloured fill)
  float lit = smoothstep(0.08, 0.55, mix(e, eCore, cz));
  float toBody = mix(max(smoothstep(0.1, 0.5, body), max(glow, halo)), 1.0 - wall, lat) * mix(lit, 1.0, 0.25);
  // annulus tubes: a cool flank (the band colour pulled toward the cool mid-ground colour) around a hot
  // neon line in the band colour; contour filaments in the partner colour
  vec3 flankC = mix(bodyC, mix(uMidC, bodyC, 0.3), (1.0 - cz) * (1.0 - lat));
  vec3 c = mix(trC, flankC, toBody);
  float sat = mix(trSat, mix(0.86, 0.98, uDepth), toBody);
  float crW = mix(max(glow * 0.5, max(crest, line2)), rim, lat);
  c = mix(c, mix(crestC, bodyC, (1.0 - cz) * (1.0 - lat)), crW);
  // lattice: each cell darkens toward its centre (the violet-black ground) and takes the cool mid-ground
  // colour toward its rim; the rims in the cycling band colour
  float cg = pow(smoothstep(0.04, 0.36, cellGrad), 1.3);
  c = mix(c, mix(mix(uDeep, mix(uMidC, bodyC, 0.25), cg), bodyC, rim), lat * (1.0 - cz) * (1.0 - wall));
  sat = mix(sat, mix(mix(0.3, 0.78, cg), 1.0, rim), lat * (1.0 - cz) * (1.0 - wall) * (1.0 - ch));
  sat = mix(sat, 1.0, crW);
  vec3 filC = mix(crestC, mix(uAccent, uAccent2, 0.5), 0.25 * cz);  // partner colour
  c = mix(c, filC, fil3);
  sat = mix(sat, 0.95, fil3);
  // core ground: the deep colour (near-black)
  c = mix(c, mix(uDeep, c, smoothstep(0.03, 0.25, eCore)), cz);
  // difficult passage (docs/VISUAL_DIRECTION.md 3): two acidic complementary colours on a near-black
  // ground, carried by thin lines (narrow tubes, crest lines, filaments), never brighter
  const vec3 acidA = vec3(1.0, 0.0, 0.55), acidB = vec3(0.45, 1.0, 0.0);
  // (annulus: magenta neon lines and green contour filaments / lattice rims; core: magenta tubes with
  // acid-green crest lines; cold blue-black ground)
  float gW = max(fil3, lat * rim);
  // (the green is a spring / phosphor green where it is dark: a lime turns olive at line luminance)
  vec3 acidG = mix(vec3(0.0, 1.0, 0.3), acidB, cz);
  vec3 acidC = mix(acidA, acidG, smoothstep(0.2, 0.6, gW) * (1.0 - smoothstep(0.3, 0.7, crW * (1.0 - lat))));
  float acidW = max(max(0.15 * smoothstep(0.4, 0.85, body) * (1.0 - lat), crW), gW);
  vec3 coldGround = mix(uDeep, vec3(0.015, 0.025, 0.06), 0.6);
  c = mix(c, mix(coldGround, acidC, acidW), 0.92 * ch);
  sat = mix(sat, mix(0.25, 1.0, acidW), ch);
  vec3 col = vivid(atLum(c, L), sat);
  // core crest lines in the brightest palette colour tinted by the band (acid green in a passage)
  float LcC = max(uCrestL * cz, L);
  vec3 crC = mix(mix(uCrestC, crestC, 0.35), acidB, ch);
  float crestCore = mix(crest, rim, lat) * cz;
  col = mix(col, vivid(atLum(crC, LcC), 0.9), crestCore);

  // ---- aperiodic accents (small area, slow): sparks = short incandescent arcs riding the crest lines
  // (lattice: the rims), gated by 3-D value noise co-moving with the pattern ----
  vec2 q = fc * float(FIELD_N) - uDrift;
  float gs = uLambda * 0.8;
  float py = floor(float(FIELD_N) / gs + 0.5);
  float n = vnoise(vec3(q.x / gs, q.y * py / float(FIELD_N), uTime * 0.12), py);
  // sparks gather around the core (whose guard footprint is high-contrast anyway); few travel outside
  float th0 = uGlintTh + (0.2 + 0.06 * lat) * smoothstep(0.22, 0.32, rs) + 0.08 * (1.0 - smoothstep(0.04, 0.09, rs));
  float gm = smoothstep(th0, th0 + 0.035, n) * filRes;
  float onLine = max(mix(1.0 - smoothstep(uCrestW + 0.3, uCrestW + 1.6, dCr), rim, lat) * mix(onRidge, 1.0, lat), 0.0);
  float spark = gm * onLine;
  float sparkL = uGlintL * spark;
  vec3 spC = mix(mix(uGlintC, uGlintC2, step(0.5, fract(n * 7.0))), acidB, ch);
  // the light at the end of the tunnel: one small soft star at the view centre (a lattice has no
  // vanishing point, so only a faint one)
  float centre = exp(-pow(rs / 0.014, 2.0)) * (1.0 - 0.85 * lat);
  vec3 lightC = mix(uGlintC, vec3(1.0), 0.6 * exp(-pow(rs / 0.01, 2.0)));
  col = mix(col, vivid(atLum(spC, max(sparkL, L)), 0.95), step(1e-4, sparkL) * smoothstep(0.0, 0.3, spark));
  col += atLum(lightC, uCoreL * centre);
  col *= uBright;
  // bloom feed: core crest lines and the bright part of the core bodies, sparks, the central star
  float feed = crestCore * LcC + 0.35 * cz * max(Lc - 0.2, 0.0) + sparkL + 0.1 * uCoreL * centre;
  outColor = vec4(col, feed * uBright);
}
