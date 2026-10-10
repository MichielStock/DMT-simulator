"""Template writer phrase banks: every sentence codes to exactly the categories its group declares, so the
writer's mention choices are what the validation coder measures (BUILD.md §14)."""
from pathlib import Path

import yaml

from backend.batch.coder import categories, code_text
from backend.safety.content import check_text

TDIR = Path(__file__).resolve().parents[1] / "report" / "templates"
NEUTRAL = set()


def _lines(groups):
    out = []
    for g in groups or []:
        out += g["lines"]
    return out


def _check(lines, expected, where):
    for s in lines:
        s2 = s.replace("{step}", "strong").replace("{intention}", "curiosity").replace("{room}", "in my own room")
        if "{" in s2:
            continue
        got = categories(s2)
        assert got == expected, (where, s, got, expected)
        assert check_text(s2) == [], (where, s)


def test_neutral_and_tagged_sentences():
    for beat in ("setting", "hit", "onset", "geometry", "peak", "coming_back", "afterthoughts"):
        b = yaml.safe_load((TDIR / f"{beat}.yaml").read_text())
        _check(_lines(b.get("mandatory")) + _lines(b.get("optional")) + b.get("fillers", []), NEUTRAL, beat)
        for cat, lines in (b.get("mentions") or {}).items():
            exp = {"vibration", "body"} if cat == "vibration" else {cat}
            _check(lines, exp, f"{beat}.{cat}")
    peak = yaml.safe_load((TDIR / "peak.yaml").read_text())
    _check(peak["failing"], NEUTRAL, "peak.failing")
    af = yaml.safe_load((TDIR / "afterthoughts.yaml").read_text())
    _check(af["profundity"], {"profundity"}, "profundity")
    ch = yaml.safe_load((TDIR / "challenge.yaml").read_text())
    for k, v in ch.items():
        lines = [x for vv in v.values() for x in vv] if isinstance(v, dict) else v
        _check(lines, NEUTRAL, f"challenge.{k}")
    msg = yaml.safe_load((TDIR / "message.yaml").read_text())
    _check(msg["after"], NEUTRAL, "message.after")


def test_being_sentences_code_as_entity():
    b = yaml.safe_load((TDIR / "beings.yaml").read_text())
    for t, words in b["types"].items():
        for w in words:
            assert code_text(w)["entity"], (t, w)
            assert categories(w) == {"entity"}, (t, w, categories(w))
    for k in ("presence", "inferred_vague"):
        for s in b[k]:
            assert categories(s) == {"entity"}, s
    for group in ("behaviours", "disposition", "communication"):
        for lines in b[group].values():
            for s in lines:
                assert categories(s) <= {"entity"}, s
                assert check_text(s) == []
