"""Content safety helpers (BUILD.md §4.3, §9.2).

`check_text(text)` returns the list of banned-term hits (word-boundary, case-insensitive).
`CONTENT_LIMITS` is the §4.3 content-limit text, verbatim, for language-model system prompts.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

BANNED_TERMS_PATH = Path(__file__).with_name("banned_terms.txt")

CONTENT_LIMITS = """- **Content limits** apply to every generated image, every language-model output and every procedural effect:
  - No gore, injury, body horror, blood, or graphic death imagery.
  - No sexual or suggestive content. Feminine figures are luminous, robed or made of light and geometry.
  - No real people. Deities are vast, abstract, radiant presences, never the iconography of a specific real religion.
  - Ego dissolution is shown abstractly (outlines dissolving into geometry), never as text claiming the user is dying or harmed.
- **Messages from beings** are abstract and non-directive (attention, play, care, curiosity, wonder). They never tell the user to do anything, never give health, drug or life advice, and never predict real events or mention real people."""


def load_terms(path: Path = BANNED_TERMS_PATH) -> list[str]:
    terms = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().lower()
        if line and not line.startswith("#"):
            terms.append(line)
    return terms


def _term_regex(term: str) -> str:
    prefix = term.endswith("*")
    core = term[:-1] if prefix else term
    parts = [re.escape(p) for p in core.split()]
    body = r"\s+".join(parts)
    # word boundaries that also treat apostrophes as part of a word ("you'll")
    left = r"(?<![\w'’])"
    right = r"[\w'’]*" if prefix else r"(?![\w’]|'\w)"
    return left + body + right


@lru_cache(maxsize=4)
def _compiled(path: str = str(BANNED_TERMS_PATH)):
    terms = load_terms(Path(path))
    return [(t, re.compile(_term_regex(t), re.IGNORECASE)) for t in terms]


def check_text(text: str) -> list[dict]:
    """Return a list of hits: {"term", "match", "start"} (empty list = clean)."""
    if not text:
        return []
    norm = text.replace("’", "'")
    hits = []
    for term, rx in _compiled():
        for m in rx.finditer(norm):
            hits.append({"term": term, "match": m.group(0), "start": m.start()})
    hits.sort(key=lambda h: h["start"])
    return hits


def iter_strings(obj):
    """Yield every string inside a nested JSON-like object."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from iter_strings(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from iter_strings(v)


def check_obj(obj) -> list[dict]:
    hits = []
    for s in iter_strings(obj):
        hits.extend(check_text(s))
    return hits


def is_clean(obj) -> bool:
    return not check_obj(obj)
