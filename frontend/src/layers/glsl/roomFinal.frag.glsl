// Room layer: final composite into the scene target. Requires NOISE_GLSL and fieldSample.glsl.
// Eyes open: the graded room plus the bloom of its glowing edges (alpha of uRoom = emission, read from
// the mip chain: a cheap wide blur). As the eyes close the room fades into the phosphene field
// (BUILD.md 11.3, docs/VISUAL_DIRECTION.md §3): a near-black base, the neural field drawn as a lace of
// lit tubes and thin contour lines whose hue runs between two palette colours along the field value,
// lit from behind by large, soft, slowly drifting blooms in which the lace's crest lines glow, plus
// sparse sparks inside the blooms.
// Safety at source (BUILD.md 4.1, NOTES D-P-room-r2): the lace is PERIODIC, so outside the blooms its
// luminance stays within L_FLOOR … L_FLOOR·LACE_RATIO (2.2:1, Michelson 0.375); the blooms are APERIODIC
// (jittered random sites, organic outlines, 8–20 s lives, ≤ 0.07 Hz) and LARGE and smooth (σ 50–120 px):
// every analysis window that sees a bloom's bright part is dominated by its low-frequency energy, so the
// lace inside a bloom is not a pattern for the SafetyLimiter's guard nor for flashcheck's block FFT.
// Sparks sit only inside blooms for the same reason (a spark on the bare lace flags its 5×5-tile
// neighbourhood as a high-contrast pattern). Then the layer weight (the room is replaced by v = 7.5).
// Opaque: overwrites the scene target (NOTES S4: room is the first layer).
varying vec2 vUv;
uniform sampler2D uRoom;
uniform float uEyes;
uniform float uWeight;
uniform float uFade;         // fade-in once the room textures are ready
uniform sampler2D uField;
uniform float uHasField;
uniform float uFxTime;
uniform float uPhosHz;
uniform float uViewAspect;
uniform float uPx;           // one pixel in units of the screen height
uniform float uPhos;         // phosphene strength 0-1 (rises with v)
uniform float uPhosHi;       // 0-1, rises over v 4 → 9: more and brighter blooms
uniform float uPulse;
uniform float uChallenge;
uniform float uBloom;
uniform vec3 uBloomCol;
uniform vec3 uStops[4];      // jewel stops (dark → bright), linear RGB
uniform vec3 uAcid[2];
uniform vec3 uBase;          // the palette's darkest colour
uniform vec3 uPhosCol[2];    // the field's two colours (roomGeometry.ts phospheneColours)
uniform float uZoom;         // radial tunnel flow: offset along the cortical x (log eccentricity) axis
uniform float uTunnel;       // field sampling scale (> 1 narrows the tunnel)
uniform float uDebug;
uniform float uFold;         // 0-1 (v 6.5 → 9.5): the central form-constant tunnel opens in the room
uniform float uRings;        // radial (log-eccentricity) frequency multiplier: tighter rings in a passage

const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
const float PI = 3.14159265359;
// luminance budget of the periodic lace (linear). The floor is NOT vignetted (the vignette and the
// strength scale only the lace's amplitude above it), so no block of bare lace exceeds the ratio.
const float L_FLOOR = 0.014;
const float LACE_RATIO = 2.4;

float fieldAt(vec2 p) {
  if (uHasField > 0.5) {
    vec2 uv = fieldUV(p * uTunnel);   // fieldSample.glsl (form-constant map)
    uv.x = uv.x * uRings - uZoom;     // uRings > 1: tighter rings (a passage); rings stream slowly outward
    return texture2D(uField, uv).r;
  }
  // before the neural field exists: slow drifting phosphene clouds
  float a = hs_fbm3(vec3(p * 1.6, uFxTime * uPhosHz));
  float b = hs_snoise3(vec3(p * 4.0 + 3.0, uFxTime * uPhosHz * 1.3));
  return clamp(0.5 + 0.55 * a + 0.12 * b, 0.0, 1.0);
}

// colour normalised to luminance l (so the luminance budget is exact whatever the hue)
vec3 atLum(vec3 c, float l) { return c / max(dot(c, LUMW), 1e-4) * l; }
vec3 unitMax(vec3 c) { return c / max(c.r, max(c.g, c.b)); }
const mat3 YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ_INV = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
// a → b through the hue circle (YIQ chroma plane: lerp of unit hue vectors and of the chroma), never
// through grey as an RGB mix of complementaries would; result normalised to max channel 1
vec3 hueMix(vec3 a, vec3 b, float t) {
  vec3 ya = YIQ * unitMax(a), yb = YIQ * unitMax(b);
  float ma = length(ya.yz) / max(ya.x, 1e-4), mb = length(yb.yz) / max(yb.x, 1e-4);
  vec2 d = mix(ya.yz / max(length(ya.yz), 1e-5), yb.yz / max(length(yb.yz), 1e-5), t);
  float dl = length(d);
  d = dl > 1e-3 ? d / dl : vec2(0.0, 1.0);   // exact opposites: turn through violet
  float y = mix(ya.x, yb.x, t);
  return unitMax(max(YIQ_INV * vec3(y, d * mix(ma, mb, t) * y), 0.0) + 1e-4);
}

// Large soft blooms at random sites of a jittered grid (cells 0.5 screen heights; about 2 in 3 occupied
// at v 9), drifting slowly, each living 8–20 s (≤ 0.07 Hz) with an organic, noise-wobbled outline.
// Returns the summed bloom strength.
float blooms(vec2 p) {
  float cell = 0.42;
  // a passage gathers the light toward the centre (the tunnel narrows): the grid is compressed
  vec2 gp = (p * (1.0 + 0.8 * uChallenge) + vec2(0.011, 0.006) * uFxTime) / cell;
  vec2 gi = floor(gp);
  float occ = mix(0.55 + 0.25 * uPhosHi, 0.9, uChallenge);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = gi + vec2(float(i), float(j));
    vec4 hh = vec4(hs_hash12(c + 7.7), hs_hash12(c + 29.1), hs_hash12(c + 51.3), hs_hash12(c + 83.9));
    if (hh.x > occ) continue;
    vec2 site = c + 0.2 + 0.6 * hs_hash22(c + 13.1);
    vec2 d = (gp - site) * cell;                          // screen-height units
    float sig = (0.06 + 0.07 * hh.y) * (0.8 + 0.2 * uPhosHi) * (1.0 + 0.3 * uChallenge);
    float r = length(d);
    if (r > 4.0 * sig) continue;
    float an = atan(d.y, d.x);
    float wob = 1.0 + 0.28 * hs_snoise3(vec3(1.3 * cos(an) + 9.0 * hh.z, 1.3 * sin(an), uFxTime * 0.04 + hh.w * 7.0));
    // a difficult passage turns the soft blooms into angular shards (a triangle's support distance)
    float rot = hh.z * 6.2832 + uFxTime * 0.05;
    float tri = 0.0;
    for (int k = 0; k < 3; k++) {
      float ak = rot + float(k) * 2.0944;
      tri = max(tri, dot(d, vec2(cos(ak), sin(ak))));
    }
    float rr = mix(r * wob, 1.6 * tri, uChallenge);
    float life = fract(uFxTime * (0.05 + 0.07 * hh.w) / 1.6 + hh.z);
    float env = smoothstep(0.0, 0.35, life) * smoothstep(1.0, 0.65, life);
    float q = rr / sig;
    // shards have a harder edge (super-Gaussian) than the soft blooms
    float g = env * exp(-0.5 * pow(q, mix(2.0, 4.0, uChallenge)));
    acc += g;
  }
  return min(acc, 1.2);
}

vec3 phosphenes(vec2 p) {
  float h = 1.5 * uPx;
  float a0 = fieldAt(p);
  float ax = fieldAt(p + vec2(h, 0.0));
  float ay = fieldAt(p + vec2(0.0, h));
  vec2 g = vec2(ax - a0, ay - a0) / h;                 // per screen-height unit
  // local pattern amplitude (mean |a - 0.5| over a ring): normalises weak and strong fields alike
  float e = abs(a0 - 0.5);
  for (int i = 0; i < 6; i++) {
    float an = float(i) * 1.0471976 + 0.2;
    e += abs(fieldAt(p + 0.045 * vec2(cos(an), sin(an))) - 0.5);
  }
  e /= 7.0;
  float amp = max(e * 1.6, 0.035);
  float n = (a0 - 0.5) / amp;                          // ~ -1 … 1
  float present = smoothstep(0.012, 0.06, e) * (0.45 + 0.55 * uPhos);
  // contour lines at two levels of the normalised activity: thin, anti-aliased (distance in pixels)
  float gpx = max(length(g) * uPx, 1e-5);              // activity change per pixel
  float sharp = mix(1.0, 0.6, uChallenge);
  float d1 = abs(a0 - (0.5 + 0.35 * amp)) / gpx;
  float d2 = abs(a0 - (0.5 + 0.85 * amp)) / gpx;
  float core = max(exp(-d1 * d1 / (1.3 * sharp)), 0.7 * exp(-d2 * d2 / (1.1 * sharp)));
  float halo = exp(-d1 / (5.0 * sharp));               // the line's own soft glow
  // finer than ~5 px per field period the lines would alias: fade them into the fill
  float resolved = 1.0 - smoothstep(0.3, 0.7, gpx / amp);   // ≳ 10 px per period
  core *= resolved; halo *= resolved;
  // a lit tube, brightest along the crest (a passage: thinner tubes, more black between them)
  float fill = pow(smoothstep(-0.35, 1.1, n), 1.6 + 2.4 * uChallenge);

  // ---- colour: two palette colours; the hue runs between them along the field value (troughs in B,
  // crests in A) through the hue circle (never through grey), and regions swap them over a soft,
  // iso-luminant gradient
  float sel = smoothstep(-0.45, 0.45, hs_snoise3(vec3(p * 0.7, uFxTime * uPhosHz * 0.6 + 5.0)));
  vec3 cA = hueMix(uPhosCol[0], uPhosCol[1], sel);
  vec3 cB = hueMix(uPhosCol[1], uPhosCol[0], sel);
  // difficult passage: two acid complementaries on black (cyan against magenta), colder, sharper
  cA = mix(cA, unitMax(uAcid[0]), uChallenge);
  cB = mix(cB, unitMax(uAcid[1]), uChallenge);
  float hv = smoothstep(-0.3, 0.3, n);
  vec3 lace = hueMix(cB, cA, hv);

  // ---- blooms: soft, large, aperiodic light behind the lace
  float bl = blooms(p);
  float gain = mix(14.0, 24.0, uPhosHi) * (0.6 + 0.4 * uPhos) * (1.0 + 2.6 * uChallenge);
  // a passage narrows the tunnel: the light closes in toward the centre
  float vig = smoothstep(1.3, 0.2, length(p)) * mix(1.0, smoothstep(0.95, 0.3, length(p)), uChallenge);
  float breath = 0.94 + 0.06 * uPulse;
  float inBloom = smoothstep(0.03, 0.5, bl);

  // filigree: finer contour levels and a second octave of the field (twice the cortical frequency),
  // dim in the bare lace (inside its luminance ratio), glowing where a bloom lights it
  float fil = 0.0;
  {
    for (int k = 0; k < 3; k++) {
      float lv = -0.55 + 0.45 * float(k);
      float dk = abs(a0 - (0.5 + lv * amp)) / gpx;
      fil = max(fil, exp(-dk * dk / 0.8));
    }
    vec2 rs = vec2(2.0 * uRings, 2.0), of = vec2(-2.0 * uZoom, 0.37);
    float b0 = texture2D(uField, fieldUV(p * uTunnel) * rs + of).r;
    float bx = texture2D(uField, fieldUV((p + vec2(h, 0.0)) * uTunnel) * rs + of).r;
    float by = texture2D(uField, fieldUV((p + vec2(0.0, h)) * uTunnel) * rs + of).r;
    float g2 = max(length(vec2(bx - b0, by - b0)), 1e-5);
    float db = abs(b0 - 0.5 - 0.3 * amp) / g2;
    float res2 = 1.0 - smoothstep(0.45, 1.0, g2 / amp);
    fil = max(fil * 0.7 * resolved, 0.55 * exp(-db * db / 0.7) * res2);
  }
  // bare lace: floor … floor·LACE_RATIO; the brighter of fill and line wins (never adds beyond the ratio)
  float floorL = L_FLOOR * (1.0 - 0.6 * uChallenge);   // a passage: true black base (~0.006)
  float lx = (LACE_RATIO - 1.0) * max(max(0.8 * fill, core), 0.6 * fil) * present * vig * breath;
  float lum = floorL * (1.0 + lx);
  // blooms light the lace from behind (multiplicative: the lace keeps its own ratio inside)
  lum *= 1.0 + bl * gain * mix(1.0, vig, uChallenge);
  vec3 col = atLum(lace, lum);

  // crest lines glow inside the blooms (additive, with their halo); a passage breaks them into arcs
  vec2 dirp = p / max(length(p), 1e-4);
  float broken = mix(1.0, smoothstep(-0.25, 0.0, hs_snoise3(vec3(dirp * 2.6, log(length(p) + 0.02) * 3.0 + uFxTime * 0.25))), uChallenge);
  float crest = (0.62 * core + mix(0.16, 0.05, uChallenge) * halo) * inBloom * present * broken;
  float lumLine = (crest + 0.45 * fil * inBloom * present * broken) * mix(0.45, 0.85, uPhosHi) * (1.0 + 0.3 * uChallenge);
  // the line takes the colour of the band it lies on, heated toward white at the core
  vec3 lineCol = mix(hueMix(cB, cA, smoothstep(-0.6, 0.0, n)), vec3(1.0), 0.3 * core);
  col += atLum(lineCol, lumLine);

  // ---- sparks: pin-point cores with a halo and a four-point glint, only inside blooms
  float cell = 0.085;
  vec2 gp = p / cell;
  vec2 gi = floor(gp);
  float occ = 0.2 + 0.2 * uPhos;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = gi + vec2(float(i), float(j));
    vec4 hh = vec4(hs_hash12(c + 17.0), hs_hash12(c + 41.3), hs_hash12(c + 73.9), hs_hash12(c + 97.1));
    if (hh.x > occ) continue;
    vec2 site = c + 0.15 + 0.7 * hs_hash22(c + 3.1);
    vec2 dv = (gp - site) * cell / uPx;                // pixels
    float r2 = dot(dv, dv);
    if (r2 > 1600.0) continue;
    float life = fract(uFxTime * (0.08 + 0.09 * hh.y) + hh.z);
    float env = pow(sin(PI * life), 2.0);
    vec2 sp = p - dv * uPx;
    float k = env * smoothstep(0.15, 0.6, blooms(sp)) * present;
    if (k < 0.003) continue;
    vec3 sc = unitMax(hh.w < 0.5 ? cA : cB);
    float r = sqrt(r2);
    vec2 ad = abs(dv);
    float glint = exp(-ad.x / 10.0) * exp(-ad.y * ad.y / 0.9) + exp(-ad.y / 10.0) * exp(-ad.x * ad.x / 0.9);
    float s = 0.9 * exp(-r2 / 3.5) + 0.06 * exp(-r / 5.0) + 0.25 * glint * smoothstep(18.0, 5.0, r);
    if (uChallenge > 0.01) {
      // a passage: dissonant angular fragments (chevrons, 1-px arms) instead of round sparks
      float ang = hh.y * 6.2832;
      vec2 ax = vec2(cos(ang), sin(ang));
      vec2 lc = vec2(dot(dv, ax), dot(dv, vec2(-ax.y, ax.x)));
      lc.y = abs(lc.y);
      vec2 arm = vec2(0.82, 0.57);                     // ±35° arms, 16 px long
      float t = clamp(dot(lc, arm), 0.0, 16.0);
      float dd = length(lc - arm * t);
      float chev = 0.75 * exp(-dd * dd / 0.6) + 0.08 * exp(-dd / 3.0);
      s = mix(s, chev * smoothstep(17.0, 12.0, t + 0.5 * dd), uChallenge);
    }
    col += mix(sc, vec3(1.0), 0.4 - 0.25 * uChallenge) * s * k;
  }
  if (uDebug > 0.5) col = vec3(bl * 0.5);
  return col;
}


// Eyes open, v ≳ 7: the form-constant tunnel opens in the middle of the room (the room folds into it).
// The field's rings (log-polar: a tunnel) streaming outward, dark troughs, lit tubes and bright thin crest
// lines, lit by the light at the end of the tunnel (a smooth, steep radial glow: the analysis windows that
// see the rings are dominated by its low-frequency energy, so the guard does not count them as a
// pattern), feathered into the room. Returns rgb (premultiplied) and coverage.
vec4 tunnel(vec2 p) {
  float r = length(p);
  float R = (0.07 + 0.16 * uFold);
  float cover = smoothstep(R, 0.55 * R, r) * smoothstep(0.0, 0.25, uFold);
  if (cover < 0.002) return vec4(0.0);
  float h = 1.5 * uPx;
  float a0 = fieldAt(p);
  float ax = fieldAt(p + vec2(h, 0.0));
  float ay = fieldAt(p + vec2(0.0, h));
  float gpx = max(length(vec2(ax - a0, ay - a0)) / h * uPx, 1e-5);
  float d1 = abs(a0 - 0.62) / gpx;
  float line = exp(-d1 * d1 / 1.2) * (1.0 - smoothstep(0.08, 0.2, gpx / 0.4));
  float tube = smoothstep(0.3, 0.75, a0);
  float glow = exp(-r / (0.035 + 0.03 * uFold));                 // the light at the end of the tunnel
  float lum = 0.02 * (1.0 + 1.3 * tube) * (1.0 + 9.0 * glow) + line * (0.25 + 0.35 * uFold) * (0.4 + 0.6 * smoothstep(1.0, 0.4, r / R));
  float hpos = smoothstep(0.0, 1.0, r / R);
  vec3 cIn = unitMax(uStops[2]), cOut = unitMax(uStops[1]);   // never the yellow stop: it reads olive when dim
  vec3 c = hueMix(cIn, cOut, hpos);
  c = mix(c, unitMax(uAcid[0]), uChallenge);
  vec3 lc = mix(cIn, vec3(1.0), 0.3 * line);
  vec3 col = atLum(c, 0.02 * (1.0 + 1.3 * tube) * (1.0 + 9.0 * glow)) + atLum(lc, lum - 0.02 * (1.0 + 1.3 * tube) * (1.0 + 9.0 * glow));
  return vec4(col, cover);
}

void main() {
  vec4 rs = uEyes < 0.999 ? texture2D(uRoom, vUv) : vec4(0.0);
  vec3 room = rs.rgb;
  if (uBloom > 0.002 && uEyes < 0.999) {
    float em = 0.45 * textureLod(uRoom, vUv, 2.0).a + 0.35 * textureLod(uRoom, vUv, 3.5).a + 0.3 * textureLod(uRoom, vUv, 5.0).a;
    room += uBloomCol * em * uBloom * 0.5;
  }
  if (uFold > 0.002 && uEyes < 0.999) {
    vec4 tn = tunnel((vUv - 0.5) * vec2(uViewAspect, 1.0));
    room = mix(room, tn.rgb, tn.a);
  }
  vec3 col = room;
  if (uEyes > 0.001) {
    vec2 p = (vUv - 0.5) * vec2(uViewAspect, 1.0);
    col = mix(room, phosphenes(p), smoothstep(0.0, 1.0, uEyes));
  }
  gl_FragColor = vec4(col * uWeight * uFade, 1.0);
}
