"""Report writer (BUILD.md §13.4, §13.5): language model with template fallback.

`write_report(session_dir, trip_script, intake, events, remembered, stats)` writes report.json and
simulated-trip-report.md and returns the report dict:
  {title, word_count, provenance, paragraphs: [{text, inferred, source_event_ids, sentences: [...]}]}
Template path: phrase banks in report/templates/, assembled to the target length; sentences bridging gaps are
tagged inferred. A sentence is only used if the keyword coder finds no category the report did not choose to
mention ("mentions are not occurrences", §9.1/§14).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
import yaml

from backend import llm, runtime
from backend.batch.coder import categories as code_categories
from backend.report.stats import LAYER_ORDER, render_text
from backend.safety.content import CONTENT_LIMITS, check_text

log = logging.getLogger("hyperspace.writer")
HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "templates"
DISCLAIMER = ("This is a simulation of the visuals, sounds and timing that people report from inhaled DMT. "
              "It does not reproduce the drug's effects, and its doses do not correspond to real amounts.")
MESSAGE_LEAD = "the closest I can get to putting it into words:"
LENGTH_MIN, LENGTH_MAX = 120, 900


@lru_cache(maxsize=16)
def bank(name: str) -> dict:
    return yaml.safe_load((TEMPLATES / f"{name}.yaml").read_text(encoding="utf-8"))


def words(text: str) -> int:
    return len(text.split())


@dataclass
class Sentence:
    text: str
    beat: str
    priority: int  # 0 mandatory, 1 optional, 2 filler
    inferred: bool = False
    sources: list[str] = field(default_factory=list)
    order: int = 0


# --------------------------------------------------------------------------- context

def _layer_idx(name: str) -> int:
    return LAYER_ORDER.index(name) if name in LAYER_ORDER else 0


def session_context(trip_script: dict, intake: dict | None, events: list[dict], remembered: dict) -> dict:
    evs = list(enumerate(events))
    ids = {f"e{i}": e for i, e in evs}
    rem_ids = [r["id"] for r in remembered.get("remembered", [])]
    vis = [float((e.get("payload") or {}).get("visual", 0)) for e in events if e.get("type") == "intensity_sample"]
    peak = max(vis) if vis else 0.0
    deepest = "none"
    for e in events:
        if e.get("type") == "layer_enter":
            l = (e.get("payload") or {}).get("layer")
            if l in LAYER_ORDER and _layer_idx(l) > _layer_idx(deepest):
                deepest = l
    if deepest == "none" and peak >= 0.5:
        deepest = "onset"
    hits = [e for e in events if e.get("type") == "hit"]
    hold = float(((hits[0].get("payload") or {}).get("hold_fraction", 1.0)) if hits else
                 (trip_script.get("pharmacology") or {}).get("hold_fraction", 1.0))
    by_type: dict[str, list[str]] = {}
    for i, e in evs:
        by_type.setdefault(e.get("type"), []).append(f"e{i}")
    ents = (trip_script.get("breakthrough") or {}).get("entities") or []
    appear_ids = by_type.get("entity_appear", [])
    opts = (intake or {}).get("options") if isinstance((intake or {}).get("options"), dict) else (intake or {})
    intention = ((intake or {}).get("answers") or {}).get("intention", "curiosity") if isinstance(intake, dict) else "curiosity"
    room = ((intake or {}).get("room") or {}).get("source", "default") if isinstance(intake, dict) else "default"
    return {
        "ids": ids, "remembered_ids": rem_ids, "remembered_set": set(rem_ids), "by_type": by_type,
        "peak": peak, "deepest": deepest, "hold": hold,
        "dose": str((trip_script.get("pharmacology") or {}).get("dose_step", "strong")),
        "entities": ents, "appear_ids": appear_ids,
        "ended_early": bool(by_type.get("exit_pressed")),
        "gentle": opts.get("difficult_passages") is False,
        "challenge": bool(by_type.get("challenge_start")),
        "message_shown": bool(by_type.get("message_shown")),
        "sealed": ((trip_script.get("breakthrough") or {}).get("message") or {}).get("sealed_text") or "",
        "world": (((trip_script.get("breakthrough") or {}).get("world") or {}).get("description") or ""),
        "profundity": bool((trip_script.get("report") or {}).get("profundity")),
        "length": int((trip_script.get("report") or {}).get("length_words", 311)),
        "intention": intention,
        "room": {"photo": "in my own room", "panorama": "in my own room", "default": "in the default room"}.get(room, "at home"),
        "gaps": remembered.get("gaps", []),
    }


def decide_mentions(ctx: dict, rng: np.random.Generator) -> set[str]:
    m = bank("mentions")
    li = _layer_idx(ctx["deepest"])
    out: set[str] = set()
    if li >= _layer_idx("onset"):
        if li >= _layer_idx("form_constants") and rng.random() < m["geometry_if_form_constants"]:
            out.add("geometry")
        if rng.random() < m["colour_if_onset"]:
            out.add("colour")
        if rng.random() < m["vibration"]:
            out |= {"vibration", "body"}
        if rng.random() < m["body_other"]:
            out.add("body")
        if rng.random() < m["sound"]:
            out.add("sound")
    else:
        rng.random(); rng.random(); rng.random(); rng.random(); rng.random()
    if ctx["appear_ids"]:
        if rng.random() < m["entity_if_logged"]:
            out.add("entity")
    elif li >= _layer_idx("waiting_room"):
        if rng.random() < m["presence_if_waiting_room"]:
            out |= {"entity", "presence"}
    elif li >= _layer_idx("chrysanthemum"):
        if rng.random() < m["presence_if_chrysanthemum"]:
            out |= {"entity", "presence"}
    if ctx["profundity"]:
        out.add("profundity")
    return out


def _when_ok(when: dict | None, ctx: dict) -> bool:
    if not when:
        return True
    li = _layer_idx(ctx["deepest"])
    if "layer_min" in when and li < _layer_idx(when["layer_min"]):
        return False
    if "layer_max" in when and li > _layer_idx(when["layer_max"]):
        return False
    if "layer" in when and ctx["deepest"] != when["layer"]:
        return False
    if "dose" in when and ctx["dose"] not in when["dose"]:
        return False
    if "partial" in when and (ctx["hold"] < 0.999) != bool(when["partial"]):
        return False
    if "ended_early" in when and ctx["ended_early"] != bool(when["ended_early"]):
        return False
    return True


def _first_group(groups: list[dict], ctx: dict) -> list[str]:
    for g in groups or []:
        if _when_ok(g.get("when"), ctx):
            return list(g["lines"])
    return []


def _all_groups(groups: list[dict], ctx: dict) -> list[str]:
    out = []
    for g in groups or []:
        if _when_ok(g.get("when"), ctx):
            out += list(g["lines"])
    return out


# --------------------------------------------------------------------------- template writer

class _Builder:
    def __init__(self, ctx, allowed, rng):
        self.ctx, self.allowed, self.rng = ctx, allowed, rng
        self.items: list[Sentence] = []
        self.n = 0

    def ok(self, text: str) -> bool:
        return bool(text) and code_categories(text) <= self.allowed and not check_text(text)

    def add(self, text, beat, priority, inferred=False, sources=None, force=False) -> bool:
        if any(s.text == text for s in self.items):
            return False
        if force:  # the message is always reported (its words may touch extra categories)
            if check_text(text):
                return False
            self.allowed |= code_categories(text)
        elif not self.ok(text):
            return False
        self.n += 1
        self.items.append(Sentence(text, beat, priority, inferred, list(sources or []), self.n))
        return True

    def add_one(self, lines, beat, priority, inferred=False, sources=None, force=False) -> bool:
        lines = list(lines)
        for j in self.rng.permutation(len(lines)) if lines else []:
            if self.add(self.fmt(lines[int(j)]), beat, priority, inferred, sources, force):
                return True
        return False

    def fmt(self, line: str) -> str:
        c = self.ctx
        return (line.replace("{step}", c["dose"]).replace("{intention}", c["intention"]).replace("{room}", c["room"])
                .replace("{world}", c["world"]))


def _sources(ctx, types, layers=None) -> tuple[list[str], bool]:
    """Event ids of these types (optionally layer_enter of given layers); inferred if none was remembered."""
    ids = []
    for t in types:
        for i in ctx["by_type"].get(t, []):
            e = ctx["ids"][i]
            if layers and (e.get("payload") or {}).get("layer") not in layers:
                continue
            ids.append(i)
    rem = [i for i in ids if i in ctx["remembered_set"]]
    return rem, bool(ids) and not rem


def _gap_beats(ctx) -> set[str]:
    """Beats whose time window overlaps a memory gap (fillers go there)."""
    out = set()
    enter = {}
    for i in ctx["by_type"].get("layer_enter", []):
        e = ctx["ids"][i]
        enter.setdefault((e.get("payload") or {}).get("layer"), float(e["t_min"]))
    t_fc = enter.get("form_constants", 1.0)
    t_deep = max([v for k, v in enter.items() if k in ("waiting_room", "breakthrough", "chrysanthemum")] or [t_fc + 0.5])
    windows = {"onset": (0.0, t_fc), "geometry": (t_fc, t_deep), "peak": (t_deep, t_deep + 3.0),
               "coming_back": (t_deep + 3.0, 1e9)}
    for g in ctx["gaps"]:
        for name, (a, b) in windows.items():
            if g["start_min"] < b and g["end_min"] > a:
                out.add(name)
    return out


def template_report(ctx: dict, seed: int) -> dict:
    rng = np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFFFFFF, 4242]))
    allowed = decide_mentions(ctx, rng)
    b = _Builder(ctx, allowed, rng)
    li = _layer_idx(ctx["deepest"])

    # setting + hit
    b.add_one(_first_group(bank("setting")["mandatory"], ctx), "setting", 0)
    src, inf = _sources(ctx, ["hit"])
    b.add_one(_first_group(bank("hit")["mandatory"], ctx), "hit", 0, inf, src)
    # onset (+ bodily / sound mentions)
    on = bank("onset")
    src, inf = _sources(ctx, ["layer_enter"], ["form_constants", "room"])
    b.add_one(_first_group(on["mandatory"], ctx), "onset", 0, inf, src)
    for cat in ("vibration", "body", "sound"):
        if cat in allowed and not (cat == "body" and "vibration" in allowed and rng.random() < 0.6):
            b.add_one(on["mentions"][cat], "onset", 0, inf, src)
    # geometry
    if li >= _layer_idx("form_constants"):
        ge = bank("geometry")
        src, inf = _sources(ctx, ["layer_enter"], ["form_constants", "chrysanthemum"])
        b.add_one(_first_group(ge["mandatory"], ctx), "geometry", 0, inf, src)
        for cat in ("geometry", "colour"):
            if cat in allowed:
                b.add_one(ge["mentions"][cat], "geometry", 0, inf, src)
    elif "colour" in allowed:
        b.add_one(bank("geometry")["mentions"]["colour"], "onset", 0)
    # peak, with failing descriptions from chrysanthemum up
    pk = bank("peak")
    src, inf = _sources(ctx, ["layer_enter"], [ctx["deepest"]])
    b.add_one(_first_group(pk["mandatory"], ctx), "peak", 0, inf, src)
    if li >= _layer_idx("chrysanthemum"):
        b.add_one(pk["failing"], "peak", 0, inf, src)
    # beings
    bb = bank("beings")
    beings_extra: list = []
    if "entity" in allowed:
        if ctx["appear_ids"]:
            first = ctx["ids"][ctx["appear_ids"][0]]
            p = first.get("payload") or {}
            idx = p.get("index", 0)
            ent = ctx["entities"][idx] if isinstance(idx, int) and idx < len(ctx["entities"]) else {}
            etype = p.get("type") or ent.get("type") or "living_geometry"
            remembered_appear = [i for i in ctx["appear_ids"] if i in ctx["remembered_set"]]
            if remembered_appear:
                tw = bb["types"].get(etype, ["a being"])
                tw = tw[int(rng.integers(len(tw)))]
                n = len(ctx["appear_ids"])
                lines = bb["appear_many"] if n > 1 else bb["appear"]
                lines = [l.replace("{type_word}", tw).replace("{n}", str(n)) for l in lines]
                b.add_one(lines, "beings", 0, False, remembered_appear)
                extras = []  # grown in this order (behaviours in remembered order: shuffled above v = 7)
                if ent.get("appearance"):
                    extras.append(([ent["appearance"]], remembered_appear))
                extras.append((bb["disposition"].get(ent.get("disposition", "benevolent"), []), remembered_appear))
                extras.append((bb["communication"].get(ent.get("communication", "none"), []), remembered_appear))
                for i in ctx["remembered_ids"]:
                    r = ctx["ids"][i]
                    beh = (r.get("payload") or {}).get("behaviour")
                    if r.get("type") == "entity_behaviour" and beh in bb["behaviours"]:
                        extras.append((bb["behaviours"][beh], [i]))
                beings_extra = extras
            else:
                b.add_one(bb["inferred_vague"], "beings", 0, True, [])
        elif "presence" in allowed:
            b.add_one(bb["presence"], "beings", 0, True, [])
    # message
    if ctx["message_shown"] and ctx["sealed"]:
        mb = bank("message")
        src, inf = _sources(ctx, ["message_shown"])
        lines = [l.replace("{sealed}", ctx["sealed"]) for l in mb["lead"]]
        if not b.add_one(lines, "message", 0, inf, src, force=True):
            b.add(f"There was a message, and {MESSAGE_LEAD} \"{ctx['sealed']}\"", "message", 0, inf, src, force=True)
        b.add_one(mb["after"], "message", 1, inf, src)
    # challenge
    ch = bank("challenge")
    if ctx["challenge"]:
        src, inf = _sources(ctx, ["challenge_start", "challenge_resolve"])
        flav = (ctx["ids"][ctx["by_type"]["challenge_start"][0]].get("payload") or {}).get("flavour") or "default"
        b.add_one(ch["start"].get(flav, ch["start"]["default"]), "challenge", 0, inf, src)
        b.add_one(ch["during"], "challenge", 1, inf, src)
        if ctx["by_type"].get("challenge_resolve"):
            b.add_one(ch["resolve"], "challenge", 0, inf, src)
    elif ctx["gentle"] and li >= _layer_idx("waiting_room") and rng.random() < 0.3:
        b.add_one(ch["gentle"], "challenge", 1, True, [])
    # coming back
    cb = bank("coming_back")
    src, inf = _sources(ctx, ["layer_exit", "session_end", "exit_pressed"])
    b.add_one(_first_group(cb["mandatory"], ctx), "coming_back", 0, False, src)
    # afterthoughts (+ profundity)
    af = bank("afterthoughts")
    b.add_one(_first_group(af["mandatory"], ctx), "afterthoughts", 0)
    if "profundity" in allowed:
        b.add_one(af["profundity"], "afterthoughts", 0)

    # ---- grow towards the target length with optional sentences, then inferred fillers
    target = ctx["length"]
    total = lambda: sum(words(s.text) for s in b.items)  # noqa: E731
    optional = {
        "setting": _all_groups(bank("setting")["optional"], ctx),
        "hit": _all_groups(bank("hit")["optional"], ctx),
        "onset": _all_groups(on["optional"], ctx) + [l for c in ("vibration", "body", "sound") if c in allowed for l in on["mentions"][c]],
        "geometry": (_all_groups(bank("geometry")["optional"], ctx)
                     + [l for c in ("geometry", "colour") if c in allowed for l in bank("geometry")["mentions"][c]]) if li >= 2 else [],
        "peak": _all_groups(pk["optional"], ctx) + (pk["failing"] if li >= 3 else []),
        "coming_back": _all_groups(cb["optional"], ctx),
        "afterthoughts": _all_groups(af["optional"], ctx),
    }
    gap_beats = _gap_beats(ctx)
    fillers = {
        "setting": bank("setting")["fillers"], "hit": bank("hit")["fillers"],
        "onset": on["fillers"] if "onset" in gap_beats else [],
        "geometry": bank("geometry")["fillers"] if ("geometry" in gap_beats and li >= 2) else [],
        "peak": pk["fillers"] if ("peak" in gap_beats or li >= 4) else [],
        "coming_back": cb["fillers"] if "coming_back" in gap_beats else [],
        "afterthoughts": af["fillers"],
    }
    srcs = {"hit": _sources(ctx, ["hit"]), "onset": _sources(ctx, ["layer_enter"], ["form_constants", "room"]),
            "geometry": _sources(ctx, ["layer_enter"], ["form_constants", "chrysanthemum"]),
            "peak": _sources(ctx, ["layer_enter"], [ctx["deepest"]]),
            "coming_back": _sources(ctx, ["layer_exit", "session_end"])}
    # beings first get two extras (appearance, first behaviour-ish), then everything grows round-robin
    for lines, src in beings_extra[:2]:
        b.add_one(lines, "beings", 1, False, src)
    beings_queue = list(reversed(beings_extra[2:]))
    for pool, prio in ((optional, 1), (fillers, 2)):
        queues = {k: [b.fmt(x) for x in rng.permutation(np.array(v, dtype=object))] if v else [] for k, v in pool.items()}
        progress = True
        while total() < 0.97 * target and progress:
            progress = False
            if prio == 1 and beings_queue:
                lines, src = beings_queue.pop()
                if b.add_one(lines, "beings", 1, False, src):
                    progress = True
            for beat in ["onset", "geometry", "peak", "coming_back", "afterthoughts", "setting", "hit"]:
                q = queues.get(beat) or []
                while q:
                    text = q.pop()
                    if total() + words(text) > 1.15 * target:
                        continue
                    s, inf = srcs.get(beat, ([], False))
                    if b.add(text, beat, prio, True if prio == 2 else inf, [] if prio == 2 else s):
                        progress = True
                        break
                if total() >= 0.97 * target:
                    break

    # ---- paragraphs in arc order
    groups = [["setting", "hit"], ["onset", "geometry"], ["peak", "beings", "message"], ["challenge"],
              ["coming_back"], ["afterthoughts"]]
    beat_rank = {"setting": 0, "hit": 1, "onset": 2, "geometry": 3, "peak": 4, "beings": 5, "message": 6,
                 "challenge": 7, "coming_back": 8, "afterthoughts": 9}
    paragraphs = []
    for g in groups:
        ss = sorted([s for s in b.items if s.beat in g], key=lambda s: (beat_rank[s.beat], s.priority > 1, s.order))
        if not ss:
            continue
        paragraphs.append(_paragraph([{"text": s.text, "inferred": s.inferred, "source_event_ids": s.sources} for s in ss]))
    return {"paragraphs": paragraphs, "mentions": sorted(b.allowed - {"presence"})}


def _paragraph(sentences: list[dict]) -> dict:
    srcs = []
    for s in sentences:
        for i in s["source_event_ids"]:
            if i not in srcs:
                srcs.append(i)
    return {"text": " ".join(s["text"] for s in sentences),
            "inferred": all(s["inferred"] for s in sentences),
            "source_event_ids": srcs, "sentences": sentences}


# --------------------------------------------------------------------------- language-model writer

REPORT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["title", "paragraphs"],
    "properties": {
        "title": {"type": "string", "maxLength": 120},
        "paragraphs": {"type": "array", "minItems": 2, "maxItems": 12, "items": {
            "type": "object", "additionalProperties": False, "required": ["text", "inferred"],
            "properties": {"text": {"type": "string", "minLength": 20, "maxLength": 2500}, "inferred": {"type": "boolean"}}}},
    },
}


def _describe_event(e: dict, ctx: dict) -> str:
    t, p = e.get("type"), e.get("payload") or {}
    if t == "layer_enter":
        return {"room": "the room started to breathe and drift", "form_constants": "geometric form constants appeared",
                "chrysanthemum": "dense flower-like hyperbolic geometry", "waiting_room": "an enormous fractal interior, a waiting room",
                "breakthrough": f"broke through into another world: {ctx['world']}"}.get(p.get("layer"), "a change")
    if t == "layer_exit":
        return f"left the {str(p.get('layer', '')).replace('_', ' ')} stage"
    if t == "entity_appear":
        idx = p.get("index", 0)
        ent = ctx["entities"][idx] if isinstance(idx, int) and idx < len(ctx["entities"]) else {}
        return f"a being appeared ({str(p.get('type') or ent.get('type', 'being')).replace('_', ' ')}): {ent.get('appearance', '')}"
    if t == "entity_behaviour":
        return f"the being: {str(p.get('behaviour', '')).replace('_', ' ')}"
    if t == "message_shown":
        return "the being streamed glyphs: a message"
    if t == "challenge_start":
        return f"it turned difficult ({p.get('flavour', '')})"
    if t == "challenge_resolve":
        return "the difficult part resolved into relief"
    if t == "exit_pressed":
        return "pressed Escape to end early"
    if t == "hit":
        return "took the hit"
    if t == "session_end":
        return "back in the room"
    return t.replace("_", " ")


def llm_user_prompt(ctx: dict, target: int) -> str:
    frags = []
    for i in ctx["remembered_ids"]:
        e = ctx["ids"][i]
        frags.append(f"- (t={float(e['t_min']):.1f} min) {_describe_event(e, ctx)}")
    gaps = ", ".join(f"{g['start_min']:.1f}-{g['end_min']:.1f} min" for g in ctx["gaps"]) or "none"
    facts = [f"dose step: {ctx['dose']} (simulated session)", f"deepest layer: {ctx['deepest'].replace('_', ' ')}",
             f"peak intensity: {ctx['peak']:.1f} of 10", f"inhaled fully: {'yes' if ctx['hold'] >= 0.999 else 'partly'}",
             f"ended early with Escape: {'yes' if ctx['ended_early'] else 'no'}",
             f"profundity: {'true' if ctx['profundity'] else 'false'}"]
    if ctx["message_shown"] and ctx["sealed"]:
        facts.append(f"message (quote exactly): \"{ctx['sealed']}\"")
    return ("Facts:\n" + "\n".join(f"- {f}" for f in facts)
            + "\n\nRemembered fragments, in remembered order (order may be wrong near the peak):\n" + ("\n".join(frags) or "- (almost nothing)")
            + f"\n\nGaps with nothing remembered: {gaps}\n\nWrite the report in about {target} words.")


def llm_report(ctx: dict, seed: int, logger=None) -> dict | None:
    system = (HERE / "prompts" / "writer_system.txt").read_text(encoding="utf-8").replace("{CONTENT_LIMITS}", CONTENT_LIMITS)
    target = ctx["length"]
    for attempt in range(3):
        tgt = target if attempt < 2 else max(LENGTH_MIN, int(target * 0.7))  # third try: shorter target (§0.6)
        try:
            raw = llm.chat_json(system, llm_user_prompt(ctx, tgt), REPORT_SCHEMA, seed=seed + attempt, temperature=0.8,
                                purpose="writer", num_predict=2400)
        except llm.LLMError as e:
            (logger or log.info)(f"writer attempt {attempt + 1}: {e}")
            if "connect" in str(e).lower():
                return None
            continue
        paras = [p for p in raw.get("paragraphs", []) if isinstance(p, dict) and str(p.get("text", "")).strip()]
        text = " ".join(p["text"] for p in paras)
        problems = [f"banned term {h['term']}" for h in check_text(text) + check_text(raw.get("title", ""))]
        n = words(text)
        if not (max(LENGTH_MIN, 0.6 * tgt) <= n <= min(LENGTH_MAX, 1.5 * tgt)):
            problems.append(f"length {n} for target {tgt}")
        if ctx["message_shown"] and ctx["sealed"] and MESSAGE_LEAD.lower() not in text.lower():
            problems.append("message lead phrase missing")
        if not ctx["profundity"] and "profundity" in code_categories(text):
            problems.append("profundity without flag")
        if problems:
            (logger or log.info)(f"writer attempt {attempt + 1} rejected: {problems[:3]}")
            continue
        out = []
        for p in paras:
            p["text"] = re.sub(r"^\s*\(?inferred\)?\s*[:.-]\s*", "", p["text"].strip(), flags=re.IGNORECASE)
        if "simulat" not in text.lower():  # the setting must say it was simulated (§13.4)
            paras[0]["text"] = f"This was a simulated session at the {ctx['dose']} step. " + paras[0]["text"]
        for p in paras:
            sents = [s for s in re.split(r"(?<=[.!?])\s+", p["text"].strip()) if s]
            out.append(_paragraph([{"text": s, "inferred": bool(p.get("inferred")), "source_event_ids": []} for s in sents]))
        return {"paragraphs": out, "mentions": sorted(code_categories(text))}
    return None


# --------------------------------------------------------------------------- outputs

def _front_matter(title: str, stats: dict, trip_script: dict, ctx: dict, report: dict) -> str:
    ents = [e.get("type") for e in (trip_script.get("breakthrough") or {}).get("entities") or []]
    seen = []
    for i in ctx["appear_ids"]:
        p = ctx["ids"][i].get("payload") or {}
        t = p.get("type") or (ents[p.get("index", 0)] if isinstance(p.get("index"), int) and p.get("index") < len(ents) else None)
        if t and t not in seen:
            seen.append(t)
    challenge = stats.get("difficult_passage", "NONE").lower()
    lines = ["---", f"title: {json.dumps(title, ensure_ascii=False)}", f"date: {stats.get('date')}", "simulated: true",
             f"dose_step: {ctx['dose']}", f"peak_visual: {stats.get('peak_visual')}", f"deepest_layer: {ctx['deepest']}",
             f"entities: [{', '.join(seen)}]", f"challenge: {json.dumps(challenge)}",
             f"memory_match_pct: {json.dumps(stats.get('memory_match_pct'))}", f"word_count: {report['word_count']}",
             f"planner: {(trip_script.get('provenance') or {}).get('planner', 'template')}",
             f"writer: {report['provenance']}", "tags: [simulated-trip]", "---"]
    return "\n".join(lines)


def _markdown(title: str, stats: dict, trip_script: dict, ctx: dict, report: dict, session_dir: Path) -> str:
    out = [_front_matter(title, stats, trip_script, ctx, report), "", f"# {title}", "", f"> {DISCLAIMER}", "",
           "```text", render_text(stats), "```", ""]
    for p in report["paragraphs"]:
        out += [p["text"], ""]
    out += ["*Sentences the memory model could not anchor to a remembered moment are marked as inferred in report.json "
            "and highlighted in report.html.*", ""]
    frames = sorted((session_dir / "frames").glob("*.png")) if (session_dir / "frames").exists() else []
    figs = [f for f in ("curves.png", "timeline.png", "curve_vs_drawn.png") if (session_dir / "figures" / f).exists()]
    if frames:
        out += ["## Captured frames", ""] + [f"![{f.stem}](frames/{f.name})" for f in frames] + [""]
    out += ["## Figures", ""] + [f"![{f[:-4]}](figures/{f})" for f in
                                 (figs or ["curves.png", "timeline.png", "curve_vs_drawn.png"])] + [""]
    return "\n".join(out)


def write_report(session_dir, trip_script: dict, intake: dict | None, events: list[dict], remembered: dict,
                 stats: dict, logger=None) -> dict:
    session_dir = Path(session_dir)
    seed = int(trip_script.get("seed", 0))
    ctx = session_context(trip_script, intake, events, remembered)
    body, prov = None, "template"
    if not runtime.force_templates() and llm.available():
        body = llm_report(ctx, seed, logger)
        if body is not None:
            prov = "llm"
        else:
            runtime.note_fallback("writer: template report after 3 language-model attempts")
    if body is None:
        body = template_report(ctx, seed)
    text = " ".join(p["text"] for p in body["paragraphs"])
    title = f"Simulated trip report: {stats.get('date', '')}, {ctx['dose']} step"
    report = {"title": title, "simulated": True, "word_count": words(text), "target_words": ctx["length"],
              "provenance": prov, "mentions": body.get("mentions", []), "disclaimer": DISCLAIMER,
              "paragraphs": body["paragraphs"], "gaps": ctx["gaps"]}
    (session_dir / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    (session_dir / "simulated-trip-report.md").write_text(_markdown(title, stats, trip_script, ctx, report, session_dir),
                                                          encoding="utf-8")
    return report
