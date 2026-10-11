// Chrysanthemum layer (BUILD.md §11.5): hyperbolic triangle-group tilings in the Poincaré disk by
// reflection folding (glsl/hyperbolic.frag.glsl), warped onto a flower/dome sheet, groups "flickering"
// by crossfade only (GroupScheduler, ≥ 300 ms), animated by a slow Möbius motion whose speed follows
// state.pulse, plus a slowly morphing Kleinian (Maskit) limit set as a lace ring. Everything is driven
// by the shared state (wallTime, pulse, intensity, fieldTexture, palette, challenge, look).

import * as THREE from 'three';
import type { Layer } from '../pipeline';
import type { SharedState } from '../state';
import { deriveSeed } from '../rng';
import {
  GroupScheduler, compose, diskRotation, diskTranslation, maskitParams, sanitiseGroups,
  triangleMirrors, type Cx, type Mat2, type TriangleMirrors,
} from './mobius';
import vert from './glsl/hyperbolic.vert.glsl?raw';
import frag from './glsl/hyperbolic.frag.glsl?raw';

const LUMA = [0.2126, 0.7152, 0.0722];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Palette hex colours → linear colours normalised to relative luminance 0.2, no saturated red. */
export function preparePalette(hex: string[] | undefined): THREE.Color[] {
  let src = hex && hex.length ? hex : ['#ffb000', '#4fe3ff', '#ff4fd8', '#7dff6a', '#ffe08a'];
  // planner palettes start with a near-black background colour: skip very dark colours (if enough remain)
  const lumOf = (h: string) => { const c = new THREE.Color(); try { c.set(h); } catch { return 0; } return c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2]; };
  const lit = src.filter((h) => lumOf(h) > 0.012);
  if (lit.length >= 3) src = lit;
  const out: THREE.Color[] = [];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Color();
    try { c.set(src[i % src.length]); } catch { c.set('#888888'); }
    let rgb = [c.r, c.g, c.b];
    const l = Math.max(1e-4, rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]);
    rgb = rgb.map((x) => (x * 0.2) / l);
    // jewel tones: push chroma away from the grey of the same luminance (pale palette entries stay coloured)
    rgb = rgb.map((x) => Math.max(0, 0.2 + (x - 0.2) * 1.4));
    // keep every channel share < 0.75 (so even the hue-rotated challenge colours stay clear of the
    // saturated-red rule R/(R+G+B) ≥ 0.8) by mixing with grey. Channels above 1 are allowed here: the
    // shaders re-normalise to their (darker) target luminance, so saturated hues stay saturated
    // (mixing every out-of-gamut colour with grey at luminance 0.2 made the layers pastel).
    for (let k = 0; k < 30; k++) {
      const sum = rgb[0] + rgb[1] + rgb[2];
      if (Math.max(...rgb) / Math.max(sum, 1e-6) < 0.75) break;
      rgb = rgb.map((x) => 0.2 + (x - 0.2) * 0.85);
    }
    out.push(new THREE.Color(rgb[0], rgb[1], rgb[2]));
  }
  return out;
}

/** Push a palette colour (linear, luminance L) to jewel chroma: same hue and luminance, the smallest
 *  channel pulled down to ~8 % of the luminance (pale entries such as cream or ice-blue become
 *  saturated amber / cyan instead of grey), red share kept < 0.75 (red rule margin), blue/green < 0.92. */
export function jewelColour(c: THREE.Color): THREE.Color {
  const rgb = [c.r, c.g, c.b];
  const L = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  const mn = Math.min(...rgb);
  if (L <= 1e-6 || L - mn < 0.02 * L) return c.clone();       // grey: no hue to push
  let k = Math.min(8, (L - 0.08 * L) / (L - mn));
  if (k < 1) k = 1;
  // red keeps the < 0.75 share (margin to the saturated-red rule R/(R+G+B) ≥ 0.8); blue, violet and
  // green may be fully saturated (the shader no longer rotates channels in a difficult passage). Never
  // less chroma than the input (preparePalette already keeps every share < 0.75).
  const at = (kk: number) => rgb.map((x) => Math.max(0, L + (x - L) * kk));
  let out = at(k);
  for (let i = 0; i < 40 && k > 1; i++) {
    const sum = Math.max(out[0] + out[1] + out[2], 1e-6);
    if (out[0] / sum < 0.75 && Math.max(out[1], out[2]) / sum < 0.92) break;
    k = Math.max(1, k * 0.95);
    out = at(k);
  }
  return new THREE.Color(out[0], out[1], out[2]);
}

/** Red-dominant jewel colours keep their chroma under the red rule by turning a little toward magenta
 *  (blue) or orange (green) instead of toward grey: jewelColour keeps red < 0.75 of R+G+B by pulling the
 *  colour toward its grey, which turned hot magenta (#ff2a6d) into dusty rose. Here the minor channels are
 *  re-derived from the full-chroma colour (the smallest at 0.6 % of red) and the larger of green /
 *  blue is raised until red is 0.74 of the sum; same luminance, red share < 0.75, more chroma than a
 *  compliant input (a non-compliant input, e.g. a pure red hex, is always made compliant). Other colours
 *  are returned unchanged. */
export function vividColour(c: THREE.Color): THREE.Color {
  const L = c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
  const sum = c.r + c.g + c.b;
  if (L <= 1e-6 || c.r < Math.max(c.g, c.b) || c.r / Math.max(sum, 1e-6) < 0.72) return c.clone();
  const R = 1;
  const gIsMid = c.g >= c.b;
  const low = 0.03 * 0.2126;                     // the smallest channel nearly off
  const mid = R / 0.74 - R - low;
  const rgb = gIsMid ? [R, mid, low] : [R, low, mid];
  const l = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  const out = new THREE.Color(rgb[0] * (L / l), rgb[1] * (L / l), rgb[2] * (L / l));
  const chroma = (x: THREE.Color) => Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b);
  // (a colour already clear of the red rule keeps whichever has more chroma; one that is not — a pure
  // red hex — always gets the compliant colour)
  return chroma(out) >= chroma(c) || c.r / Math.max(sum, 1e-6) >= 0.75 ? out : c.clone();
}

const DEFAULT_HEX = ['#ffb000', '#4fe3ff', '#ff4fd8', '#7dff6a', '#ffe08a'];

/** The chrysanthemum's palette: the same five entries as preparePalette (dark entries skipped, luminance
 *  0.2), but each rebuilt from its own hex colour with its HUE kept (preparePalette's chroma push around
 *  a fixed grey turned neon yellow #f9c80e into orange), then jewel chroma and vivid red-dominant hues. */
export function chrysPalette(hex: string[] | undefined): THREE.Color[] {
  const prepared = preparePalette(hex);
  let src = hex && hex.length ? hex : DEFAULT_HEX;
  const lumOf = (c: THREE.Color) => c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
  const lit = src.filter((h) => { const c = new THREE.Color(); try { c.set(h); } catch { return false; } return lumOf(c) > 0.012; });
  if (lit.length >= 3) src = lit;
  return prepared.map((p, i) => {
    const c = new THREE.Color();
    try { c.set(src[i % src.length]); } catch { return vividColour(jewelColour(p)); }
    const l = lumOf(c);
    if (l <= 1e-4) return vividColour(jewelColour(p));
    return vividColour(jewelColour(c.multiplyScalar(0.2 / l)));
  });
}

/** Darkest planner palette colour (the trip's background hue) at luminance 0.2, jewel chroma. Falls
 *  back to the darkest prepared colour's hue when the darkest entry is a neutral black. */
export function darkBaseColour(hex: string[] | undefined, prepared: THREE.Color[]): THREE.Color {
  const lum = (c: THREE.Color) => c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
  let best: THREE.Color | null = null;
  for (const h of hex ?? []) {
    const c = new THREE.Color();
    try { c.set(h); } catch { continue; }
    if (!best || lum(c) < lum(best)) best = c;
  }
  const chroma = (c: THREE.Color) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  if (!best || chroma(best) < 0.15 * Math.max(c3max(best), 1e-6)) {
    best = prepared.reduce((a, c) => (lum(c) / Math.max(1e-6, chroma(c)) < lum(a) / Math.max(1e-6, chroma(a)) ? c : a), prepared[0]).clone();
  }
  const l = Math.max(1e-6, lum(best));
  return jewelColour(best.clone().multiplyScalar(0.2 / l));
}
const c3max = (c: THREE.Color) => Math.max(c.r, c.g, c.b);

/** For each colour, the palette colour farthest away in hue (complementary accents, VISUAL_DIRECTION
 *  §1.6); near-neutral colours count as hue-less (distance 0.25 turn to everything). */
export function contrastingColours(pal: THREE.Color[]): THREE.Color[] {
  const hsl = pal.map((c) => {
    const m = Math.max(c.r, c.g, c.b) || 1;
    const h = { h: 0, s: 0, l: 0 };
    new THREE.Color(c.r / m, c.g / m, c.b / m).getHSL(h, THREE.LinearSRGBColorSpace);
    return h;
  });
  return pal.map((_, i) => {
    let best = (i + 2) % pal.length; let bestD = -1;
    for (let j = 0; j < pal.length; j++) {
      if (j === i) continue;
      const dh = Math.abs(hsl[i].h - hsl[j].h);
      const d = (hsl[i].s < 0.1 || hsl[j].s < 0.1) ? 0.25 : Math.min(dh, 1 - dh);
      if (d > bestD + 1e-6) { bestD = d; best = j; }
    }
    return pal[best].clone();
  });
}

/** Luminance a colour carries at full chroma (its strongest channel at 1): violet ~0.13, magenta ~0.24,
 *  cyan ~0.55, yellow ~0.62. */
export function carryLuminance(c: THREE.Color): number {
  const m = Math.max(c.r, c.g, c.b);
  return m > 1e-6 ? (c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2]) / m : 0;
}

/** The two palette colours that carry the most luminance at full chroma (neon: yellow and ice-cyan;
 *  lunar: amber and sky): the hues of the thin bright accents (filaments, pearl rims, edge lines), so a
 *  bright accent stays coloured instead of turning white (VISUAL_DIRECTION §1.6: the brightest colour
 *  as the accent). Same luminance as the input colours. */
export function accentColours(pal: THREE.Color[]): [THREE.Color, THREE.Color] {
  const order = pal.map((c, i) => ({ i, k: carryLuminance(c) })).sort((a, b) => b.k - a.k);
  const hue = (c: THREE.Color) => { const h = { h: 0, s: 0, l: 0 }; c.getHSL(h, THREE.LinearSRGBColorSpace); return h.h; };
  const h0 = hue(pal[order[0].i]);
  // the second accent: the brightest-carrying colour of a clearly different hue (neon: yellow + cyan,
  // not cyan + ice-cyan); the runner-up if every colour shares the hue
  const second = order.slice(1).find((o) => { const d = Math.abs(hue(pal[o.i]) - h0); return Math.min(d, 1 - d) > 0.08; })
    ?? order[Math.min(1, order.length - 1)];
  return [pal[order[0].i].clone(), pal[second.i].clone()];
}

/** Intensity escalation of the chrysanthemum (0 at v 5 → 1 at v 9.5): deeper tiling (zoom), denser
 *  lace, stronger crest bloom and fold shading, so v 9 is visibly more than v 7.5. */
export function escalation(v: number): number {
  return smooth(5, 9.5, v);
}

/** Difficult passage (docs/VISUAL_DIRECTION.md): two acidic complementary colours on black, luminance
 *  0.2 — an acid green-cyan and an electric violet (no saturated red). */
export const HARSH_COLOURS: [THREE.Color, THREE.Color] = [
  new THREE.Color(0.06, 0.24, 0.13).multiplyScalar(0.2 / (0.06 * 0.2126 + 0.24 * 0.7152 + 0.13 * 0.0722)),
  new THREE.Color(0.5, 0.02, 1.0).multiplyScalar(0.2 / (0.5 * 0.2126 + 0.02 * 0.7152 + 1.0 * 0.0722)),
];

/** Extra zoom for groups with large cells: (4,4,4) and (5,5,2) polygons would otherwise fill half the
 *  flower (inradius 0.55 / 0.40 of the disk vs 0.27 for (7,3,2)); 1 for (7,3,2), at most 1.35 (the
 *  shader caps zoom × group zoom at 2.4: beyond that the non-conformal centre zoom streaks the cells). */
export function groupZoom(t: TriangleMirrors): number {
  const inr = Math.hypot(t.centre[0], t.centre[1]) - t.radius;
  const d = Math.atanh(Math.min(0.999, Math.max(1e-3, inr)));
  return Math.max(1, Math.min(1.35, Math.pow(d / Math.atanh(0.266), 0.5)));
}

interface TriUniforms { tri: THREE.Vector4; cen: THREE.Vector2; meta: THREE.Vector4 }

function triUniforms(t: TriangleMirrors, into: TriUniforms): void {
  const inr = Math.hypot(t.centre[0], t.centre[1]) - t.radius;          // A to the polygon edge (euclidean)
  const lambda = 2 * 2 * Math.atanh(Math.min(0.999, inr));               // polygon diameter (hyperbolic)
  into.tri.set(t.wedge, t.n2[0], t.n2[1], t.radius);
  into.cen.set(t.centre[0], t.centre[1]);
  into.meta.set(inr, lambda, t.p, groupZoom(t));
}


export class HyperbolicLayer implements Layer<SharedState> {
  readonly name = 'chrysanthemum';
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private groups: [number, number, number][] = [];
  private tris: TriangleMirrors[] = [];
  private scheduler: GroupScheduler | null = null;
  private scriptKey: unknown = undefined;
  private lastWall: number | null = null;
  private lastModel: number | null = null;
  private theta = 0;      // Möbius rotation phase (rad)
  private tau = 0;        // translation path phase
  private omega = 0;      // current rotation speed (rad/s), smoothed
  private klein = { height: 1.97, shift: 0 };
  private paletteKey = '';
  private shownFrom = -1;
  private shownTo = -1;

  constructor() {
    const v4 = () => new THREE.Vector4();
    const pal = chrysPalette(undefined);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uWeight: { value: 0 }, uTime: { value: 0 },
        uPulse: { value: 0 }, uIntensity: { value: 0 }, uChallenge: { value: 0 }, uLook: { value: new THREE.Vector2() },
        uTriA: { value: v4() }, uCenA: { value: new THREE.Vector2() }, uMetaA: { value: v4() },
        uTriB: { value: v4() }, uCenB: { value: new THREE.Vector2() }, uMetaB: { value: v4() },
        uMix: { value: 0 },
        uMobAB: { value: v4() }, uMobCD: { value: v4() }, uMobAB2: { value: v4() }, uMobCD2: { value: v4() },
        uZoom: { value: 1.4 }, uDiskR: { value: 1.02 }, uPetals: { value: 14 },
        uPal: { value: pal }, uPalC: { value: contrastingColours(pal) }, uDark: { value: darkBaseColour(undefined, pal) },
        uHarsh: { value: HARSH_COLOURS.map((c) => c.clone()) }, uAcc: { value: accentColours(pal) }, uLv: { value: 0 },
        uField: { value: null }, uHasField: { value: 0 },
        uKlein: { value: new THREE.Vector2(1.97, 0) }, uLaceRot: { value: 0 }, uLaceN: { value: 9 }, uLace: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  init(_renderer: THREE.WebGLRenderer, state: SharedState): void {
    this.configure(state);
  }

  resize(w: number, h: number): void {
    (this.material.uniforms.uRes.value as THREE.Vector2).set(Math.max(1, w), Math.max(1, h));
  }

  /** (Re)read the trip script: groups, Kleinian traces, seed. */
  private configure(state: SharedState): void {
    const script = state.tripScript;
    if (this.scriptKey === script && this.scheduler) return;
    this.scriptKey = script;
    const ch = (script?.layers as Record<string, any> | undefined)?.chrysanthemum;
    this.groups = sanitiseGroups(ch?.groups);
    this.tris = this.groups.map(([p, q, r]) => triangleMirrors(p, q, r));
    const seed = deriveSeed(state.seed >>> 0, 'chrysanthemum');
    // 2 s melts (≥ 1.2 s under a difficult passage; the shader's outward sweep gives each pixel 0.6 of it)
    this.scheduler = new GroupScheduler(this.tris.length, seed, { crossfade: 2.0 });
    const ta = Array.isArray(ch?.kleinian?.trace_a) ? (ch.kleinian.trace_a as Cx) : ([2.0, 0.05] as Cx);
    const tb = Array.isArray(ch?.kleinian?.trace_b) ? (ch.kleinian.trace_b as Cx) : ([2.0, 0.1] as Cx);
    this.klein = maskitParams([Number(ta[0]), Number(ta[1])], [Number(tb[0]), Number(tb[1])]);
    // petals of the flower outline: many, like a chrysanthemum (≥ 18; not tied to the tiling's p-fold
    // symmetry, which rotates under the Möbius motion anyway)
    this.material.uniforms.uPetals.value = Math.max(18, 2 * this.tris[0].p);
    this.shownFrom = this.shownTo = -1;
    // start at a seeded phase so two seeds do not look identical
    this.theta = ((seed % 1000) / 1000) * 2 * Math.PI;
    this.tau = ((seed >>> 10) % 1000) / 10;
  }

  private setPalette(state: SharedState): void {
    const key = (state.palette?.colours ?? []).join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const pal = chrysPalette(state.palette?.colours);
    this.material.uniforms.uPal.value = pal;
    this.material.uniforms.uPalC.value = contrastingColours(pal);
    this.material.uniforms.uDark.value = darkBaseColour(state.palette?.colours, pal);
    this.material.uniforms.uAcc.value = accentColours(pal);
  }

  /** Möbius motion at phases (θ, τ): rotate about the centre, then a small wandering translation. */
  private motion(theta: number, tau: number): Mat2 {
    const r = 0.16 * (0.6 + 0.4 * Math.sin(0.31 * tau));
    const a: Cx = [r * Math.cos(0.17 * tau + 1.3), r * Math.sin(0.23 * tau)];
    return compose(diskTranslation(a), diskRotation(theta));
  }

  private advance(state: SharedState): void {
    const wall = state.wallTime;
    const dtWall = this.lastWall === null ? 0 : Math.max(0, Math.min(0.1, wall - this.lastWall));
    this.lastWall = wall;
    const dtModel = this.lastModel === null ? 0 : Math.max(0, (state.t_min - this.lastModel) * 60);
    this.lastModel = state.t_min;
    const v = state.intensity.visual;
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    // speed follows the pulse (≤ 0.5 Hz oscillator) and the intensity; the challenge speeds it up
    // (×1.25 under a difficult passage. Slower than r1 (0.055·(0.6–1.2)·(1+0.7p)·(1+0.4c)): a rotation
    // moves the shrinking rim cells past a pixel ever faster, and the shader flattens / dissolves cells
    // beyond ~0.6 / ~2 Hz, so a slower flow keeps more rings of the Poincaré shrinkage resolved)
    const target = 0.042 * (0.7 + 0.5 * Math.min(1, v / 9)) * (1 + 0.6 * state.pulse) * (1 + 0.25 * ch);
    this.omega += (target - this.omega) * Math.min(1, dtWall * 2);
    this.theta = (this.theta + this.omega * dtWall) % (2 * Math.PI * 1000);
    this.tau += this.omega * dtWall * 3;
    const st = this.scheduler!.update(Math.min(dtModel, 5), dtWall, ch);
    const u = this.material.uniforms;
    if (st.from !== this.shownFrom || st.to !== this.shownTo) {
      this.shownFrom = st.from; this.shownTo = st.to;
      triUniforms(this.tris[st.from], { tri: u.uTriA.value, cen: u.uCenA.value, meta: u.uMetaA.value });
      triUniforms(this.tris[st.to], { tri: u.uTriB.value, cen: u.uCenB.value, meta: u.uMetaB.value });
    }
    u.uMix.value = st.from === st.to ? 0 : st.mix;
  }

  render(renderer: THREE.WebGLRenderer, state: SharedState, target: THREE.WebGLRenderTarget | null): void {
    this.configure(state);
    this.advance(state);
    const w = state.layerWeights.chrysanthemum;
    if (w < 0.002) return;
    this.setPalette(state);
    const u = this.material.uniforms;
    const v = state.intensity.visual;
    const ch = Math.max(0, Math.min(1, state.challenge?.level ?? 0));
    u.uWeight.value = w;
    u.uTime.value = state.wallTime;
    u.uPulse.value = state.pulse;
    u.uIntensity.value = Math.max(0, Math.min(1, v / 10));
    u.uChallenge.value = ch;
    (u.uLook.value as THREE.Vector2).set(state.look.yaw, -state.look.pitch);

    const m = this.motion(this.theta, this.tau);
    const m2 = this.motion(this.theta + this.omega * 0.25, this.tau + this.omega * 0.75);
    (u.uMobAB.value as THREE.Vector4).set(m[0][0], m[0][1], m[1][0], m[1][1]);
    (u.uMobCD.value as THREE.Vector4).set(m[2][0], m[2][1], m[3][0], m[3][1]);
    (u.uMobAB2.value as THREE.Vector4).set(m2[0][0], m2[0][1], m2[1][0], m2[1][1]);
    (u.uMobCD2.value as THREE.Vector4).set(m2[2][0], m2[2][1], m2[3][0], m2[3][1]);

    // the sheet tightens (more, smaller tiles: more rings visibly shrinking toward the rim) with intensity
    // and in a difficult passage (hyperbolic distance from the centre × zoom inside a fixed Poincaré
    // disk: 1 = the plain disk)
    const lv = escalation(v);
    u.uLv.value = lv;
    u.uZoom.value = 1.2 + 0.95 * lv + 0.15 * ch;
    // the flower opens a little with intensity (screen radius 1.02 → 1.08); a larger disk made the cells
    // larger, which the tiling's depth needs the other way round
    u.uDiskR.value = 1.02 + 0.06 * lv;

    // Kleinian lace: trace parameters morph slowly (periods 43 s and 61 s, ≥ 30 s)
    const t = state.wallTime;
    // (the lace densifies a little with intensity: a lower Maskit height curls the cusps into spiral pearl
    // strings; ≥ 1.925, below that the limit set of some trip-script traces froths into a bright foam)
    const height = Math.min(2.0, Math.max(1.925, this.klein.height + 0.022 * Math.sin((2 * Math.PI * t) / 43) - 0.02 * ch));
    const shift = Math.max(-0.2, Math.min(0.2, this.klein.shift + 0.06 * Math.sin((2 * Math.PI * t) / 61 + 1.1)));
    (u.uKlein.value as THREE.Vector2).set(height, shift);
    u.uLaceRot.value = -0.35 * this.theta;
    u.uLace.value = 0.2 + 0.8 * smooth(5.0, 8.5, v);

    const tex = state.fieldTexture;
    if (tex && (tex as THREE.Texture).isTexture) {
      u.uField.value = tex as THREE.Texture;
      u.uHasField.value = 1;
    } else {
      u.uField.value = null;
      u.uHasField.value = 0;
    }
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Diagnostics for tests: current groups and crossfade. */
  get debugInfo(): { groups: [number, number, number][]; from: number; to: number; mix: number; omega: number } {
    const st = this.scheduler?.state ?? { from: 0, to: 0, mix: 0 };
    return { groups: this.groups, from: st.from, to: st.to, mix: st.mix, omega: this.omega };
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

export function createHyperbolicLayer(): HyperbolicLayer {
  return new HyperbolicLayer();
}
