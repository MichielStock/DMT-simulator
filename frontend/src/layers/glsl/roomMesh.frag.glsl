// Room layer: surface shading of the displaced room (BUILD.md 11.3). Requires NOISE_GLSL (layers/noise.ts).
// Drifting: texture coordinates advected by a curl-noise flow (roomFlow.frag.glsl).
// Breathing: a slow texture-space swell. Symmetrical texture repetition: wallpaper-group folding in
// texture space, masked to where the neural field (state.fieldTexture) is active. Colour
// (docs/VISUAL_DIRECTION.md): a highlight shoulder (the window rolls off instead of blowing out), tone
// deepening (dark base, luminous highlights), saturation, a slight hue rotation, a luminance-preserving
// gradient map onto the trip palette ("jewel"), chromatic fringes on edges and luminous edge auras, all
// rising with v. Writes LINEAR RGB; alpha = glow emission (bloomed in roomFinal.frag.glsl).
// No luminance modulation over time.
varying vec2 vUv;
varying float vDepth;
uniform sampler2D uImage;
uniform float uImgAspect;
uniform float uFxTime;
uniform float uPulse;
uniform float uWarp;
uniform float uDrift;
uniform sampler2D uFlow;     // advected texture-coordinate offsets (roomFlow.frag.glsl), image uv units
uniform float uTile;
uniform float uTileScale;
uniform vec2 uTileOrigin;
uniform int uGroup;          // 0 pmm, 1 p4m, 2 p6m (roomGeometry.ts WALLPAPER_GROUPS)
uniform float uSat;
uniform float uHue;
uniform float uHueHz;
uniform float uPalette;      // jewel mapping amount
uniform vec3 uStops[4];       // jewel stops, linear RGB, sorted by luminance (roomGeometry.ts jewelStops)
uniform vec3 uAcid[2];        // difficult passage: two acidic complementaries
uniform vec3 uPatchCol[2];    // the phosphene pair (roomGeometry.ts phospheneColours), unit max
uniform float uBrightPos;     // jewel position of the brightest-capable stop (2 or 3; room.ts)
uniform float uDeep;
uniform float uShoulder;
uniform float uFringe;
uniform float uGlow;
uniform float uPhoto;         // 1 for a user photo / panorama (dense detail), 0 for the procedural room
uniform float uChallenge;
uniform float uFold;         // 0-1, rises over v 6.5 → 9.5: the room folds (roomEffects.fold)
uniform sampler2D uField;
uniform float uHasField;
uniform float uMaskHz;
uniform vec2 uResolution;
uniform float uViewAspect;
uniform float uKind;

const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;

vec2 toImg(vec2 q) { return vec2(q.x / uImgAspect, q.y); }

// Neural-field activity at a screen position (centred, units of the screen height), through the same
// retino-cortical map as the form constants (fieldSample.glsl: x = log eccentricity, y = angle).
float fieldAt(vec2 p) { return texture(uField, fieldUV(p)).r; }

// Where the field is ACTIVE: local pattern energy (mean |a - 0.5| over a small disc; the uniform,
// sub-threshold field sits at a = 0.5), times slow large-scale blobs so the repetition appears in
// patches. Before the neural field exists, the blobs alone.
float roomField(vec2 p, out float blob) {
  blob = 0.5 + 0.5 * hs_fbm3(vec3(p * 1.1, uFxTime * uMaskHz));
  float patches = smoothstep(0.5, 0.8, blob);
  if (uHasField < 0.5) return patches;
  // two rings of taps: a wide, smooth estimate of local pattern energy (no domain-wall cracks)
  float e = 0.0;
  for (int i = 0; i < 6; i++) {
    float an = float(i) * 1.0471976 + 0.3;
    e += abs(fieldAt(p + 0.06 * vec2(cos(an), sin(an))) - 0.5);
    e += abs(fieldAt(p + 0.13 * vec2(cos(an + 0.52), sin(an + 0.52))) - 0.5);
  }
  e = e / 12.0 * 2.0;
  return clamp(smoothstep(0.1, 0.5, e) * patches * 1.2, 0.0, 1.0);
}

float tri1(float x) { return abs(x - floor(x + 0.5)); }

vec2 foldWallpaper(vec2 g, out vec2 centre) {
  centre = vec2(0.0);
  if (uGroup == 2) {
    // p6m: hexagonal lattice a1 = (1,0), a2 = (1/2, sqrt3/2); D6 fold about the nearest centre
    const float RY = 1.7320508;
    vec2 a = vec2(floor(g.x + 0.5), floor(g.y / RY + 0.5) * RY);
    vec2 b = vec2(floor(g.x) + 0.5, floor((g.y - RY * 0.5) / RY + 0.5) * RY + RY * 0.5);
    centre = dot(g - a, g - a) <= dot(g - b, g - b) ? a : b;
    vec2 l = g - centre;
    float r = length(l);
    float th = atan(l.y, l.x);
    const float W = 1.04719755;
    th = th - W * floor(th / W);
    if (th > W * 0.5) th = W - th;
    return vec2(cos(th), sin(th)) * r;
  }
  vec2 f = vec2(tri1(g.x), tri1(g.y));
  if (uGroup == 1 && f.y > f.x) f = f.yx;
  return f;
}

// explicit gradients from the unfolded coordinates: folds and flow offsets must not change the mip level
vec2 gQx, gQy;
vec3 img(vec2 q) { return textureGrad(uImage, toImg(q), toImg(gQx), toImg(gQy)).rgb; }

// one repetition lattice: every cell of a 2x2-cell block repeats (by the wallpaper fold) the motif at
// the block centre; `off` shifts the block grid by whole cells
float gTsc = 0.1;   // repetition cell size in use (uTileScale, finer toward the centre as the room folds)
vec3 tiledAt(vec2 g, vec2 off, vec2 fold, vec2 shift) {
  vec2 block = floor((g - off) * 0.5) * 2.0 + 1.0 + off;
  return img(uTileOrigin + (block + fold) * gTsc + shift);
}

// four block lattices offset by one cell, blended near block edges: seamless repetition
vec3 tiledSample(vec2 q, vec2 shift) {
  vec2 g = (q - uTileOrigin) / gTsc;
  vec2 centre;
  vec2 fold = foldWallpaper(g, centre);
  vec2 fr = fract(g * 0.5);
  vec2 b0 = min(fr, 1.0 - fr);
  vec2 w0 = smoothstep(0.12, 0.3, b0);
  vec2 w1 = 1.0 - w0;
  vec3 c = vec3(0.0);
  if (w0.x * w0.y > 0.001) c += w0.x * w0.y * tiledAt(g, vec2(0.0, 0.0), fold, shift);
  if (w1.x * w0.y > 0.001) c += w1.x * w0.y * tiledAt(g, vec2(1.0, 0.0), fold, shift);
  if (w0.x * w1.y > 0.001) c += w0.x * w1.y * tiledAt(g, vec2(0.0, 1.0), fold, shift);
  if (w1.x * w1.y > 0.001) c += w1.x * w1.y * tiledAt(g, vec2(1.0, 1.0), fold, shift);
  return c;
}

// Safety at source (BUILD.md 4.1): the repetition makes the texture PERIODIC, so its contrast is
// compressed in the log domain towards the local mean (input clamped to 0.012–0.6, 50:1; exponent 0.18
// makes that 2.02:1). Hue contrast (the jewel map) is kept.
vec3 compressContrast(vec3 c, float m, float g) {
  float y = max(dot(c, LUMW), 1e-4);
  float y2 = m * pow(clamp(y, 0.012, 0.6) / m, g);   // ≤ 50:1 in → ≤ 2.8:1 out
  return c * (y2 / y);
}

vec3 hueRotate(vec3 c, float a) {
  // rotation about the grey axis in YIQ
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c;
  float cs = cos(a), sn = sin(a);
  yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
  return toRGB * yiq;
}

float gExposure = 1.0;        // the image's global mean luminance is brought toward 0.2 as v rises

// Tone. Highlight shoulder (knee 0.24; 0.8 → ~0.45: the window rolls off, never blows out), then a
// LOCAL deepening: the pixel is scaled by (local mean / 0.42)^(0.8 · deep), the local mean read from a
// wide blur of the image (mips), so dark regions sink toward the 0.01–0.1 base while each region's own
// texture keeps its contrast (a per-pixel gamma would raise the contrast of bookshelves and other
// near-periodic photo content toward the SafetyLimiter's pattern guard), plus a mild local gamma
// (1.1 on photos, 1.45 on the procedural room, which has no periodic detail).
float gLocal = 0.1;           // local mean luminance of the image at this pixel (set in main)
float shoulderY(float y) {
  float k = 0.24;
  float ys = y > k ? k + (y - k) / (1.0 + (y - k) / 0.32) : y;
  return mix(y, ys, uShoulder);
}
float toneY(float y) {
  y = shoulderY(y * gExposure);
  float lm = max(shoulderY(gLocal * gExposure), 1e-3);
  float local = pow(clamp(y / lm, 0.05, 20.0), mix(0.45, 0.1, uPhoto) * uDeep);
  return y * local * pow(clamp(lm / 0.42, 1e-3, 1.6), 0.8 * uDeep);
}

// chroma × s with a gamut guard (scale the chroma down rather than clip, so luminance is kept)
vec3 saturateKeepLum(vec3 c, float s) {
  float y = dot(c, LUMW);
  vec3 d = (c - y) * s;
  float mn = min(d.r, min(d.g, d.b));
  float mx = max(d.r, max(d.g, d.b));
  float k = 1.0;
  if (mn < 0.0) k = min(k, y / max(-mn, 1e-5));
  if (mx > 0.0) k = min(k, (1.0 - y) / max(mx, 1e-5));
  return y + d * clamp(k, 0.0, 1.0);
}

const mat3 YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ_INV = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);

// Move the hue (and chroma) of c toward j by t, in polar YIQ, keeping c's Y: no muddy RGB mixtures
// (brown + pink is dusty rose; rotating brown's hue to pink keeps it saturated). j's chroma is taken
// relative to its own Y, so a dark pixel gets the stop's saturation, not its absolute chroma.
vec3 hueToward(vec3 c, vec3 j, float t) {
  vec3 a = YIQ * c, b = YIQ * j;
  float ma = length(a.yz), mb = length(b.yz) * (a.x / max(b.x, 1e-4));
  // direction: lerp of the unit hue vectors (continuous in space, unlike a shortest-path angle, which
  // flips where two hues are nearly opposite); magnitude: lerp of the chromas (never through grey)
  vec2 da = ma > 1e-5 ? a.yz / ma : vec2(0.0);
  vec2 db = length(b.yz) > 1e-5 ? normalize(b.yz) : vec2(0.0);
  // a near-grey pixel has no hue of its own to keep (its hue is noise: white turned green on the way
  // from cream to cyan), so its vote fades with its relative chroma
  vec2 d = mix(da * smoothstep(0.0, 0.06, ma / max(a.x, 1e-3)), db, t);
  float dl = length(d);
  d = dl > 1e-4 ? d / dl : db;
  float m = mix(ma, mb, t);
  return max(YIQ_INV * vec3(a.x, m * d), 0.0);
}

float gWhite = 0.0;           // luminance jewelAt had to add as white (its stop could not carry it)
// jewel colour at a position 0..3 along the stops: between two stops the hue turns (polar YIQ), it is
// never an RGB mixture (pink + cyan would be a grey lavender); `edge` sets how crisp the change is.
vec3 jewelAt(float pos, float y, float edge) {
  pos = clamp(pos, 0.0, 3.0);
  float i = floor(pos);
  float f = smoothstep(0.5 - edge, 0.5 + edge, pos - i);
  vec3 a = uStops[0], b = uStops[1];
  if (i >= 2.5) { a = uStops[3]; b = uStops[3]; }
  else if (i >= 1.5) { a = uStops[2]; b = uStops[3]; }
  else if (i >= 0.5) { a = uStops[1]; b = uStops[2]; }
  vec3 pc = hueToward(a, b, f);
  pc *= mix(1.0, dot(b, LUMW) / max(dot(a, LUMW), 1e-4), f);
  // difficult passage: two acidic complementaries instead of the palette
  pc = mix(pc, fract(pos * 0.5 + 0.25) < 0.5 ? uAcid[0] : uAcid[1], uChallenge);
  float l = max(dot(pc, LUMW), 1e-4);
  float s = y / l;
  float mxc = max(pc.r, max(pc.g, pc.b));
  float k = min(s, 1.0 / max(mxc, 1e-4));
  // whatever the stop cannot carry in its own hue is added as white (rare: very bright pixels)
  gWhite = max(y - l * k, 0.0);
  return pc * k + vec3(gWhite);
}

// how much a colour reads as mud: dark yellow, orange, olive (YIQ hue -1.9 … 0.1 rad), chromatic enough
// to show, while the grade is saturating
float mudAmount(vec3 c) {
  vec3 yq = YIQ * c;
  float hang = atan(yq.z, yq.y);                      // yellow ≈ -0.77 rad, orange ≈ -0.1, olive ≈ -1.5
  return (1.0 - smoothstep(0.75, 1.05, abs(hang + 0.85))) * (1.0 - smoothstep(0.1, 0.35, dot(c, LUMW)))
       * smoothstep(0.01, 0.04, length(yq.yz)) * smoothstep(0.05, 0.3, uSat - 1.0);
}

// the full grade of a room colour; `field` and `hw` shift the jewel map (colour flows with the field).
vec3 grade(vec3 c, float field, float hw, float jewelAmt) {
  float y = max(dot(c, LUMW), 1e-5);
  float yt = toneY(y);
  c *= yt / y;
  c = saturateKeepLum(c, uSat);
  c = max(hueRotate(c, uHue * (0.35 + 0.65 * hw) + uHue * 0.5 * (field - 0.5)), 0.0);
  // mud guard: dark yellows, oranges and olives read as brown/khaki, so those (and only those) are
  // pulled harder toward the palette's hue
  float mud = mudAmount(c);
  // fully: a partial turn from olive toward an opposite stop passes through brown
  jewelAmt = max(jewelAmt, smoothstep(0.0, 0.6, mud));
  if (jewelAmt < 0.002) return c;
  // palette washes: the target hue drifts slowly across the room (hw, the field); a mild luminance
  // term keeps dark → the palette's deep stops, bright → its bright stops (never dark yellow = mud).
  // Not keyed hard on luminance: that posterises shading and wallpaper into blotches.
  float pos = 1.4 + 0.45 * log(yt / 0.1) / 2.3 + 1.1 * hw + 0.7 * (field - 0.5);
  pos = min(pos, 1.7 + 5.0 * yt);   // the brightest stop (often yellow) only where the room is bright
  float yc = dot(c, LUMW);
  vec3 j = jewelAt(pos, yc, 0.45);
  // a bright pixel whose target stop cannot carry its luminance in full chroma (a dark blue scaled up
  // needs white added: the pale lavender window) takes the brightest capable stop instead, fully
  float pale = smoothstep(0.0, 0.5, gWhite / max(yc, 1e-4));
  if (pale > 0.001) {
    j = mix(j, jewelAt(uBrightPos, yc, 0.45), pale);
    jewelAmt = max(jewelAmt, pale * min(1.0, 2.0 * uPalette));
  }
  c = hueToward(c, j, jewelAmt);
  // a partial turn between near-opposite hues (sage green → magenta) passes through orange: whatever
  // lands in the mud band now goes the rest of the way to the palette colour
  c = hueToward(c, j, smoothstep(0.0, 0.5, mudAmount(c)));
  // bright areas (the window, lamps): chroma pushed to the gamut edge at their luminance, so the
  // brightest part of the room glows in the palette's bright colour instead of a pale plateau
  float vv = smoothstep(0.1, 0.3, dot(c, LUMW)) * clamp(jewelAmt * 1.6, 0.0, 1.0);
  // (and every jewelled colour a little more chroma: deep jewel tones rather than dusky mauve)
  return saturateKeepLum(c, 1.0 + 0.6 * jewelAmt + 1.4 * vv);
}

void main() {
  vec2 sp = (gl_FragCoord.xy / uResolution - 0.5) * vec2(uViewAspect, 1.0);
  // global mean of the room image (top mip): bright photos come down, dim ones up, as v rises
  float gMean = max(dot(textureLod(uImage, vec2(0.5), 16.0).rgb, LUMW), 0.01);
  gExposure = mix(1.0, clamp(0.2 / gMean, 0.55, 1.5), 0.8 * uDeep);
  float blob;
  float field = roomField(sp, blob);
  float t = uFxTime;
  vec2 q = vec2(vUv.x * uImgAspect, vUv.y);
  gQx = dFdx(q);
  gQy = dFdy(q);
  float sc = uKind > 0.5 ? 2.5 : 1.0;   // panorama: features per unit of the wider texture

  // the field gently gates where things move most (coupling rule)
  float gate = 0.6 + 0.8 * field;
  // texture-space breathing swell
  vec2 w = vec2(hs_snoise3(vec3(q * 2.2 * sc, t * 0.06)), hs_snoise3(vec3(q * 2.2 * sc + 7.3, t * 0.06)));
  vec2 swell = w * uWarp * 0.011 * (1.0 + 2.2 * uFold) * (0.6 + 0.4 * uPulse) * gate;
  // the room folds (v ≳ 7): a slow twist of the room about the centre of view, breathing (≤ 0.05 Hz)
  if (uFold > 0.002) {
    float rr2 = dot(sp, sp);
    float th = uFold * 0.2 * exp(-rr2 / 0.16) * (0.8 + 0.2 * sin(6.2831853 * 0.05 * t));
    vec2 dpix = vec2(-sp.y, sp.x) * th * uResolution.y;
    swell += gQx * dpix.x + gQy * dpix.y;
  }
  // drifting: texture coordinates advected by the curl-noise flow (offsets from roomFlow.frag.glsl)
  vec2 off = texture(uFlow, vUv).xy;
  vec2 drift = vec2(off.x * uImgAspect, off.y) * uDrift * gate;
  vec2 q2 = q + swell - drift;
  vec3 col = img(q2);
  gLocal = 0.5 * dot(textureLod(uImage, toImg(q2), 4.5).rgb, LUMW) + 0.5 * dot(textureLod(uImage, toImg(q2), 6.0).rgb, LUMW);

  // chromatic fringes: red and blue sampled a few pixels apart along the screen radius (lens-like,
  // strongest towards the rim); only visible on edges, the flat areas are unchanged
  if (uFringe > 0.002) {
    vec2 dir = sp / max(length(sp), 1e-3);
    float px = uFringe * (0.8 + 4.5 * length(sp)) * (1.0 + 1.2 * uFold);
    vec2 dq = (gQx * dir.x + gQy * dir.y) * px;
    col.r = img(q2 + dq).r;
    col.b = img(q2 - dq).b;
    // the room folds: edges multiply into chromatic echoes (two displaced copies, added only where
    // they are brighter than the pixel, i.e. on edges; flat areas are unchanged)
    if (uFold > 0.002) {
      float y0 = dot(col, LUMW);
      vec3 e1 = img(q2 + 3.5 * dq), e2 = img(q2 - 3.5 * dq);
      vec3 t1 = uStops[2] / max(uStops[2].r, max(uStops[2].g, uStops[2].b));
      vec3 t2 = uStops[1] / max(uStops[1].r, max(uStops[1].g, uStops[1].b));
      col += uFold * 0.7 * (t1 * max(dot(e1, LUMW) - y0, 0.0) + t2 * max(dot(e2, LUMW) - y0, 0.0));
    }
  }

  float hw = hs_snoise3(vec3(sp * 0.8, t * uHueHz));
  // the room keeps its own hues (saturated, rotated); the palette shows through gently
  float jewelRoom = min(1.0, uPalette * (0.95 + 0.25 * field));
  col = grade(col, field, hw, jewelRoom);

  // luminous edge auras: strong edges of the (coarsely blurred) room glow in the palette's bright
  // stop. Aperiodic room edges, thin, small area; their emission goes to alpha for the bloom.
  float emit = 0.0;
  if (uGlow > 0.002) {
    // footprint ~6 px on the procedural room (only room-scale edges: window, picture, skirting), ~3.5 px
    // and a stricter threshold on photos (dense detail)
    float eo = mix(2.5, 1.6, uPhoto), fp = mix(6.0, 3.5, uPhoto);
    vec2 ex = gQx * eo, ey = gQy * eo;
    vec2 bx = gQx * fp, by = gQy * fp;
    float l1 = log(dot(textureGrad(uImage, toImg(q2 + ex), toImg(bx), toImg(by)).rgb, LUMW) + 0.03);
    float l2 = log(dot(textureGrad(uImage, toImg(q2 - ex), toImg(bx), toImg(by)).rgb, LUMW) + 0.03);
    float l3 = log(dot(textureGrad(uImage, toImg(q2 + ey), toImg(bx), toImg(by)).rgb, LUMW) + 0.03);
    float l4 = log(dot(textureGrad(uImage, toImg(q2 - ey), toImg(bx), toImg(by)).rgb, LUMW) + 0.03);
    float e = length(vec2(l1 - l2, l3 - l4));
    float line = smoothstep(mix(0.25, 0.45, uPhoto), mix(0.8, 1.1, uPhoto), e);
    line *= mix(1.0, line, uPhoto);
    // edges light up where the field is active (patches drifting over the room), not everywhere: a
    // detailed photo would otherwise turn into a neon outline drawing
    float fg = mix(1.0, smoothstep(0.15, 0.65, field) * (0.35 + 0.65 * smoothstep(0.35, 0.7, blob)), uPhoto);
    // the jewel stops, not the brightest one (often yellow: ochre on a dark wall)
    vec3 acc = mix(uStops[2], uStops[1], smoothstep(-0.4, 0.4, hw));
    acc = mix(acc, uAcid[0], uChallenge);
    acc /= max(acc.r, max(acc.g, acc.b));
    emit = line * uGlow * fg;
    col += acc * emit * 0.55 * (1.0 - 0.6 * smoothstep(0.2, 0.6, dot(col, LUMW)));
  }

  // symmetrical texture repetition, masked to where the field is active (denser toward the centre as the
  // room folds at the highest intensities)
  float rC = length(sp);
  float ann = uFold * smoothstep(0.44, 0.26, rC) * smoothstep(0.1, 0.22, rC);   // the folding annulus round the tunnel
  float tileAmt = uTile * clamp(field + 0.6 * ann, 0.0, 1.0);
  if (tileAmt > 0.002) {
    // feathered patch edge (over ~10-25 px of the field mask) with a soft glowing band instead of a hard
    // outline: the patches are field-driven blobs (aperiodic), their glow goes to the bloom
    float tm = smoothstep(0.3, 0.55, tileAmt);
    float dpx = (tileAmt - 0.36) / max(fwidth(tileAmt), 1e-4);      // pixels from the patch's glowing edge
    float band = exp(-dpx * dpx / 18.0) * smoothstep(0.35, 0.6, uTile);
    float m0 = max(dot(textureLod(uImage, toImg(q), 5.0).rgb, LUMW), 0.02);
    // local mean after the grade, held in the dark-jewel window 0.05–0.12
    float m = clamp(toneY(m0) * 0.75, 0.05, 0.12);
    // finer cells toward the centre as the room folds (v ≳ 7)
    // (a panorama's texture spans 360°: cells 2.5× smaller in texture units, as for the noise)
    float tsc = uTileScale / sc * mix(1.0, 0.55 + 0.45 * smoothstep(0.05, 0.55, rC), uFold);
    gTsc = tsc;
    vec2 gg = (q2 - uTileOrigin) / tsc;
    vec2 cc;
    vec2 fd = foldWallpaper(gg, cc);
    float pxc = max(length(gQx), length(gQy)) / tsc;   // one pixel in cell units
    // the folded room texture, compressed hard (periodic: it modulates, ≤ 2.1:1), keeps the patch a
    // kaleidoscope of the room rather than a sticker
    vec3 tex = grade(tiledSample(q2, -0.5 * drift), field, hw, 0.0);
    float tcr = clamp(dot(tex, LUMW) / max(toneY(m0), 1e-3), 0.3, 3.0);
    // self-luminous rosette about the fold's lattice point: lit ridges with dark troughs, breathing with
    // the field (≤ 0.04 Hz), plus thin crest lines on every ridge and on the kaleidoscope's mirror lines
    float ph = 2.6 * length(fd) + 0.35 * field + 0.25 * hw + 0.03 * t;
    float ridge = 0.5 + 0.5 * cos(6.2831853 * ph);
    float lumB = m * pow(tcr, 0.3) * pow(0.6 + 0.8 * pow(ridge, 1.4), 0.8);
    float dRidge = abs(fract(ph + 0.5) - 0.5) / 2.6 / pxc;           // pixels to the nearest crest
    float res = 1.0 - smoothstep(0.08, 0.16, 2.6 * pxc);             // ≥ ~8 px per ring
    float crestL = exp(-dRidge * dRidge / 1.1) * res;
    float mirror;
    if (uGroup == 2) {
      float r = length(fd), th = atan(fd.y, fd.x);
      mirror = min(abs(fd.y), r * sin(max(0.5235988 - th, 0.0)));
    } else {
      mirror = min(min(fd.x, fd.y), min(0.5 - fd.x, 0.5 - fd.y));
      if (uGroup == 1) mirror = min(mirror, abs(fd.x - fd.y) * 0.7071);
    }
    float mirL = exp(-mirror * mirror / (1.4 * pxc * pxc)) * (1.0 - smoothstep(0.02, 0.05, pxc));
    // hue runs along the ridge profile and the field: troughs in the palette's deep stop, ridges in its
    // jewel stops, crest lines in its brightest (never an RGB blend of opposite hues, never olive)
    // troughs in the palette's deep stop, ridges in its two darkable jewel colours (the phosphene pair:
    // never orange/yellow/olive, which turn brown at these luminances), hue sliding with the field
    float hsel = smoothstep(0.5, 0.9, ridge + 0.35 * (field - 0.5) + 0.25 * hw);
    vec3 hc = hueToward(uStops[0] / max(uStops[0].r, max(uStops[0].g, uStops[0].b)), uPatchCol[0], smoothstep(0.08, 0.45, ridge));
    hc = hueToward(hc, uPatchCol[1], hsel);
    hc = mix(hc, hsel > 0.5 ? uAcid[0] : uAcid[1], uChallenge);
    vec3 glass = saturateKeepLum(hc / max(dot(hc, LUMW), 1e-4) * lumB, 2.0);
    float lumL = m * (1.6 + 1.2 * uGlow) * (1.0 - 0.35 * ann) * max(crestL, 0.6 * mirL);
    vec3 lineC = saturateKeepLum(mix(uStops[2], uAcid[0], uChallenge), 3.0);
    lineC /= max(lineC.r, max(lineC.g, lineC.b));
    vec3 tiled = glass + lineC * lumL / max(dot(lineC, LUMW), 1e-3) * 0.6;
    col = mix(col, tiled, tm);
    emit *= 1.0 - tm;
    vec3 racc = mix(uStops[2], uAcid[1], uChallenge);
    racc /= max(racc.r, max(racc.g, racc.b));
    col += racc * band * 0.05 * uGlow * (1.0 - 0.5 * tm);
    emit = max(emit, 0.22 * band * uGlow);
  }

  // difficult passage: colder and darker, never brighter (the acid colours come from the jewel map)
  col *= 1.0 - 0.15 * uChallenge;
  gl_FragColor = vec4(min(col, vec3(0.92)), clamp(emit, 0.0, 1.0));
}
