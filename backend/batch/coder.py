"""Report coder for validation (BUILD.md §14).

Keyword coder (the LLM coder is optional and validated separately): tags a report with the Lawrence et al.
(2022) categories. Word-boundary, case-insensitive regexes. `body` is true whenever `vibration` is.
"""
from __future__ import annotations

import re

CATEGORIES = ["entity", "geometry", "colour", "body", "vibration", "sound", "profundity"]

TARGETS = {  # Lawrence et al. 2022: share of reports mentioning
    "entity": 0.455, "geometry": 0.326, "colour": 0.252, "body": 0.375, "vibration": 0.272,
    "sound": 0.154, "profundity": 0.061,
}

KEYWORDS = {
    "entity": [r"beings?", r"entit(?:y|ies)", r"figures?", r"presences?", r"jesters?", r"elf", r"elves", r"aliens?",
               r"creatures?", r"deit(?:y|ies)", r"someone", r"somebody", r"guides?", r"spirits?", r"helpers?",
               r"visitors?", r"sprites?", r"serpents?", r"harlequins?", r"goddess", r"others? there"],
    "geometry": [r"geometr\w*", r"fractal\w*", r"patterns?", r"patterned", r"lattices?", r"kaleidoscop\w*",
                 r"tessellat\w*", r"tilings?", r"mandalas?", r"symmetr\w*", r"hexagon\w*", r"spirals?", r"spiralling",
                 r"grids?", r"tunnels?", r"polyhedr\w*", r"honeycomb\w*"],
    "colour": [r"colou?rs?", r"colou?rful", r"colou?red", r"vivid\w*", r"saturat\w*", r"hues?", r"neon", r"rainbows?",
               r"iridescen\w*", r"magenta", r"violet", r"purple", r"crimson", r"emerald", r"golden", r"gold",
               r"turquoise", r"scarlet", r"cyan", r"indigo", r"ruby", r"sapphire", r"amethyst", r"pink", r"orange"],
    "body": [r"my (?:body|chest|hands|arms|legs|limbs|skin|stomach|spine|face|head|teeth|jaw|fingers|feet)",
             r"tingl\w*", r"goosebump\w*", r"heaviness", r"weightless\w*", r"numbness", r"bodily", r"body"],
    "vibration": [r"vibrat\w*", r"buzz\w*"],
    "sound": [r"ringing", r"rang", r"hum", r"humm\w*", r"hummed", r"whin(?:e|ing)", r"high-pitched", r"carrier",
              r"static", r"crackl\w*", r"sounds?", r"noises?", r"hiss\w*", r"whistl\w*", r"tones?"],
    "profundity": [r"profound\w*", r"most meaningful", r"most important", r"most significant", r"life-changing"],
}

_RX = {k: re.compile(r"(?<![\w'-])(?:" + "|".join(v) + r")(?![\w-])", re.IGNORECASE) for k, v in KEYWORDS.items()}


def code_text(text: str) -> dict[str, bool]:
    out = {k: bool(_RX[k].search(text or "")) for k in CATEGORIES}
    if out["vibration"]:
        out["body"] = True
    return out


def categories(text: str) -> set[str]:
    return {k for k, v in code_text(text).items() if v}


def matches(text: str) -> dict[str, list[str]]:
    return {k: [m.group(0) for m in _RX[k].finditer(text or "")] for k in CATEGORIES}


def code_report(report: dict | str) -> dict[str, bool]:
    if isinstance(report, dict):
        text = " ".join(p["text"] for p in report.get("paragraphs", []))
    else:
        text = report
    return code_text(text)
