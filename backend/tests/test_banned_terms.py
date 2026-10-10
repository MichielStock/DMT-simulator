"""Banned-terms checker (BUILD.md §9.2) and the content-limit text (§4.3)."""
from pathlib import Path

from backend.safety.content import BANNED_TERMS_PATH, CONTENT_LIMITS, check_obj, check_text, load_terms

ROOT = Path(__file__).resolve().parents[2]


def test_word_boundaries():
    assert check_text("a glass dome with a bass note") == []
    assert [h["term"] for h in check_text("what an ass")] == ["ass"]
    assert check_text("the classic grass") == []
    assert check_text("Bloodhound") == []  # whole words only (no prefix rule for 'blood')
    assert [h["term"] for h in check_text("blood-red light")] == ["blood"]


def test_categories_present():
    terms = set(load_terms())
    for t in ("gore", "blood", "naked", "sexual*", "jesus", "milligram*", "you should", "advice"):
        assert t in terms, t
    assert all(t == t.lower() for t in terms)


def test_hits():
    assert check_text("It was covered in GORE")[0]["term"] == "gore"
    assert check_text("the being was naked")
    assert check_text("You should call your mother")
    assert check_text("take 30 mg next time")
    assert check_text("she looked like Buddha")
    assert check_text("I was dying")
    assert check_text("mutilated shapes")[0]["term"] == "mutilat*"
    assert check_text("you'll find love")
    assert check_obj({"a": ["fine", {"b": "erotic"}]})


def test_clean_examples():
    for s in ("A tall figure made of light, robed, calm.", "Everything was already listening.",
              "The colours were insane.", "A jester juggling glowing spheres.",
              "the closest I can get to putting it into words: \"Play was what the patterns were made of.\""):
        assert check_text(s) == [], s


def test_content_limits_verbatim():
    build = (ROOT / "BUILD.md").read_text()
    for line in CONTENT_LIMITS.splitlines():
        assert line in build, line
    assert "No gore, injury, body horror" in CONTENT_LIMITS
    assert "Messages from beings" in CONTENT_LIMITS
    assert BANNED_TERMS_PATH.exists()
