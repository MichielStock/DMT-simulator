"""Image safety filter (BUILD.md §10, §0.6, §16.2 "Assets"): threshold logic, orchestration wiring with a mocked
generator and checker, and the real filter on fixtures (gpu)."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from PIL import Image

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from backend import runtime  # noqa: E402
from backend.assets import safety_filter as sf  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "images"


def _scores(unsafe=None, neutral=None, nsfw=False):
    u = {k: 0.0 for k in sf.UNSAFE}
    u.update(unsafe or {})
    n = {k: 0.0 for k in sf.NEUTRAL}
    n.update(neutral or {"abstract geometric art": 1.0 - sum(u.values())})
    return {"nsfw": nsfw, "unsafe": u, "neutral": n}


# ------------------------------------------------------------------------------------- threshold logic

def test_decide_clean():
    ok, reasons = sf.decide(_scores())
    assert ok and reasons == []


def test_decide_sum_threshold_is_conservative():
    ok, reasons = sf.decide(_scores({"gore": 0.09, "blood": 0.09, "injury": 0.08}))  # each < 0.10, sum 0.26
    assert not ok and any("sum" in r for r in reasons)
    ok, _ = sf.decide(_scores({"gore": 0.08, "blood": 0.08, "injury": 0.08}))  # 0.24
    assert ok


def test_decide_argmax_unsafe():
    ok, reasons = sf.decide(_scores({"a wound": 0.09}, {"a landscape": 0.05, "abstract geometric art": 0.05}))
    assert not ok and any("argmax" in r for r in reasons)


def test_decide_single_prompt_and_nsfw():
    assert not sf.decide(_scores({"nudity": 0.12}))[0]
    ok, reasons = sf.decide(_scores(nsfw=True))
    assert not ok and reasons == ["safety_checker_nsfw"]


def test_prompt_lists_cover_the_spec():
    assert sf.UNSAFE == ["gore", "blood", "injury", "corpse", "nudity", "a wound"]
    for p in ["abstract geometric art", "a luminous being made of light", "an ornate temple",
              "colourful fractal patterns", "a jester made of jewels", "a landscape"]:
        assert p in sf.NEUTRAL
    assert sf.UNSAFE_SUM_MAX == 0.25


# ------------------------------------------------------------------------------------- mocked orchestration

class FakeGen:
    backend = "sdxl_lightning"
    load_seconds = 0.0
    calls: list = []
    loaded = False

    def load(self):
        FakeGen.loaded = True

    def unload(self):
        pass

    def entity(self, prompt, seed, strong=False, etype=None, **kw):
        FakeGen.calls.append(("entity", seed, strong))
        return Image.open(FIX / "figure_on_black.png").convert("RGB"), {"prompt": prompt, "negative_prompt": "x",
                                                                        "guidance": 1.5 if strong else 0.0}

    def world(self, prompt, seed, strong=False, **kw):
        FakeGen.calls.append(("world", seed, strong))
        return Image.open(FIX / "panorama.jpg").convert("RGB"), {"prompt": prompt, "negative_prompt": "x",
                                                                 "guidance": 1.5 if strong else 0.0}


def _fake_filter(mode):
    class F:
        load_seconds = 0.0

        def __init__(self, *a, **k):
            pass

        def load(self):
            if mode == "broken":
                raise sf.FilterUnavailable("weights missing (test)")
            return self

        def unload(self):
            pass

        def check(self, img):
            if mode == "flag":
                s = _scores({"gore": 0.6})
                return {"ok": False, "reasons": sf.decide(s)[1], "scores": s}
            return {"ok": True, "reasons": [], "scores": _scores()}
    return F


def _script(seed=20261010):
    from backend.planner.expand import assemble_trip_script, expand_with_provenance
    from backend.planner.sampler import sample_skeleton
    from backend.tests._helpers import intake_for

    for s in range(seed, seed + 50):
        intake = intake_for(s, "breakthrough")
        sk = sample_skeleton(intake, s)
        exp, prov = expand_with_provenance(sk, intake, s)
        ts = assemble_trip_script(sk, exp, intake, None, planner=prov)
        bt = ts["breakthrough"]
        if bt["world"] and bt["entities"]:
            bt["entities"] = bt["entities"][:1]
            bt["world"]["prompts"] = bt["world"]["prompts"][:1]
            return ts
    raise AssertionError("no breakthrough script with beings")


@pytest.fixture()
def wired(monkeypatch, tmp_path):
    import backend.assets as A
    from backend.assets import cutout, imagegen

    monkeypatch.delenv("HYPERSPACE_NO_IMAGES", raising=False)
    monkeypatch.setattr(A, "_image_backend", lambda: "sdxl_lightning")
    monkeypatch.setattr(imagegen, "ImageGenerator", FakeGen)
    monkeypatch.setattr(A, "_cut_job", lambda img, use_rembg: cutout.cut_out(img, use_rembg=False))
    FakeGen.calls = []
    FakeGen.loaded = False
    sdir = tmp_path / "sess"
    (sdir / "assets").mkdir(parents=True)

    def run(mode):
        monkeypatch.setattr(sf, "SafetyFilter", _fake_filter(mode))
        ts = A.generate_assets(_script(), sdir, None)
        man = json.loads((sdir / "assets" / "manifest.json").read_text())
        return ts, man, sdir
    return run


def test_flagged_image_is_regenerated_then_replaced_by_procedural(wired):
    ts, man, sdir = wired("flag")
    ent = ts["breakthrough"]["entities"][0]
    world = ts["breakthrough"]["world"]
    # variant a: 1 try + 3 regenerations, all flagged → the being becomes a procedural glyph being
    ents = [c for c in FakeGen.calls if c[0] == "entity"]
    assert len(ents) == 4 and [c[2] for c in ents] == [False, True, True, True]
    assert len({c[1] for c in ents}) == 4  # a new seed each time
    worlds = [c for c in FakeGen.calls if c[0] == "world"]
    assert len(worlds) == 4
    assert ent["procedural"] is True and ent["sprites"] == [] and len(ent["glyph_sprites"]) == 3
    assert world["procedural"] is True and world["image"] == "assets/world_0.png"
    assert ts["provenance"]["images"] == "procedural"
    assert len(man["rejections"]) == 8 and all(r["reasons"] for r in man["rejections"])
    log = (sdir / "planner.log").read_text()
    assert log.count("REJECTED") == 8
    for p in ent["glyph_sprites"] + [world["image"]]:
        assert (sdir / p).exists()
    assert not (sdir / "assets" / "raw").exists()  # flagged images are never written


def test_filter_load_failure_means_no_generated_images(wired):
    ts, man, sdir = wired("broken")
    assert FakeGen.calls == [] and FakeGen.loaded is False  # the image model is never even loaded
    assert man["filter"]["status"] == "unavailable"
    assert any("no generated images" in f for f in man["fallbacks"])
    assert any("no generated images" in f for f in runtime.fallbacks())
    assert ts["provenance"]["images"] == "procedural"
    assert all(a["generator"] == "procedural" for a in man["assets"] if a["kind"] in ("world", "entity"))
    assert ts["breakthrough"]["entities"][0]["procedural"] is True


def test_clean_path_keeps_generated_images(wired):
    ts, man, sdir = wired("clean")
    ent = ts["breakthrough"]["entities"][0]
    assert ent["procedural"] is False and len(ent["sprites"]) == 3
    assert ts["breakthrough"]["world"]["procedural"] is False
    assert ts["provenance"]["images"] == "sdxl_lightning"
    assert man["rejections"] == []
    for p in ent["sprites"]:
        im = Image.open(sdir / p)
        assert im.mode == "RGBA" and max(im.size) <= 1024
    ents = [a for a in man["assets"] if a["kind"] == "entity"]
    assert len(ents) == 3 and all(a["filter"]["ok"] and "seed" in a and a["cutout"]["halo"]["ok"] for a in ents)
    assert man["unload"]["ok"] and runtime.resident_models() == []


# ------------------------------------------------------------------------------------- real filter (gpu)

@pytest.fixture(scope="module")
def real_filter():
    f = sf.SafetyFilter().load()
    yield f
    f.unload()
    assert all(m["name"] != sf.REGISTRY_NAME for m in runtime.resident_models())


@pytest.mark.gpu
def test_real_filter_passes_bright_abstract(real_filter):
    r = real_filter.check(Image.open(FIX / "abstract_bright.png"))
    assert r["ok"], r


@pytest.mark.gpu
def test_real_filter_zero_shot_ranks_wound_above_neutral_for_red_blotches(real_filter):
    s = real_filter.scores(Image.open(FIX / "red_blotches.png"))
    spec_neutral = ["abstract geometric art", "a luminous being made of light", "an ornate temple",
                    "colourful fractal patterns", "a jester made of jewels", "a landscape"]
    assert all(s["unsafe"]["a wound"] > s["neutral"][n] for n in spec_neutral), s
    assert not sf.decide(s)[0]


@pytest.mark.gpu
def test_real_filter_on_two_generated_images(real_filter):
    """Two small real generations (the image model loads after the filter, as in production)."""
    from backend.assets.imagegen import ImageGenerator

    g = ImageGenerator()
    try:
        a, _ = g.entity("a jester made of jewels, juggling glowing spheres", 11, size=(512, 512), etype="jester")
        b, _ = g.world("a vast faceted chamber of nested polyhedra glowing in amethyst and emerald", 12,
                       size=(1024, 512), gen_size=(1024, 512))
    finally:
        g.unload()
    for im in (a, b):
        r = real_filter.check(im)
        assert r["ok"], r
