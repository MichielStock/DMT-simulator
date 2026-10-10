"""First-class procedural assets (BUILD.md §10, §0.6): seamless world backdrops and glyph beings.

Worlds: 2048×1024 equirectangular, every pattern a function of the view direction (integer angular frequencies
or 3-D great circles), so the image wraps around the sphere with no seam; the poles are calmed like generated
worlds (imagegen.calm_poles). One generator per world category:
  dome_temple, geometric_chamber        → mandala dome (rose-window zenith, arcade, mandala floor)
  infinite_hall, workshop, carnival     → tiled hall (columns and arches receding into a glowing distance)
  cosmic_space, organic_jungle          → cosmic field (nebula, stars, orbit rings, slow luminous bodies)
Glyph beings: 1024² RGBA kaleidoscopic silhouettes built from a seeded procedural glyph alphabet; three variants
(a, b, c) from one seed family: at rest, turned/unfolding, dissolving into glyphs.
All colours come from the trip palette; peak luminance is kept below near-white (§4.1).
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

W, H = 2048, 1024
MAX_LIN = 0.78  # brightest channel value allowed (sRGB 0..1) — no near-white

CATEGORY_GENERATOR = {
    "dome_temple": "mandala_dome", "geometric_chamber": "mandala_dome",
    "infinite_hall": "tiled_hall", "workshop": "tiled_hall", "carnival": "tiled_hall",
    "cosmic_space": "cosmic_field", "organic_jungle": "cosmic_field",
}
DEFAULT_PALETTE = ["#1b0a3c", "#5b1a8f", "#c2187a", "#e8a33b", "#1f8f7a", "#3a5bd9"]


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def _pal(palette) -> list[np.ndarray]:
    cols = [hex_rgb(c) for c in (palette or DEFAULT_PALETTE)]
    # cap near-white palette entries (e.g. neon #d1f7ff) so nothing renders near-white
    out = []
    for c in cols:
        m = c.max()
        out.append(c * (0.85 / m) if m > 0.85 else c)
    return out


def _ramp(t: np.ndarray, cols: list[np.ndarray]) -> np.ndarray:
    """Smooth colour ramp through cols for t in 0..1 (any shape) → (..., 3)."""
    t = np.clip(t, 0, 1) * (len(cols) - 1)
    i = np.minimum(t.astype(int), len(cols) - 2)
    f = t - i
    f = f * f * (3 - 2 * f)
    c = np.stack(cols)
    return c[i] * (1 - f[..., None]) + c[i + 1] * f[..., None]


def _line(d: np.ndarray, width: float) -> np.ndarray:
    """Soft line profile: 1 at d = 0, falling off over `width` (Gaussian)."""
    return np.exp(-(d / max(width, 1e-6)) ** 2)


def _grid():
    x = (np.arange(W, dtype=np.float32) + 0.5) / W
    y = (np.arange(H, dtype=np.float32) + 0.5) / H
    th = (2 * np.pi * x)[None, :].repeat(H, 0)              # longitude 0..2π (wraps)
    ph = (np.pi * (0.5 - y))[:, None].repeat(W, 1)           # latitude +π/2 (zenith) .. −π/2 (nadir)
    return th, ph


def _dirs(th, ph):
    return np.stack([np.cos(ph) * np.cos(th), np.sin(ph), np.cos(ph) * np.sin(th)], -1)


def _periodic_noise(rng, shape=(H, W), beta=2.6, lowcut=2.0) -> np.ndarray:
    """1/f^beta noise via FFT: periodic in x (and y), so it wraps seamlessly. Normalised 0..1."""
    h, w = shape
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    f = np.sqrt(fx ** 2 + (fy * 2) ** 2)  # pixels are square on the sphere at the equator: 2:1 image
    amp = 1.0 / np.maximum(f, lowcut) ** (beta / 2)
    amp[0, 0] = 0
    spec = amp * np.exp(1j * rng.uniform(0, 2 * np.pi, amp.shape))
    n = np.fft.irfft2(spec, s=shape).astype(np.float32)
    lo, hi = np.percentile(n, 1), np.percentile(n, 99)
    return np.clip((n - lo) / (hi - lo), 0, 1)


def _tonemap(img: np.ndarray) -> np.ndarray:
    """Soft-saturate to MAX_LIN; keeps hues, never near-white."""
    m = img.max(-1, keepdims=True)
    k = np.where(m > 0.55, (0.55 + (MAX_LIN - 0.55) * np.tanh((m - 0.55) / (MAX_LIN - 0.55))) / np.maximum(m, 1e-6), 1)
    return np.clip(img * k, 0, MAX_LIN)


def _finish_world(img: np.ndarray, floor: bool = True, fraction: float = 0.48, radius: int = 61) -> Image.Image:
    """Tonemap (no near-white), luminous contrast floor for stroke-built worlds (§4.1 patterns), calm poles."""
    from backend.assets.contrast import make_pattern_safe
    from backend.assets.imagegen import calm_poles

    out = Image.fromarray((_tonemap(img) * 255 + 0.5).astype(np.uint8))
    out, _info = make_pattern_safe(out, start=fraction if floor else 0.0, radius=radius,
                                   finish=lambda im: calm_poles(im, band=0.06))
    return out


# ---------------------------------------------------------------------------------------------- worlds

def mandala_dome(palette, seed: int, category: str = "dome_temple") -> Image.Image:
    rng = np.random.default_rng(seed)
    cols = _pal(palette)
    dark, rest = cols[0], cols[1:]
    th, ph = _grid()
    img = np.zeros((H, W, 3), np.float32) + dark * 0.6
    n_rib = int(rng.choice([12, 16, 18, 24]))
    n_arch = int(rng.choice([8, 10, 12]))
    n_petal = int(rng.choice([6, 8, 12]))
    hard = category == "geometric_chamber"
    # --- dome (upper hemisphere): r = 0 at the zenith, 1 at the horizon
    r = np.clip((np.pi / 2 - ph) / (np.pi / 2), 0, 2)
    up = (ph > 0).astype(np.float32)
    ribs = _line(np.abs(np.sin(n_rib * th / 2)) * r * 6, 0.35) * (r > 0.12)
    rings_r = np.sort(rng.uniform(0.15, 0.9, 5))
    rings = sum(_line(r - rr, 0.006 + 0.004 * k) for k, rr in enumerate(rings_r))
    petal = np.cos(n_petal * th) * 0.5 + 0.5
    rose = (_line(r - (0.08 + 0.22 * petal ** 3), 0.025) + 0.6 * _line(r - (0.05 + 0.12 * (1 - petal) ** 2), 0.02))
    if hard:  # faceted chamber: polygonal rings
        poly = np.cos(np.pi / n_petal) / np.cos(((th % (2 * np.pi / n_petal)) - np.pi / n_petal))
        rings = sum(_line(r - rr * poly, 0.006) for rr in rings_r)
    mosaic = (np.cos(n_rib * 2 * th) * np.cos(40 * r) * 0.5 + 0.5) ** 4 * (r < 0.95)
    t_col = (r * 0.8 + 0.2 * petal) % 1.0
    dome = (_ramp(t_col, rest) * (0.18 + 0.55 * ribs[..., None] + 0.75 * rings[..., None] + 0.9 * rose[..., None]
                                  + 0.22 * mosaic[..., None]))
    zen = np.exp(-(r / 0.07) ** 2)[..., None] * rest[2 % len(rest)] * 0.9
    img += (dome + zen) * up[..., None]
    # --- arcade around the horizon (−0.05 .. 0.45 rad)
    u = (n_arch * th / (2 * np.pi)) % 1.0 - 0.5           # −0.5..0.5 across one bay
    v = ph
    arch_top = 0.28 + 0.12 * np.sqrt(np.clip(1 - (2 * u) ** 2, 0, 1))
    inside = (np.abs(u) < 0.36) & (v > -0.02) & (v < arch_top)
    edge = _line(np.minimum(np.abs(np.abs(u) - 0.36), np.abs(v - arch_top)), 0.012) * (v > -0.02) * (v < arch_top + 0.02)
    niche = inside * (0.35 + 0.65 * np.exp(-((v - 0.12) / 0.12) ** 2)) * (0.6 + 0.4 * np.cos(2 * np.pi * u * 3) ** 2)
    col_niche = _ramp((np.floor(n_arch * th / (2 * np.pi)) / n_arch * 2.0) % 1.0, rest)
    band = (np.abs(v - 0.2) < 0.32).astype(np.float32)
    img = img * (1 - 0.7 * band[..., None] * inside[..., None]) + band[..., None] * (
        col_niche * niche[..., None] * 0.75 + rest[0] * edge[..., None] * 0.9)
    pillars = _line(np.abs(np.abs(u) - 0.43), 0.03) * (v > -0.05) * (v < 0.3)
    img += pillars[..., None] * rest[-1] * 0.45
    # --- mandala floor (lower hemisphere): rings from the nadir
    rf = np.clip((np.pi / 2 + ph) / (np.pi / 2), 0, 1)
    down = (ph < 0).astype(np.float32)
    star = np.cos(n_petal * th + 6 * rf) * 0.5 + 0.5
    floor = (_line(np.sin(rf * 22) * 0.5, 0.08) * 0.35 + 0.5 * _line(rf - 0.35 - 0.1 * star, 0.02)
             + 0.3 * star ** 6 * (rf < 0.8))
    img += (_ramp((rf * 1.3 + 0.3) % 1, rest) * floor[..., None] * 0.55 + dark * 0.2) * down[..., None]
    # horizon glow binds the parts together
    img += np.exp(-(ph / 0.08) ** 2)[..., None] * rest[3 % len(rest)] * 0.18
    return _finish_world(img)


def tiled_hall(palette, seed: int, category: str = "infinite_hall") -> Image.Image:
    """An endless colonnade: glowing columns and nested arches around the horizon, their light mirrored in a
    polished floor, a soft vaulted ceiling, and a bright vanishing distance between every pair of columns."""
    rng = np.random.default_rng(seed)
    cols = _pal(palette)
    dark, rest = cols[0], cols[1:]
    th, ph = _grid()
    n_col = int(rng.choice([8, 10, 12]))
    carnival = category == "carnival"
    th = th + np.pi / (2 * n_col)  # the 360° seam falls inside a bay
    u = (n_col * th / (2 * np.pi)) % 1.0
    col_idx = np.round(n_col * th / (2 * np.pi)) % n_col     # nearest column
    bay = np.floor(n_col * th / (2 * np.pi)) % n_col
    du = np.minimum(u, 1 - u)                                # distance to the nearest column (bay units)
    cyc = 0.5 + 0.5 * np.cos(th + rng.uniform(0, 2 * np.pi))  # smooth, cyclic colour coordinate (no steps)
    img = np.zeros((H, W, 3), np.float32) + dark * 0.8
    up = np.clip(ph, 0, None)
    # vaulted ceiling: broad soft ribs from each column meeting overhead
    rib = _line(np.sin(np.pi * u) * np.cos(ph) * 1.0, 0.18) * (ph > 0.35)
    img += (_ramp(np.clip(ph / 1.6 * 0.5 + cyc * 0.5, 0, 1), rest) * (0.10 + 0.25 * rib[..., None])) * (ph > 0)[..., None]
    # columns: soft glowing shafts between floor and arch springing
    shaft = _line(du, 0.035) * (np.abs(ph) < 0.42)
    ccol = _ramp(0.5 + 0.5 * np.cos(2 * np.pi * col_idx / n_col), rest)
    img += shaft[..., None] * ccol * 0.7
    # nested arches (3), broad strokes
    arch = sum(_line(ph - (0.42 + 0.2 * np.sqrt(np.clip(1 - (2 * (u - 0.5) * s_) ** 2, 0, 1))) * s_, 0.03) * 0.75 ** k
               for k, s_ in enumerate([1.0, 0.82, 0.68]))
    img += arch[..., None] * rest[-1] * 0.55 * (ph > 0)[..., None]
    # the distance inside each bay: a warm vanishing glow
    vanish = np.exp(-(((u - 0.5) / 0.22) ** 2) - (ph / 0.12) ** 2)
    img += vanish[..., None] * _ramp(1 - cyc, rest) * 0.75
    img += np.exp(-(ph / 0.05) ** 2)[..., None] * rest[2 % len(rest)] * 0.35
    # polished floor: mirrored, blurred light of columns and distance, fading with depth; soft rings toward the nadir
    refl = (shaft * 0.5 + vanish * 0.6)
    mirror = np.flipud(refl) * np.exp(ph / 0.35)
    rf = np.clip((np.pi / 2 + ph) / (np.pi / 2), 0, 1)
    rings = (np.cos(rf * 26) * 0.5 + 0.5) ** 2 * (rf < 0.85) * 0.18
    floor = (ccol * mirror[..., None] * 0.6 + _ramp(np.clip(rf * 0.6 + cyc * 0.4, 0, 1), rest) * (0.08 + rings)[..., None])
    wdown = np.clip(-ph / 0.04, 0, 1)[..., None]  # soft horizon: no hard edge at the equator
    img = img * (1 - 0.5 * wdown) + floor * wdown
    if carnival:  # festoons of lantern-light between the columns
        fest = _line(ph - (0.33 - 0.07 * np.sin(np.pi * u)), 0.012)
        beads = (np.cos(2 * np.pi * u * 9) * 0.5 + 0.5) ** 6 * _line(ph - (0.33 - 0.07 * np.sin(np.pi * u)), 0.03)
        img += fest[..., None] * rest[1 % len(rest)] * 0.5 + beads[..., None] * _ramp((u * 3) % 1, rest) * 0.8
    return _finish_world(img, fraction=0.55, radius=81)


def cosmic_field(palette, seed: int, category: str = "cosmic_space") -> Image.Image:
    rng = np.random.default_rng(seed)
    cols = _pal(palette)
    dark, rest = cols[0], cols[1:]
    th, ph = _grid()
    d = _dirs(th, ph)
    jungle = category == "organic_jungle"
    n1 = _periodic_noise(rng, beta=3.0)
    n2 = _periodic_noise(rng, beta=2.2)
    # equirect stretches near the poles: blend noise toward its row mean there (calm_poles finishes the job)
    neb = np.clip(n1 * 1.3 - 0.25, 0, 1) ** 1.6
    img = dark[None, None] * 0.5 + _ramp((n2 * 0.9 + 0.1 * n1) % 1, rest) * (0.08 + 0.55 * neb)[..., None]
    if jungle:  # organic: vein-like ridges from the noise
        ridge = _line(np.abs(n2 - 0.5), 0.035) * (0.4 + 0.6 * n1)
        img += ridge[..., None] * rest[1 % len(rest)] * 0.6
        fronds = _line(np.sin(7 * th + 9 * n1 + 4 * ph), 0.08) * (0.4 + 0.6 * n2) * np.clip(0.6 - ph, 0, 1)
        img += fronds[..., None] * rest[3 % len(rest)] * 0.25
    # stars: sparse points (density uniform on the sphere: weight by cos φ)
    m = rng.random((H, W)) < 0.0016 * np.cos(ph)
    stars = np.zeros((H, W), np.float32)
    stars[m] = rng.uniform(0.3, 1.0, m.sum())
    import cv2

    pad = 16
    s_ext = np.concatenate([stars[:, -pad:], stars, stars[:, :pad]], 1)
    s_ext = cv2.GaussianBlur(s_ext, (0, 0), 1.1) * 6 + cv2.GaussianBlur(s_ext, (0, 0), 4) * 6
    stars = np.clip(s_ext[:, pad:pad + W], 0, 1)
    img += stars[..., None] * (0.55 + 0.25 * rest[-1])[None, None]
    # orbit rings: great/small circles on the sphere (seamless by construction)
    for k in range(int(rng.integers(3, 6))):
        nrm = rng.normal(size=3)
        nrm /= np.linalg.norm(nrm)
        off = rng.uniform(-0.35, 0.35)
        dd = np.abs(d @ nrm - off)
        ring = _line(dd, 0.004) + 0.35 * _line(dd, 0.02)
        dash = np.cos(np.arctan2(d @ np.cross(nrm, [0, 1, 0]), d[..., 1]) * int(rng.integers(20, 60))) * 0.3 + 0.7
        img += (ring * dash)[..., None] * rest[k % len(rest)] * 0.55
    # luminous bodies: discs with rim light and a halo
    for k in range(int(rng.integers(2, 5))):
        c = rng.normal(size=3)
        c[1] *= 0.4
        c /= np.linalg.norm(c)
        rad = rng.uniform(0.04, 0.16)
        ang = np.arccos(np.clip(d @ c, -1, 1))
        disc = np.clip((rad - ang) / 0.006, 0, 1)
        rim = _line(ang - rad, 0.01)
        halo = np.exp(-np.maximum(ang - rad, 0) / (rad * 0.8)) * (ang > rad)
        col = rest[(k + 2) % len(rest)]
        shade = 0.25 + 0.5 * np.clip((d @ np.array([0, 1, 0])) * 0.5 + 0.5, 0, 1)
        bands = np.cos(ang / rad * 9 + k) * 0.15 + 0.85
        img = img * (1 - disc[..., None]) + disc[..., None] * col * (shade * bands)[..., None]
        img += (rim[..., None] * 0.6 + halo[..., None] * 0.25) * col
    return _finish_world(img, floor=False)  # non-periodic: passes the pattern rule as is (flashcheck pan)


GENERATORS = {"mandala_dome": mandala_dome, "tiled_hall": tiled_hall, "cosmic_field": cosmic_field}


def world(category: str, palette, seed: int) -> Image.Image:
    gen = CATEGORY_GENERATOR.get(category, "mandala_dome")
    return GENERATORS[gen](palette, seed, category)


# ---------------------------------------------------------------------------------------------- glyph beings

def glyph_alphabet(seed: int, n: int = 24) -> list[list[np.ndarray]]:
    """Seeded procedural alphabet: each glyph = 2–4 strokes over a 3×3 node grid (unit square, centred)."""
    rng = np.random.default_rng(seed)
    nodes = np.array([(x, y) for y in (-1, 0, 1) for x in (-1, 0, 1)], np.float32) * 0.5
    glyphs = []
    for _ in range(n):
        strokes = []
        for _ in range(int(rng.integers(2, 5))):
            a, b = rng.choice(9, 2, replace=False)
            p0, p1 = nodes[a], nodes[b]
            if rng.random() < 0.4:  # arc through a bulge
                mid = (p0 + p1) / 2 + rng.normal(scale=0.25, size=2)
                t = np.linspace(0, 1, 12)[:, None]
                pts = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * mid + t ** 2 * p1
            else:
                pts = np.stack([p0, p1])
            strokes.append(pts)
        if rng.random() < 0.5:
            c = nodes[int(rng.integers(9))]
            strokes.append(np.stack([c, c + 0.02]))  # a dot
        glyphs.append(strokes)
    return glyphs


TYPE_SHAPES = {
    #                 fold, head, body_w, body_h, arms, crown, tendrils, rings, segments
    "jester":         (5, 0.11, 0.17, 0.34, 1, 1, 0, 2, 2),
    "machine_elf":    (6, 0.13, 0.13, 0.22, 1, 0, 0, 3, 3),
    "luminous_feminine": (8, 0.09, 0.2, 0.5, 1, 0, 0, 2, 1),
    "deity":          (12, 0.12, 0.22, 0.42, 1, 1, 0, 4, 1),
    "alien":          (6, 0.13, 0.12, 0.38, 1, 0, 0, 1, 1),
    "creature_reptilian": (7, 0.08, 0.1, 0.5, 0, 1, 2, 1, 6),
    "creature_tentacled": (8, 0.16, 0.14, 0.12, 0, 0, 8, 2, 1),
    "creature_insectoid": (6, 0.09, 0.12, 0.36, 1, 0, 2, 1, 4),
    "creature_feline": (5, 0.12, 0.16, 0.3, 0, 1, 1, 1, 2),
    "mythological":   (9, 0.1, 0.16, 0.36, 1, 1, 0, 2, 2),
    "living_geometry": (7, 0.0, 0.25, 0.25, 0, 0, 0, 5, 1),
}


class _Canvas:
    """Accumulates coloured light and coverage. Strokes are batched per (colour, width, alpha, glow) and drawn
    antialiased into one mask per batch (fast); fills flush the batches first so layering stays in order."""

    def __init__(self, size: int, cols: list[np.ndarray]):
        self.s = size
        self.cols = cols
        self.light = np.zeros((size, size, 3), np.float32)
        self.cover = np.zeros((size, size), np.float32)
        self.pending: dict[tuple, np.ndarray] = {}

    def px(self, p):
        return (np.asarray(p, np.float32) * 0.36 + 0.5) * self.s  # unit coords ±1.38 fit the canvas

    def stroke(self, pts_list, ci: int, width: float, alpha: float = 1.0, glow: float = 0.0):
        import cv2

        key = (ci % len(self.cols), max(1, int(round(width * self.s))), round(alpha, 2), round(glow, 2))
        m = self.pending.get(key)
        if m is None:
            m = self.pending[key] = np.zeros((self.s, self.s), np.uint8)
        cv2.polylines(m, [np.round(self.px(p) * 16).astype(np.int32) for p in pts_list], False, 255, key[1],
                      cv2.LINE_AA, shift=4)

    def flush(self):
        for (ci, _w, alpha, glow), m in self.pending.items():
            self._add(m, self.cols[ci], alpha, glow)
        self.pending = {}

    def fill(self, poly_list, col, alpha: float = 1.0, glow: float = 0.0, blur: float = 0.0):
        import cv2

        self.flush()
        m = np.zeros((self.s, self.s), np.uint8)
        cv2.fillPoly(m, [np.round(self.px(p) * 16).astype(np.int32) for p in poly_list], 255, cv2.LINE_AA, shift=4)
        if blur:
            m = cv2.GaussianBlur(m, (0, 0), blur * self.s)
        self._add(m, np.asarray(col, np.float32), alpha, glow)

    def _add(self, m, col, alpha, glow):
        import cv2

        f = m.astype(np.float32) / 255.0 * alpha
        self.light = self.light * (1 - f[..., None]) + f[..., None] * col
        self.cover = np.maximum(self.cover, f)
        if glow:
            g = cv2.GaussianBlur(f, (0, 0), 0.01 * self.s) * glow
            self.light += g[..., None] * col * 0.45
            self.cover = np.maximum(self.cover, np.clip(g * 0.5, 0, 1))

    def rgba(self) -> np.ndarray:
        """Straight-alpha RGBA float with a coloured bloom (luminous, never a dark fringe)."""
        import cv2

        self.flush()
        prem = self.light
        b1 = cv2.GaussianBlur(prem, (0, 0), 0.008 * self.s)
        b2 = cv2.GaussianBlur(prem, (0, 0), 0.03 * self.s)
        bloom = 0.5 * b1 + 0.45 * b2
        light = prem + bloom * 0.6
        bl = bloom.max(-1)
        cover = np.clip(np.maximum(self.cover, bl * 1.4), 0, 1)
        rgb = _tonemap(light / np.maximum(cover, 0.05)[..., None])
        return np.dstack([rgb, cover])


def _ellipse(cx, cy, rx, ry, n=64, phase=0.0):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False) + phase
    return np.stack([cx + rx * np.cos(t), cy + ry * np.sin(t)], -1)


def _rose(cx, cy, r0, r1, petals, phase, n=360, sharp=2.0):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    r = r0 + (r1 - r0) * np.abs(np.cos(petals * (t + phase) / 2)) ** sharp
    return np.stack([cx + r * np.cos(t), cy + r * np.sin(t)], -1)


def _place(glyph, cx, cy, size, rot):
    c, s = math.cos(rot), math.sin(rot)
    R = np.array([[c, -s], [s, c]], np.float32)
    return [(p @ R.T) * size + np.array([cx, cy], np.float32) for p in glyph]


def _qbez(p0, c, p1, n=28):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * np.asarray(p0) + 2 * (1 - t) * t * np.asarray(c) + t ** 2 * np.asarray(p1)


def _crop_square(rgba: np.ndarray, size: int, margin: float = 0.05) -> Image.Image:
    a = rgba[..., 3]
    ys, xs = np.nonzero(a > 0.04)
    h, w = a.shape
    if len(xs) == 0:
        return Image.fromarray((rgba * 255).astype(np.uint8), "RGBA")
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * margin)) + 2
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    out = np.zeros((side, side, 4), np.float32)
    sx, sy = cx - side // 2, cy - side // 2
    ax0, ay0, ax1, ay1 = max(0, sx), max(0, sy), min(w, sx + side), min(h, sy + side)
    out[ay0 - sy:ay1 - sy, ax0 - sx:ax1 - sx] = rgba[ay0:ay1, ax0:ax1]
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA").resize((size, size), Image.LANCZOS)


def glyph_being(etype: str, palette, seed: int, variant: int = 0, size: int = 1024) -> Image.Image:
    """Kaleidoscopic glyph being. variant 0 = at rest, 1 = turned / unfolding, 2 = dissolving into glyphs.
    All three share the seed family (same alphabet, same body plan); only pose/phase/dissolution change."""
    rng = np.random.default_rng(seed)
    cols = _pal(palette)
    rest = cols[1:] if len(cols) > 2 else cols
    nr = len(rest)
    fold, head, bw, bh, arms, crown, tendrils, rings, segs = TYPE_SHAPES.get(etype, TYPE_SHAPES["jester"])
    alpha_set = glyph_alphabet(seed ^ 0x5EED)
    S = int(size * 1.5)  # draw larger, then crop to the figure
    cv = _Canvas(S, rest)
    turn = [0.0, 0.5, 0.25][variant] * 2 * np.pi / fold
    lift = [0.0, 0.45, 0.2][variant]
    open_ = [1.0, 1.08, 1.0][variant]
    sc = 1.35  # body scale in unit coords
    hc = np.array([0.0, (-0.45 + (0.25 - bh) * 0.5) * sc])
    chest = np.array([0.0, hc[1] + (head + 0.18) * sc])
    body_col = rest[0] * 0.5 + rest[1 % nr] * 0.3
    # 1. aura mandala (kaleidoscopic petals behind the being)
    acx, acy = (0.0, chest[1] - 0.05) if etype not in ("deity", "living_geometry") else (0.0, 0.0)
    big = 0.92 if etype in ("deity", "living_geometry") else 0.78
    for L in range(3):
        R1 = big * open_ * (1 - 0.22 * L)
        petals = fold * (1 + (L % 2))
        poly = _rose(acx, acy, R1 * 0.55, R1, petals, turn * (1 if L % 2 else -1) + L * 0.3, sharp=1.5 + L)
        cv.fill([poly], rest[(L + 1) % nr] * 0.6, 0.16 + 0.05 * L, glow=0.0, blur=0.012)
        cv.stroke([np.vstack([poly, poly[:1]])], L + 1, 0.0025, 0.8, glow=1.2)
    # spokes of glyph chains (n-fold)
    for j in range(fold * 2):
        a = 2 * np.pi * j / (fold * 2) + turn * 0.5 - np.pi / 2
        for k in range(5):
            r = (0.42 + 0.1 * k) * big * open_
            g = alpha_set[(j * 3 + k) % len(alpha_set)]
            cv.stroke(_place(g, acx + r * math.cos(a), acy + r * math.sin(a), 0.022 + 0.006 * k, a + np.pi / 2),
                      (j + k) % nr, 0.0035, 0.9, glow=0.9)
    # 2. halo rings of glyphs around the head
    for k in range(rings):
        rr = (head + 0.07 + 0.06 * k) * sc if etype != "living_geometry" else 0.2 + 0.14 * k
        cy = hc[1] if etype != "living_geometry" else 0.0
        n = fold * (k + 2)
        cv.stroke([_ellipse(0, cy, rr, rr, 180)], k + 2, 0.003, 0.7, glow=1.4)
        for j in range(n):
            a = 2 * np.pi * j / n + turn * (1 if k % 2 else -1)
            g = alpha_set[(j * 7 + k * 3) % len(alpha_set)]
            cv.stroke(_place(g, rr * math.cos(a), cy + rr * math.sin(a), 0.016 + 0.004 * k, a + np.pi / 2),
                      k + 3, 0.003, 0.95, glow=1.0)
    # 3. body
    if etype == "living_geometry":
        for k in range(5):
            r = (0.5 - 0.09 * k) * open_
            poly = _ellipse(0, 0, r, r, fold, turn * (k + 1) + np.pi / 2)
            cv.fill([poly], rest[k % nr] * 0.45, 0.35, blur=0.003)
            cv.stroke([np.vstack([poly, poly[:1]])], k + 1, 0.005, 1.0, glow=1.5)
            for v in poly:
                cv.stroke([np.stack([v, [0, 0]])], k + 2, 0.002, 0.6, glow=0.5)
            star = poly[(np.arange(fold) * 2) % fold]
            cv.stroke([np.vstack([star, star[:1]])], k + 3, 0.0025, 0.8, glow=0.8)
        cv.fill([_ellipse(0, 0, 0.05, 0.05)], rest[-1], 1.0, glow=2.5)
    else:
        y0 = hc[1] + head * sc * 1.05
        span = bh * 2 * sc
        seg_h = span / max(segs, 1)
        if etype == "luminous_feminine":
            top, bot = y0, y0 + span
            hem = np.linspace(-1, 1, 60)
            poly = np.vstack([[[-bw * 0.3 * sc, top], [bw * 0.3 * sc, top]],
                              np.stack([bw * 1.25 * sc * hem[::-1], bot + 0.03 * np.sin(hem * 9 + turn * 4)], -1)])
            cv.fill([poly], body_col, 0.75, glow=0.5, blur=0.003)
            for k in range(13):
                xk = (k - 6) / 6
                cv.stroke([_qbez([xk * bw * 0.25 * sc, top + 0.02], [xk * bw * 0.9 * sc, (top + bot) / 2 + 0.05 * math.sin(k + turn * 3)],
                                 [xk * bw * 1.2 * sc, bot])], k + 1, 0.0028, 0.8, glow=1.0)
        else:
            for s in range(segs):
                cy = y0 + seg_h * (s + 0.5)
                taper = 1.0 - 0.1 * s
                cx = 0.16 * math.sin(s * 1.1 + turn * 3) if etype == "creature_reptilian" else 0.0
                rx, ry = bw * taper * sc, seg_h * 0.56
                cv.fill([_ellipse(cx, cy, rx, ry)], body_col, 0.8, glow=0.3)
                for q in range(3):  # inner kaleidoscopic rosette on each segment
                    cv.stroke([np.vstack([p := _rose(cx, cy, min(rx, ry) * (0.25 + 0.2 * q), min(rx, ry) * (0.45 + 0.2 * q),
                                                     fold, turn + q * 0.4, 120), p[:1]])], s + q + 2, 0.002, 0.8, glow=0.6)
                cv.stroke([_ellipse(cx, cy, rx, ry)], s + 1, 0.004, 1.0, glow=1.3)
        # mirrored glyph tiles over the body (bilateral symmetry)
        for k in range(18):
            gy = y0 + rng.uniform(0.05, 0.95) * span
            gx = rng.uniform(0.05, 0.75) * bw * sc
            g = alpha_set[int(rng.integers(len(alpha_set)))]
            ci = int(rng.integers(nr))
            for sgn in (-1, 1):
                cv.stroke([p * np.array([sgn, 1], np.float32) for p in _place(g, gx, gy, 0.022, 0)], ci, 0.0028, 0.95, glow=0.7)
        if arms:  # arms / wings: glowing arcs with glyph beads, raised in variant b
            for sgn in (-1, 1):
                sh = np.array([sgn * bw * 0.85 * sc, y0 + 0.08])
                reach = (0.55 if etype != "deity" else 0.75) * open_
                tip = sh + np.array([sgn * reach, -0.32 * lift + 0.22 * (1 - lift)])
                ctrl = (sh + tip) / 2 + np.array([0, -0.2 - 0.25 * lift])
                arc = _qbez(sh, ctrl, tip)
                for w_, a_ in ((0.016, 0.35), (0.006, 0.95)):
                    cv.stroke([arc], 2, w_, a_, glow=1.0)
                for j in range(6):
                    p = arc[3 + j * 4]
                    g = alpha_set[(j * 5 + 1) % len(alpha_set)]
                    cv.stroke(_place(g, p[0], p[1] - 0.045, 0.024, sgn * j * 0.3), j + 3, 0.003, 0.9, glow=0.8)
                cv.fill([_ellipse(tip[0], tip[1], 0.022, 0.022)], rest[-1], 1.0, glow=2.0)
        for k in range(tendrils):
            sx = (k - (tendrils - 1) / 2) / max(tendrils, 1) * bw * 2.2 * sc
            t = np.linspace(0, 1, 50)
            base_y = y0 + span * (0.6 if etype == "creature_tentacled" else 1.0)
            ln = 0.75 if etype == "creature_tentacled" else 0.35
            x = sx * (1 + 0.5 * t) + 0.07 * np.sin(t * 7 + k * 1.3 + turn * 6) * t
            y = base_y + t * ln
            cv.stroke([np.stack([x, y], -1)], k + 1, 0.007, 0.5, glow=1.0)
            cv.stroke([np.stack([x, y], -1)], k + 2, 0.0025, 0.95, glow=0.6)
        if head > 0:
            hx, hy = hc
            hr = head * sc
            elong = 1.35 if etype == "alien" else 1.0
            cv.fill([_ellipse(hx, hy, hr, hr * elong)], body_col * 1.15, 0.9, glow=0.6)
            for q in range(2):
                pr = _rose(hx, hy, hr * (0.3 + 0.25 * q), hr * (0.55 + 0.3 * q), fold, turn - q * 0.5, 120)
                cv.stroke([np.vstack([pr, pr[:1]])], q + 3, 0.0022, 0.8, glow=0.8)
            cv.stroke([_ellipse(hx, hy, hr, hr * elong)], 3, 0.005, 1.0, glow=1.6)
            for sgn in (-1, 1):
                cv.fill([_ellipse(hx + sgn * hr * 0.36, hy - hr * 0.05, hr * 0.11, hr * 0.075 * elong)], rest[-1], 1.0, glow=2.2)
            if crown:
                for j in range(fold):
                    a = np.pi + np.pi * (j + 0.5) / fold
                    base = np.array([hx + hr * math.cos(a), hy + hr * elong * math.sin(a)])
                    tip = base + np.array([math.cos(a), math.sin(a)]) * (0.1 + 0.05 * (j % 2)) * (1 + lift)
                    cv.stroke([np.stack([base, tip])], j + 2, 0.006, 0.95, glow=1.2)
                    cv.fill([_ellipse(tip[0], tip[1], 0.014, 0.014)], rest[3 % nr], 1.0, glow=1.6)
    rgba = cv.rgba()
    if variant == 2:  # dissolving: the outer body thins and glyph particles drift outwards
        yy, xx = (np.mgrid[0:S, 0:S] + 0.5) / S - 0.5
        rr = np.sqrt(xx ** 2 + yy ** 2)
        rgba[..., 3] *= 1 - 0.5 * np.clip((rr - 0.15) / 0.3, 0, 1)
        pc = _Canvas(S, rest)
        for k in range(110):
            ang = rng.uniform(0, 2 * np.pi)
            r = rng.uniform(0.3, 0.95)
            g = alpha_set[int(rng.integers(len(alpha_set)))]
            pc.stroke(_place(g, r * math.cos(ang), r * math.sin(ang), 0.016 + 0.018 * (1 - r), ang), int(rng.integers(nr)),
                      0.0028, round(0.95 * (1.1 - r), 1), glow=1.0)
        p = pc.rgba()
        a = p[..., 3:] + rgba[..., 3:] * (1 - p[..., 3:])
        rgba = np.dstack([(p[..., :3] * p[..., 3:] + rgba[..., :3] * rgba[..., 3:] * (1 - p[..., 3:])) / np.maximum(a, 1e-4), a])
    return _crop_square(rgba, size)


def glyph_being_variants(etype: str, palette, seed: int) -> list[Image.Image]:
    return [glyph_being(etype, palette, seed, v) for v in range(3)]
