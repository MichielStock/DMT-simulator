"""Asset generation (BUILD.md §10, §3.3, §8.1, §0.6).

`generate_assets(trip_script, session_dir, progress)` — called by the app after planning — orchestrates
room depth → worlds → entities → safety filter → cut-outs → manifest, then unloads every model and returns the
trip script with image paths filled in. Models are loaded one phase at a time (depth; then the image model with
its safety filter; rembg runs on the CPU) and all are gone (registry empty, < 200 MB allocated) on return.

`prepare_room(session_dir, source, upload=None)` writes assets/room.jpg (EXIF/GPS stripped by re-encoding,
≤ 2048 px) and assets/room_depth.png (Depth Anything V2 Small; synthetic fallback), white = near.

Contract for the front end (CONTRACTS.md amendment, assets):
- world.image / world.images: 2048×1024 seamless equirect PNGs, always present when a world is planned;
  world.procedural tells whether they are generated (false) or procedural (true).
- entities[i].sprites: three RGBA PNGs (a, b, c) when generated (procedural false); procedural beings have
  sprites [] (schema) and `glyph_sprites` (three procedural RGBA PNGs) that the breakthrough layer may use.
- assets/manifest.json (fixed path; provenance stays {planner, images}): provenance per asset (generator, seed, prompt, filter scores, rejections, fallbacks).
"""
from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from backend import runtime

# Fragmentation-free CUDA caching (must be set before torch initialises CUDA in this process): the 1536×768 world
# decode otherwise reserves 13.6 GB for 9.8 GB allocated; with expandable segments 10.4 GB (§3.3 budget 8–12 GB).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")  # (PYTORCH_ALLOC_CONF is not honoured by torch 2.9.1 here: measured)

import datetime as _dt
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor


def _image_backend() -> str:
    if runtime.no_images():
        return "procedural"
    try:
        from backend.models_registry import get_registry

        v = get_registry().get("images") or "procedural"
        return v if v in ("sdxl_lightning", "sdxl_turbo") else "procedural"
    except Exception:
        return "procedural"


IMAGE_BACKEND = _image_backend()  # what /api/status reports; procedural when generation is off
SAMPLE_ROOM = runtime.ROOT / "assets" / "sample" / "room.jpg"
MAX_SIDE = 2048
MAX_IMAGES = 12            # §10 budget: planned images per session
MAX_GEN_SECONDS = 90.0     # §10 budget: generation (incl. filter and regeneration)
PEOPLE_MAX = 0.3          # quality: crowds of ordinary people in a world backdrop → regenerate (safety_filter)
MAX_RETRIES = 3            # flagged image → up to 3 regenerations, then procedural
CUTOUT_RAMBG_WINDOW = 75.0  # rembg cut-outs that have not started this long after generation began use the key
UNLOADED_MB = 200.0
VARIANTS = "abc"
MODEL_NAMES = ("sdxl_lightning", "safety_filter", "depth_anything_v2_small", "rembg_birefnet")


class _Run:
    """State of one generate_assets call: manifest, log, progress."""

    def __init__(self, sdir: Path, progress):
        self.sdir = sdir
        self.adir = sdir / "assets"
        self.adir.mkdir(parents=True, exist_ok=True)
        self.progress = progress
        self.t0 = time.time()
        self.manifest: dict = {"version": 1, "created": _dt.datetime.now().isoformat(timespec="seconds"),
                               "backend": "procedural", "filter": {"status": "skipped"}, "assets": [],
                               "rejections": [], "fallbacks": [], "budget": {"max_images": MAX_IMAGES,
                               "max_seconds": MAX_GEN_SECONDS, "images_generated": 0, "generation_seconds": 0.0}}
        self._lock = threading.Lock()

    def log(self, msg: str) -> None:
        with self._lock, open(self.sdir / "planner.log", "a", encoding="utf-8") as f:
            f.write(f"{_dt.datetime.now().isoformat(timespec='seconds')} assets: {msg}\n")

    def say(self, stage: str, detail: str) -> None:
        if self.progress:
            try:
                self.progress(stage, detail)
            except Exception:
                pass

    def fallback(self, text: str) -> None:
        if text not in self.manifest["fallbacks"]:
            self.manifest["fallbacks"].append(text)
        runtime.note_fallback(text)
        self.log("fallback: " + text)

    def add(self, rec: dict) -> dict:
        with self._lock:
            self.manifest["assets"].append(rec)
        return rec

    def write(self) -> None:
        p = self.adir / "manifest.json"
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.manifest, indent=1, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)


def _palette(script: dict) -> list[str]:
    return list((script.get("palette") or {}).get("colours") or [])


def _palette_words(script: dict) -> str | None:
    """Palette name → colour words (planner phrase bank), appended to image prompts so beings and worlds carry the
    trip palette even when the language model's prompt does not name colours."""
    try:
        import yaml

        words = yaml.safe_load((runtime.ROOT / "backend" / "planner" / "templates" / "worlds.yaml").read_text())["palette_words"]
        return words.get((script.get("palette") or {}).get("name"))
    except Exception:
        return None


def _entity_prompts(ent: dict) -> list[str]:
    ps = [p for p in (ent.get("prompts") or []) if isinstance(p, str) and p.strip()]
    base = ps[0] if ps else f"a luminous {ent.get('type', 'being').replace('_', ' ')} made of light and geometry"
    while len(ps) < 3:
        ps.append(base + [", turning slightly", ", unfolding into patterns"][len(ps) - 1])
    return ps[:3]


def _procedural_world(run: _Run, category: str, palette, seed: int, k: int, reason: str) -> str:
    from backend.assets import procedural
    from backend.assets.imagegen import seam_score

    img = procedural.world(category, palette, seed)
    name = f"assets/world_{k}.png"
    img.save(run.sdir / name)
    run.add({"path": name, "kind": "world", "index": k, "generator": "procedural",
             "procedural": procedural.CATEGORY_GENERATOR.get(category, "mandala_dome"), "seed": seed,
             "reason": reason, "seam": seam_score(img)})
    return name


def _procedural_being(run: _Run, ent: dict, i: int, palette, seed: int, reason: str, pool=None) -> list[str]:
    from backend.assets import procedural

    etype = ent.get("type", "living_geometry")
    names = [f"assets/entity_{i}_{v}.png" for v in VARIANTS]

    def one(v):
        procedural.glyph_being(etype, palette, seed, v).save(run.sdir / names[v])

    if pool is not None:
        list(pool.map(one, range(3)))
    else:
        for v in range(3):
            one(v)
    for v, n in enumerate(names):
        run.add({"path": n, "kind": "entity", "index": i, "variant": VARIANTS[v], "generator": "procedural",
                 "procedural": "glyph_being", "seed": seed, "reason": reason})
    return names


def _room_step(run: _Run, script: dict, meter, allow_models: bool) -> None:
    room = script.get("room") or {}
    src = room.get("source", "default")
    if src not in ("photo", "panorama"):
        run.manifest["room"] = {"source": "default", "depth": None}
        return
    img_p, dep_p = run.adir / "room.jpg", run.adir / "room_depth.png"
    meta = _read_json(run.adir / "room_meta.json")
    src = meta.get("source", src)
    if img_p.exists() and allow_models and meta.get("depth_source") != "depth_anything_v2_small":
        from backend.assets.depth import room_depth

        run.say("room", "measuring the depth of your room")
        with meter.phase("room"):
            d, how = room_depth(Image.open(img_p).convert("RGB"), panorama=(src == "panorama"))
        d.save(dep_p)
        meta.update(depth_source=how)
        (run.adir / "room_meta.json").write_text(json.dumps(meta))
    run.manifest["room"] = {"source": src, "image": "assets/room.jpg", "depth": "assets/room_depth.png",
                            "depth_source": meta.get("depth_source", "synthetic"), "convention": "white = near"}
    run.add({"path": "assets/room_depth.png", "kind": "room_depth", "generator": meta.get("depth_source", "synthetic")})


def _read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _verify_unloaded(run: _Run) -> dict:
    from backend.assets import cutout
    from backend.assets.vram import free_gpu

    cutout.unload()
    for n in MODEL_NAMES:
        runtime.unregister(n)
    deadline = time.time() + 15
    mb = free_gpu()
    while mb >= UNLOADED_MB and time.time() < deadline:
        time.sleep(0.25)
        mb = free_gpu()
    mine = [m for m in runtime.resident_models() if m.get("name") in MODEL_NAMES]
    res = {"allocated_mb": round(mb, 1), "resident": [m.get("name") for m in runtime.resident_models()],
           "ok": mb < UNLOADED_MB and not mine}
    if not res["ok"]:
        run.log(f"unload incomplete: {res}")
    return res


def generate_assets(trip_script: dict, session_dir, progress: Callable[[str, str], None] | None = None) -> dict:
    """Fill trip_script with asset paths (see module docstring). Never raises for model problems: every failure
    moves to the §0.6 fallback and is recorded in assets/manifest.json and /api/status fallbacks."""
    from backend.assets.vram import PhaseMeter

    sdir = Path(session_dir)
    run = _Run(sdir, progress)
    meter = PhaseMeter()
    script = trip_script
    seed = int(script.get("seed") or 0)
    palette = _palette(script)
    colours = _palette_words(script)
    bt = script.get("breakthrough") or {}
    world = bt.get("world")
    ents = bt.get("entities") or []
    backend = _image_backend()
    allow_models = not runtime.no_images()
    try:
        _room_step(run, script, meter, allow_models)
    except Exception as e:
        run.fallback(f"room depth: kept existing depth ({type(e).__name__})")

    if not world and not ents:  # room-only fast path (threshold / light doses)
        run.log("room-only fast path: no breakthrough assets planned")
        script.setdefault("provenance", {})["images"] = "procedural"
        run.manifest["unload"] = _verify_unloaded(run)
        run.manifest["phases"] = meter.phases
        run.manifest["seconds"] = round(time.time() - run.t0, 2)
        run.write()
        run.say("unloading", "nothing to clear")
        return script

    # ---- plan the image budget: beings first (3 each, keeping 1 for a world), then worlds
    world_prompts = []
    if world:
        world_prompts = [p for p in (world.get("prompts") or [world.get("prompt")]) if isinstance(p, str) and p][:3] or [""]
    gen_beings = []
    left = MAX_IMAGES - (1 if world else 0)
    for i in range(len(ents)):
        if left >= 3:
            gen_beings.append(i)
            left -= 3
    n_worlds = min(len(world_prompts), 1 + left) if world else 0
    run.manifest["plan"] = {"worlds": n_worlds, "beings_generated": gen_beings, "beings_total": len(ents)}

    gen = filt = None
    use_gen = allow_models and backend != "procedural"
    if not allow_models:
        run.fallback("images: procedural (HYPERSPACE_NO_IMAGES=1)")
    elif backend == "procedural":
        run.fallback("images: procedural (no image model verified at setup)")
    if use_gen:  # the filter loads FIRST: if it cannot load, no generated image is ever used (§10, §0.6)
        from backend.assets.safety_filter import FilterUnavailable, SafetyFilter

        run.say("images", "waking the safety filter")
        try:
            with meter.phase("images"):
                filt = SafetyFilter().load()
            run.manifest["filter"] = {"status": "loaded", "seconds": filt.load_seconds}
        except FilterUnavailable as e:
            run.manifest["filter"] = {"status": "unavailable", "error": str(e)}
            run.fallback("image safety filter unavailable: no generated images (procedural everything)")
            use_gen = False
    if use_gen:
        from backend.assets.imagegen import ImageGenerator

        run.say("images", "waking the image model")
        try:
            with meter.phase("images"):
                gen = ImageGenerator()
                gen.load()
            run.manifest["backend"] = gen.backend
            run.manifest["image_model_load_seconds"] = gen.load_seconds
        except Exception as e:
            run.fallback(f"image model failed to load ({type(e).__name__}): procedural worlds and glyph beings")
            run.manifest["image_model_error"] = f"{type(e).__name__}: {str(e)[:200]}"
            use_gen = False
            if gen is not None:
                gen.unload()
            gen = None

    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cutout")
    proc_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="procedural")
    cut_futs: dict[int, list] = {}
    gen_t0 = time.time()
    world_paths: list[str] = []
    generated_any = False

    def budget_left() -> bool:
        return time.time() - gen_t0 < MAX_GEN_SECONDS

    def produce(kind: str, label: str, fn, prompt: str, base_seed: int):
        """Generate → filter (+ dark-background check for beings) → up to 3 regenerations (new seed, stronger
        negative prompt). → (img, record, rejected attempts)."""
        from backend.assets.imagegen import background_check

        attempts = []
        for attempt in range(1 + MAX_RETRIES):
            if not budget_left():
                attempts.append({"skipped": "time budget exhausted"})
                break
            s = base_seed + 7919 * attempt
            run.say("images", label if attempt == 0 else f"{label}, again ({attempt}/{MAX_RETRIES})")
            t = time.time()
            with meter.phase("images"):
                img, meta = fn(prompt, s, attempt > 0)
                chk = filt.check(img)
            run.manifest["budget"]["images_generated"] += 1
            rec = {"seed": s, "attempt": attempt, "seconds": round(time.time() - t, 2), **meta,
                   "filter": {"ok": chk["ok"], "reasons": chk["reasons"], "scores": chk["scores"]}}
            if chk["ok"] and kind == "entity":
                bg = background_check(img)
                rec["background"] = bg
                if not bg["ok"]:
                    chk = {**chk, "reasons": [f"background not flat dark ({bg})"]}
            if chk["ok"] and kind == "world" and hasattr(filt, "people_score"):
                ps = filt.people_score(img)
                rec["people_score"] = ps
                if ps >= PEOPLE_MAX:
                    chk = {**chk, "reasons": [f"people in the world (score {ps} >= {PEOPLE_MAX})"]}
            if not chk["reasons"]:
                return img, rec, attempts
            rej = {"kind": kind, "label": label, "reasons": list(chk["reasons"]), **rec}
            attempts.append(rej)
            with run._lock:
                run.manifest["rejections"].append(rej)
            run.log(f"REJECTED {label} seed={s}: {', '.join(chk['reasons'])}")
            del img  # a flagged image is never written to disk
        return None, None, attempts

    try:
        # ---- beings (first, so the CPU cut-outs overlap the remaining GPU work)
        for i, ent in enumerate(ents):
            ent_seed = (seed * 1009 + 101 * (i + 1)) & 0x7FFFFFFF
            if not (use_gen and i in gen_beings and budget_left()):
                reason = ("over the 12-image budget" if use_gen and i not in gen_beings else
                          "time budget exhausted" if use_gen else "generation off")
                if use_gen:
                    run.log(f"being {i}: procedural ({reason})")
                ent["_proc"] = (ent_seed, reason)
                continue
            prompts = _entity_prompts(ent)
            got = []
            for v in range(3):
                label = f"being {i + 1}/{len(ents)} ({VARIANTS[v]})"
                img, rec, attempts = produce("entity", label,
                                             lambda p, s, strong: gen.entity(p, s, strong, etype=ent.get("type"), colours=colours),
                                             prompts[v], ent_seed + v)
                if img is None:
                    got = None
                    ent["_proc"] = (ent_seed, f"variant {VARIANTS[v]} rejected {len(attempts)}× or out of time")
                    run.log(f"being {i}: replaced by a procedural glyph being ({ent['_proc'][1]})")
                    break
                rec.update(rejections=attempts)
                got.append((img, rec))
            if not got:
                continue
            generated_any = True
            futs = []
            for v, (img, rec) in enumerate(got):
                raw = f"assets/raw/entity_{i}_{VARIANTS[v]}.jpg"
                (run.adir / "raw").mkdir(exist_ok=True)
                img.save(run.sdir / raw, "JPEG", quality=90)
                use_rembg = time.time() - gen_t0 < CUTOUT_RAMBG_WINDOW
                futs.append((v, rec, raw, pool.submit(_cut_job, img, use_rembg)))
            cut_futs[i] = futs

        # ---- worlds
        if world:
            cat = world.get("category", "dome_temple")
            for k in range(max(1, len(world_prompts))):
                wseed = (seed * 7 + 13 * (k + 1)) & 0x7FFFFFFF
                name = f"assets/world_{k}.png"
                if use_gen and k < n_worlds and budget_left():
                    img, rec, attempts = produce("world", f"world {k + 1}/{n_worlds}",
                                                     lambda p, s, strong: gen.world(p, s, strong, colours=colours),
                                                     world_prompts[k], wseed)
                    if img is not None:
                        from backend.assets.imagegen import seam_score

                        img.save(run.sdir / name)
                        run.add({"path": name, "kind": "world", "index": k, "generator": gen.backend,
                                 "seam": seam_score(img), "rejections": attempts, **rec})
                        world_paths.append(name)
                        generated_any = True
                        continue
                    if k == 0:
                        run.say("images", "world: building a procedural world instead")
                        world_paths.append(_procedural_world(run, cat, palette, wseed, k,
                                                             f"rejected {len(attempts)}× or out of time"))
                    continue
                if k == 0 or not use_gen:
                    if k == 0:
                        run.say("images", f"world {k + 1}: procedural geometry")
                        world_paths.append(_procedural_world(run, cat, palette, wseed, k, "generation off"
                                                             if not use_gen else "over budget"))
                    break
    finally:
        run.manifest["budget"]["generation_seconds"] = round(time.time() - gen_t0, 2)
        if gen is not None:
            gen.unload()
        if filt is not None:
            filt.unload()
        run.say("images", "image model put away")

    # ---- cut-outs (CPU) and procedural beings
    done = 0
    total = sum(len(v) for v in cut_futs.values())
    with meter.phase("cutouts"):
        for i, futs in cut_futs.items():
            ent = ents[i]
            sprites, ok = [], True
            for v, rec, raw, fut in futs:
                try:
                    sprite, info = fut.result(timeout=180)
                except Exception as e:
                    ok = False
                    run.log(f"being {i} variant {VARIANTS[v]}: cut-out failed ({type(e).__name__}: {e})")
                    break
                done += 1
                run.say("images", f"cutting out beings {done}/{total}")
                name = f"assets/entity_{i}_{VARIANTS[v]}.png"
                sprite.save(run.sdir / name)
                if info.get("fallback"):
                    run.fallback("entity cut-outs: luminance/chroma key for some sprites")
                run.add({"path": name, "kind": "entity", "index": i, "variant": VARIANTS[v], "generator": run.manifest["backend"],
                         "raw": raw, "cutout": info, **rec})
                sprites.append(name)
            if ok and len(sprites) == 3:
                ent["sprites"] = sprites
                ent["procedural"] = False
            else:
                ent["_proc"] = ((seed * 1009 + 101 * (i + 1)) & 0x7FFFFFFF, "cut-out failed")
    pool.shutdown(wait=True)
    procs = [(i, e) for i, e in enumerate(ents) if "_proc" in e]
    for n, (i, ent) in enumerate(procs):
        s, reason = ent.pop("_proc")
        run.say("images", f"glyph being {n + 1}/{len(procs)}")
        ent["glyph_sprites"] = _procedural_being(run, ent, i, palette, s, reason, proc_pool)
        ent["sprites"] = []
        ent["procedural"] = True
    proc_pool.shutdown(wait=True)

    # ---- trip script + manifest
    if world:
        world["image"] = world_paths[0] if world_paths else None
        world["images"] = world_paths[:3]
        world["procedural"] = not any(a.get("kind") == "world" and a.get("generator") != "procedural"
                                      for a in run.manifest["assets"] if a.get("path") == world["image"])
    used_gen = generated_any and any(a.get("generator") not in ("procedural", None) and a.get("kind") in ("world", "entity")
                                     for a in run.manifest["assets"])
    prov = script.setdefault("provenance", {})
    prov["images"] = run.manifest["backend"] if used_gen else "procedural"
    run.say("unloading", "putting every model away")
    run.manifest["unload"] = _verify_unloaded(run)
    run.manifest["phases"] = meter.phases
    run.manifest["seconds"] = round(time.time() - run.t0, 2)
    run.write()
    run.log(f"done in {run.manifest['seconds']} s: {len(run.manifest['assets'])} assets, "
            f"{len(run.manifest['rejections'])} rejections, unload={run.manifest['unload']}")
    return script


def _cut_job(img: Image.Image, use_rembg: bool):
    from backend.assets import cutout

    return cutout.cut_out(img, use_rembg=use_rembg)


# --------------------------------------------------------------------------- room

def _procedural_room(w: int = 1600, h: int = 1000) -> Image.Image:
    """A plain, warm interior used when no sample photo exists (fallback for assets/sample/room.jpg)."""
    img = Image.new("RGB", (w, h), (182, 160, 132))
    d = ImageDraw.Draw(img)
    horizon = int(h * 0.68)
    for y in range(horizon):  # wall with soft vertical light falloff
        k = 0.85 + 0.15 * (1 - abs(y / horizon - 0.4))
        d.line([(0, y), (w, y)], fill=(int(196 * k), int(178 * k), int(150 * k)))
    for y in range(horizon, h):  # wooden floor
        k = 0.7 + 0.3 * (y - horizon) / (h - horizon)
        d.line([(0, y), (w, y)], fill=(int(120 * k), int(84 * k), int(56 * k)))
    d.rectangle([int(w * 0.62), int(h * 0.12), int(w * 0.86), int(h * 0.5)], fill=(210, 226, 238), outline=(240, 236, 228), width=10)
    d.line([(int(w * 0.74), int(h * 0.12)), (int(w * 0.74), int(h * 0.5))], fill=(240, 236, 228), width=6)
    d.rectangle([int(w * 0.08), int(h * 0.16), int(w * 0.30), int(h * 0.66)], fill=(110, 78, 54))
    for i, y in enumerate(range(int(h * 0.22), int(h * 0.64), int(h * 0.1))):
        d.line([(int(w * 0.08), y), (int(w * 0.30), y)], fill=(80, 56, 38), width=8)
        for j in range(8):
            x = int(w * 0.09) + j * int(w * 0.026)
            d.rectangle([x, y - int(h * 0.07), x + int(w * 0.018), y - 4],
                        fill=[(150, 60, 60), (60, 90, 140), (200, 170, 90), (70, 120, 80)][(i + j) % 4])
    d.rounded_rectangle([int(w * 0.32), int(h * 0.5), int(w * 0.70), int(h * 0.78)], radius=30, fill=(92, 104, 120))
    d.rounded_rectangle([int(w * 0.34), int(h * 0.44), int(w * 0.68), int(h * 0.58)], radius=30, fill=(104, 118, 136))
    d.ellipse([int(w * 0.88), int(h * 0.55), int(w * 0.96), int(h * 0.7)], fill=(150, 96, 70))
    for a in range(12):
        x0 = int(w * 0.92)
        d.line([(x0, int(h * 0.56)), (x0 + int(60 * np.cos(a * 0.5)), int(h * 0.56) - int(90 + 40 * np.sin(a)))],
               fill=(60, 130, 70), width=10)
    return img.filter(ImageFilter.GaussianBlur(1.2))


def _load_upload(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # respect orientation, then drop all metadata by re-encoding
    return img.convert("RGB")


def _downscale(img: Image.Image) -> Image.Image:
    w, h = img.size
    s = MAX_SIDE / max(w, h)
    if s < 1:
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    return img


def synthetic_depth(img: Image.Image) -> Image.Image:
    """§0.6 fallback: vertical gradient (near at the bottom = bright) + edge-aware blur guided by the photo."""
    import cv2

    w, h = img.size
    grad = np.tile(np.linspace(0.15, 1.0, h, dtype=np.float32)[:, None], (1, w))
    gray = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
    # brighter, flatter regions (walls, windows) read slightly further away
    lum = cv2.GaussianBlur(gray, (0, 0), sigmaX=max(2.0, w / 120))
    depth = np.clip(0.8 * grad + 0.2 * (1.0 - lum), 0, 1)
    guide = (gray * 255).astype(np.uint8)
    d8 = (depth * 255).astype(np.uint8)
    for _ in range(2):  # edge-aware smoothing: bilateral on depth, then snap to photo edges
        d8 = cv2.bilateralFilter(d8, 9, 40, 9)
    edges = cv2.Canny(guide, 60, 160)
    d8 = np.where(edges > 0, cv2.medianBlur(d8, 5), d8).astype(np.uint8)
    return Image.fromarray(d8, mode="L")


def prepare_room(session_dir, source: str = "photo", upload: bytes | None = None) -> dict:
    """Write assets/room.jpg (metadata stripped, ≤ 2048 px), assets/room_depth.png (white = near) and
    assets/room_meta.json. A 2:1 equirectangular image (within 5%) is a panorama; a "panorama" that is not 2:1 is
    treated as a photo (§0.6). Returns the API response dict."""
    from backend.assets import panorama

    session_dir = Path(session_dir)
    adir = session_dir / "assets"
    adir.mkdir(parents=True, exist_ok=True)
    if upload:
        img = _load_upload(upload)
    elif SAMPLE_ROOM.exists():
        img = _load_upload(SAMPLE_ROOM.read_bytes())
    else:
        img = _procedural_room()
    src = source if source in ("photo", "panorama") else "photo"
    if panorama.is_equirect(img.size) and (src == "panorama" or img.size[0] >= 1500):
        src = "panorama"
        img = panorama.to_equirect(img)
    elif src == "panorama":
        src = "photo"
        runtime.note_fallback("panorama: not 2:1, treated as photo")
    img = _downscale(img)
    clean = Image.new("RGB", img.size)  # a fresh image: no EXIF, GPS, XMP or ICC metadata survives
    clean.paste(img)
    clean.save(adir / "room.jpg", "JPEG", quality=92)
    try:
        from backend.assets.depth import room_depth

        depth, how = room_depth(clean, panorama=(src == "panorama"))
        from backend.assets.depth import LAST_PHASE

        vram = dict(LAST_PHASE) if how != "synthetic" else {}
    except Exception as e:  # never fail an upload over depth
        runtime.note_fallback(f"room depth: synthetic ({type(e).__name__})")
        depth, how, vram = synthetic_depth(clean), "synthetic", {}
    depth.save(adir / "room_depth.png")
    (adir / "room_meta.json").write_text(json.dumps({"source": src, "size": list(clean.size), "depth_source": how,
                                                      "depth_convention": "white = near", "vram": vram}))
    return {"image": "assets/room.jpg", "depth": "assets/room_depth.png", "source": src}
