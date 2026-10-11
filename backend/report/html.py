"""report.html (BUILD.md §13.5, §15.1): amber terminal header + stats box, a hero frame, the snapshot strip
(chronological, captioned), the disclaimer, the report with inferred sentences highlighted, the lab view and the
remembered-vs-logged columns. A fixed "SIMULATED" watermark, a sticky action bar ([D] download .zip, [P] print,
[R] replay, [T] title, same keys bound by a tiny inline script) and a light print stylesheet.

Two renderings of the same page:
- `report.html` (served by the back end): relative image links, fonts from /fonts.
- `report-standalone.html`: everything inline (CSS, both fonts and every image as data URIs), so the single file
  opens anywhere offline; it goes into the export zip as report.html. Its action bar only offers [P] PRINT.
Also `export_report` for REPORT_EXPORT_DIR and `rebuild_html` for sessions reported by an older version.
"""
from __future__ import annotations

import base64
import hashlib
import html as _h
import io
import os
import shutil
from functools import lru_cache
from pathlib import Path

from backend import runtime
from backend.report.frames import fmt_ms, hero_frame, layer_label, list_frames
from backend.report.stats import render_text
from backend.report.writer import DISCLAIMER

FONTS = runtime.ROOT / "frontend" / "public" / "fonts"
STANDALONE = "report-standalone.html"
INLINE_MAX_W = 1600      # standalone: frames re-encoded as JPEG at most this wide (the zip keeps the PNGs)
INLINE_JPEG_Q = 85
MAX_SNAPS = 6           # periodic snapshots shown in the strip (main.ts takes at most 6 since D-F3)

CSS = """
:root { --bg: #0a0700; --amber: #ffb000; --soft: #ffd27a; --dim: #7a5400; --line: #3a2900; --cyan: #4fe3ff; }
* { box-sizing: border-box; }
/* the background lives on <html> only, so the SIMULATED watermark (z-index -1) sits behind the content */
html { background: var(--bg); color: var(--amber); margin: 0; scroll-padding-top: 64px;
  background-image: repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,.08) 3px); }
body { background: transparent; color: var(--amber); margin: 0; position: relative;
  font-family: 'HyperspaceBox', 'VT323', monospace; font-size: 22px; line-height: 1.3; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 40px 32px 120px; }
a { color: var(--amber); text-decoration: none; }
a:hover, a:focus-visible { color: var(--cyan); outline: none; }

/* sticky action bar: a thin full-width strip, keys at the top right of the text column */
.bar { position: sticky; top: 0; z-index: 20; background: rgba(10,7,0,.94); border-bottom: 1px solid var(--line); }
.bar .in { max-width: 1120px; margin: 0 auto; padding: 8px 32px; display: flex; align-items: center; gap: 6px; }
.bar .who { flex: 1; color: var(--dim); letter-spacing: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions { display: flex; gap: 4px; }
.actions a { padding: 2px 12px; letter-spacing: 1px; white-space: nowrap; }
.actions a b { font-weight: normal; color: var(--dim); }
.actions a.primary b { color: var(--cyan); }
.actions a:hover, .actions a:focus-visible { background: var(--amber); color: var(--bg); }
.actions a:hover b, .actions a:focus-visible b { color: var(--bg); }
.sep { color: var(--dim); padding: 0 .5ch; }

header { border-bottom: 3px double var(--dim); padding-bottom: 14px; margin-bottom: 28px; }
header .eyebrow { color: var(--dim); letter-spacing: 3px; }
header h1 { font-weight: normal; font-size: 64px; line-height: 1; margin: 6px 0 8px; letter-spacing: 3px;
  text-shadow: 0 0 6px rgba(255,176,0,.35); }
header .sub { font-size: 26px; letter-spacing: 2px; }

.top { display: grid; grid-template-columns: auto 1fr; gap: 56px; align-items: start; margin-bottom: 40px; }
.toc { margin-top: 4px; }
.toc .hd { color: var(--dim); letter-spacing: 3px; margin-bottom: 10px; }
.toc a { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 24px; }
.toc a .dots { flex: 1; border-bottom: 2px dotted var(--line); transform: translateY(-5px); }
.toc a .v { color: var(--dim); }
.toc a:hover .v, .toc a:focus-visible .v { color: var(--cyan); }
.toc .note { color: var(--dim); margin-top: 18px; font-size: 20px; line-height: 1.35; }
pre.box { font-family: 'HyperspaceBox', 'VT323', monospace; font-size: 24px; line-height: 1.1; margin: 0; white-space: pre;
  overflow-x: auto; text-shadow: 0 0 3px rgba(255,176,0,.3); }
pre.box .you { color: var(--cyan); }

h2 { font-weight: normal; font-size: 34px; letter-spacing: 2px; margin: 64px 0 20px; padding-bottom: 6px;
  border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; }
h2 .count { color: var(--dim); font-size: 24px; }

figure { margin: 0; }
figure.hero { margin: 8px 0 0; }
figure.hero .frame { border: 1px solid var(--amber); padding: 6px; box-shadow: 0 0 18px rgba(255,176,0,.12); }
figure.hero img { display: block; width: 100%; height: auto; }
figure.hero figcaption { display: flex; justify-content: space-between; margin-top: 8px; color: var(--dim); }
figure.hero figcaption .what { color: var(--amber); }

ol.strip { list-style: none; margin: 0; padding: 0; display: grid; gap: 26px 22px;
  grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 1000px) { ol.strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { ol.strip { grid-template-columns: 1fr; } }
ol.strip img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--line);
  background: #120d00; }
ol.strip figure:hover img { border-color: var(--amber); }
ol.strip figcaption { margin-top: 6px; font-size: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
ol.strip figcaption .t { color: var(--amber); }
ol.strip figcaption .what { color: var(--soft); opacity: .8; }

.disclaimer { border: 1px solid var(--dim); padding: 14px 18px; margin: 64px 0 0; color: var(--amber); font-size: 22px; }
.disclaimer b { font-weight: normal; color: var(--dim); letter-spacing: 2px; }
article { font-family: 'Source Serif 4', Georgia, serif; font-size: 20px; line-height: 1.7; color: var(--soft);
  margin: 8px 0 24px; max-width: 46em; }
article p { margin: 0 0 1.1em; }
em.inferred { color: var(--dim); font-style: italic; }
.legend { color: var(--dim); font-size: 20px; }
.lab img { max-width: 100%; display: block; margin: 12px 0 28px; border: 1px solid var(--line); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
.cols .kept { font-family: 'Source Serif 4', Georgia, serif; font-size: 18px; line-height: 1.6; color: var(--soft); }
.cols .kept .hd { font-family: 'VT323', monospace; font-size: 22px; color: var(--dim); letter-spacing: 2px; margin-bottom: 8px; }
.cols .kept ul { margin: 0 0 20px; padding: 0 0 0 1.1em; }
.cols .kept li { margin: 0 0 .6em; }
.cols .kept .big { font-family: 'VT323', monospace; font-size: 56px; line-height: 1; color: var(--amber); }
table.events { border-collapse: collapse; width: 100%; font-size: 19px; }
table.events th, table.events td { border-bottom: 1px solid #241a00; padding: 3px 6px; text-align: left; vertical-align: top; }
table.events th { color: var(--dim); font-weight: normal; }
table.events tr.remembered td { color: var(--cyan); }
footer { margin-top: 64px; color: var(--dim); border-top: 3px double var(--line); padding-top: 12px; }

.watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-28deg); font-size: 180px;
  color: var(--amber); opacity: 0.07; pointer-events: none; z-index: -1; letter-spacing: 14px; white-space: nowrap;
  font-family: 'VT323', monospace; }
@media (max-width: 1000px) { .top { grid-template-columns: 1fr; gap: 24px; } }
@media (max-width: 860px) {
  .cols { grid-template-columns: 1fr; } pre.box { font-size: 16px; } header h1 { font-size: 44px; }
  .bar .who { display: none; } .bar .in { justify-content: center; padding: 6px 8px; flex-wrap: wrap; }
  .wrap { padding: 24px 16px 80px; }
}
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff; color: #000; background-image: none; }
  body { background: transparent; }
  body { font-size: 13px; }
  .wrap { padding: 0; max-width: none; }
  .bar, .noprint { display: none !important; }
  header { border-color: #999; }
  header h1 { font-size: 32px; color: #000; text-shadow: none; }
  header .sub, header .eyebrow, .sep { color: #333; font-size: 14px; }
  pre.box { color: #000; text-shadow: none; font-size: 13px; }
  .top { display: block; } .toc { display: none; }
  pre.box .you { color: #036; }
  h2 { color: #000; border-color: #bbb; font-size: 20px; margin-top: 24px; break-after: avoid; }
  h2 .count { color: #555; font-size: 14px; }
  figure.hero .frame { border-color: #999; box-shadow: none; padding: 3px; }
  figure.hero img { max-height: 11cm; width: auto; max-width: 100%; margin: 0 auto; }
  figure.hero figcaption, figure.hero figcaption .what { color: #333; }
  ol.strip { grid-template-columns: repeat(3, 1fr); gap: 10px; }
  ol.strip li { break-inside: avoid; }
  ol.strip img { border-color: #bbb; }
  ol.strip figcaption, ol.strip figcaption .t, ol.strip figcaption .what { color: #222; font-size: 12px; opacity: 1; }
  .disclaimer { color: #000; border-color: #999; }
  .disclaimer b { color: #555; }
  article { color: #111; font-size: 12pt; max-width: none; }
  em.inferred { color: #666; }
  .legend, footer { color: #555; }
  .lab img { border-color: #ccc; max-height: 9cm; }
  table.events { font-size: 11px; }
  table.events tr.remembered td { color: #036; }
  .watermark { color: #000; opacity: 0.06; }
}
"""

KEYS_JS = """(function(){document.addEventListener('keydown',function(e){
if(e.ctrlKey||e.metaKey||e.altKey||e.defaultPrevented)return;var k=(e.key||'').toLowerCase();
var a=document.querySelector('.actions [data-key="'+k+'"]');if(!a)return;e.preventDefault();
if(k==='p'){window.print();return;}a.click();});
var p=document.querySelector('.actions [data-key="p"]');if(p)p.addEventListener('click',function(e){e.preventDefault();window.print();});
})();"""


def _esc(s) -> str:
    return _h.escape(str(s), quote=True)


@lru_cache(maxsize=4)
def _font_b64(name: str) -> str | None:
    p = FONTS / name
    return base64.b64encode(p.read_bytes()).decode("ascii") if p.exists() else None


BOX_FONT = runtime.ROOT / "frontend" / "src" / "ui" / "fonts" / "HyperspaceBox.ttf"


@lru_cache(maxsize=1)
def _box_font_b64() -> str | None:
    return base64.b64encode(BOX_FONT.read_bytes()).decode("ascii") if BOX_FONT.exists() else None


def _font_css(standalone: bool) -> str:
    # VT323 has no box-drawing/block glyphs; HyperspaceBox (3 kB, always inline) supplies them on VT323's grid
    out = []
    if (b := _box_font_b64()):
        out.append("@font-face { font-family: 'HyperspaceBox'; src: url(data:font/ttf;base64," + b
                   + ") format('truetype'); unicode-range: U+2190-2193, U+2500-25A1; }")
    for family, fname in (("VT323", "VT323-Regular.ttf"), ("Source Serif 4", "SourceSerif4.ttf")):
        if standalone:
            b64 = _font_b64(fname)
            if b64:
                out.append(f"@font-face {{ font-family: '{family}'; src: url(data:font/ttf;base64,{b64}) format('truetype'); }}")
        else:
            out.append(f"@font-face {{ font-family: '{family}'; src: url('/fonts/{fname}') format('truetype'); }}")
    return "\n".join(out)


def _inline_image(path: Path, photo: bool) -> str | None:
    """A data URI for `path`: frames as JPEG (≤ INLINE_MAX_W wide), figures as their PNG bytes."""
    if not path.exists():
        return None
    if not photo:
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("RGB")
        if im.width > INLINE_MAX_W:
            im = im.resize((INLINE_MAX_W, max(1, round(im.height * INLINE_MAX_W / im.width))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=INLINE_JPEG_Q, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _file_hash(path: Path) -> str | None:
    try:
        return hashlib.sha1(path.read_bytes()).hexdigest()
    except OSError:
        return None


def story_frames(session_dir, frames: list[dict], exclude: str | None = None, multiple: int = 1) -> list[dict]:
    """The frames worth showing, in order (NOTES D-F2/D-F3): byte-identical copies dropped (a named moment such
    as entity_0 wins over a periodic snap of the same picture), `exclude` (the hero) left out, a layer_enter frame
    whose picture still shows the shallower layer captioned by what it shows ("chrysanthemum → breakthrough"),
    and the list trimmed to a multiple of `multiple` (no orphan row) by dropping the periodic snapshots that sit
    closest to another frame."""
    d = Path(session_dir)
    rank = {"snapshot": 1}
    seen: dict[str, int] = {}
    keep: list[dict] = []
    for f in sorted(frames, key=lambda f: rank.get(f["kind"], 0)):
        h = _file_hash(d / f["path"])
        if h and h in seen:
            continue
        if h:
            seen[h] = 1
        keep.append(f)
    names = {f["name"] for f in keep}
    out = []
    for f in frames:
        if f["name"] not in names or f["name"] == exclude:
            continue
        f = dict(f)
        if f["kind"] == "layer":
            target = f["name"][len("layer_enter_"):]
            if f.get("layer") and f["layer"] != target and f["layer"] != "room":
                what = f"{layer_label(f['layer'])} → {layer_label(target)}"
                f["caption"] = f"{fmt_ms(f['t_min'])} · {what}" if f.get("t_min") is not None else what
        out.append(f)
    snaps = [f for f in out if f["kind"] == "snapshot"]
    if len(snaps) > MAX_SNAPS:   # older sessions took 12: keep MAX_SNAPS spread evenly over the arc
        idx = {round(i * (len(snaps) - 1) / (MAX_SNAPS - 1)) for i in range(MAX_SNAPS)}
        drop = {f["name"] for i, f in enumerate(snaps) if i not in idx}
        out = [f for f in out if f["name"] not in drop]
    if multiple > 1 and len(out) > multiple:
        while len(out) % multiple:
            def gap(i: int) -> float:
                t = out[i].get("t_min")
                if t is None:
                    return -1.0
                near = [abs(t - o["t_min"]) for j, o in enumerate(out) if j != i and o.get("t_min") is not None]
                return min(near) if near else 1e9
            snaps = [i for i, f in enumerate(out) if f["kind"] == "snapshot"]
            pool = snaps or [i for i, f in enumerate(out) if f["kind"] not in ("peak", "message")] or list(range(len(out)))
            out.pop(min(pool, key=gap))
    return out


def _event_label(e: dict) -> str:
    p = e.get("payload") or {}
    t = e.get("type", "")
    extra = p.get("layer") or p.get("behaviour") or p.get("type") or p.get("flavour") or p.get("reason") or ""
    return f"{t.replace('_', ' ')}{(' · ' + str(extra).replace('_', ' ')) if extra else ''}"


def _report_html(report: dict) -> str:
    out = []
    for p in report.get("paragraphs", []):
        parts = []
        for s in p.get("sentences") or [{"text": p["text"], "inferred": p.get("inferred", False)}]:
            parts.append(f'<em class="inferred" title="inferred">{_esc(s["text"])}</em>' if s.get("inferred") else _esc(s["text"]))
        out.append("<p>" + " ".join(parts) + "</p>")
    return "\n".join(out)


def _match_label(stats: dict, remembered: dict, rem_ids: set, n_rows: int) -> str:
    pct = stats.get("memory_match_pct")
    if pct is not None:
        try:
            return f"{round(float(pct))}% MATCH"
        except (TypeError, ValueError):
            pass
    return f"{len(rem_ids)} OF {n_rows} KEPT"


def _kept_html(report: dict, stats: dict, rem_ids: set, n_rows: int) -> str:
    """Left column of REMEMBERED vs LOGGED: the match figure and only the sentences the writer had to infer
    (the whole story is printed once, above)."""
    inferred = [s["text"] for p in report.get("paragraphs", []) for s in (p.get("sentences") or []) if s.get("inferred")]
    lis = "".join(f'<li><em class="inferred">{_esc(t)}</em></li>' for t in inferred)
    body = (f'<div class="hd">FILLED IN BY THE WRITER · {len(inferred)}</div><ul>{lis}</ul>' if inferred
            else '<div class="hd">NOTHING HAD TO BE FILLED IN</div>')
    return (f'<div class="kept" data-testid="memory-kept"><div class="big">{_esc(_match_label(stats, {}, rem_ids, n_rows))}</div>'
            f'<p class="legend">Memory kept {len(rem_ids)} of the {n_rows} logged moments (cyan rows). '
            f'The story above is what it remembered; these sentences are where it guessed.</p>{body}</div>')


def _caption_html(f: dict) -> str:
    what = f["caption"].split(" · ", 1)[-1] if f.get("t_min") is not None else f["caption"]
    t = fmt_ms(f.get("t_min"))
    return (f'<span class="t">{_esc(t)}</span><span class="sep">·</span>' if t else "") + f'<span class="what">{_esc(what)}</span>'


def render_html(session_dir, session_id: str, trip_script: dict, events: list[dict], remembered: dict,
                stats: dict, report: dict, standalone: bool = False) -> str:
    session_dir = Path(session_dir)
    box = _esc(render_text(stats))
    if stats.get("sparkline_you") and " YOU   " in box:
        box = box.replace(" YOU   ", '<span class="you"> YOU   ', 1) + "</span>"
    rem_ids = {r["id"] for r in remembered.get("remembered", [])}
    rows = []
    for i, e in enumerate(events):
        if e.get("type") in ("intensity_sample", "frame_captured"):
            continue
        rid = f"e{i}"
        cls = ' class="remembered"' if rid in rem_ids else ""
        rows.append(f"<tr{cls}><td>{_esc(rid)}</td><td>{float(e.get('t_min', 0)):.2f}</td><td>{_esc(_event_label(e))}</td>"
                    f"<td>{'yes' if rid in rem_ids else ''}</td></tr>")

    cache: dict[str, str | None] = {}

    def src(rel: str, photo: bool) -> str | None:
        if not standalone:
            return rel if (session_dir / rel).exists() else None
        if rel not in cache:
            cache[rel] = _inline_image(session_dir / rel, photo)
        return cache[rel]

    all_frames = list_frames(session_dir, events)
    hero = hero_frame(all_frames)
    hero_html = ""
    if hero and (hs := src(hero["path"], True)):
        hero_html = (f'<figure class="hero" id="hero" data-testid="hero"><div class="frame"><img src="{_esc(hs)}" alt="{_esc(hero["caption"])}">'
                     f'</div><figcaption><span>{_caption_html(hero)}</span><span>SIMULATED · AFTER THE SAFETY LIMITER</span>'
                     f'</figcaption></figure>')
    frames = story_frames(session_dir, all_frames, exclude=hero["name"] if hero else None, multiple=3)
    items = []
    for f in frames:
        s = src(f["path"], True)
        if not s:
            continue
        tm = "" if f["t_min"] is None else f' data-t-min="{f["t_min"]:.4f}"'
        items.append(f'<li><figure data-name="{_esc(f["name"])}"{tm}><img src="{_esc(s)}" alt="{_esc(f["caption"])}" '
                     f'decoding="async"><figcaption>{_caption_html(f)}</figcaption></figure></li>')
    strip = (f'<h2 id="snapshots">SNAPSHOTS <span class="count">{len(items)} FRAMES · IN ORDER</span></h2>'
             f'<ol class="strip" data-testid="snapshots">{"".join(items)}</ol>') if items else ""

    figs = []
    for name, alt in (("curves.png", "plasma and channel intensity curves"), ("timeline.png", "layer timeline"),
                      ("curve_vs_drawn.png", "drawn curve against the real visual curve")):
        s = src(f"figures/{name}", False)
        if s:
            figs.append(f'<img src="{_esc(s)}" alt="{_esc(alt)}">')

    sid = _esc(session_id)
    if standalone:
        keys = '<a href="#print" data-key="p" class="primary"><b>[P]</b> PRINT</a>'
        who = "HYPERSPACE · SIMULATED TRIP REPORT · OFFLINE COPY"
    else:
        keys = (f'<a href="/api/session/{sid}/export.zip" download="simulated-trip-report-{sid}.zip" data-key="d" '
                'class="primary" data-testid="report-download"><b>[D]</b> DOWNLOAD .ZIP</a>'
                '<a href="#print" data-key="p"><b>[P]</b> PRINT</a>'
                f'<a href="/?replay={sid}" data-key="r"><b>[R]</b> REPLAY</a>'
                '<a href="/" data-key="t"><b>[T]</b> TITLE</a>')
        who = "HYPERSPACE · SIMULATED TRIP REPORT"
    actions = (f'<div class="bar"><div class="in"><span class="who">{who}</span>'
               f'<nav class="actions" aria-label="actions" data-testid="report-actions">{keys}</nav></div></div>')
    toc_rows = []
    if hero_html:
        toc_rows.append(("#hero", "THE PEAK" if hero["name"] == "peak" else "THE PICTURE", fmt_ms(hero.get("t_min"))))
    if items:
        toc_rows.append(("#snapshots", "SNAPSHOTS", str(len(items))))
    toc_rows += [("#report", "THE REPORT", f"{report.get('word_count', 0)} WORDS"), ("#lab", "LAB VIEW", "3 FIGURES" if len(figs) == 3 else f"{len(figs)} FIG"),
                 ("#memory", "REMEMBERED vs LOGGED", _match_label(stats, remembered, rem_ids, len(rows)))]
    toc = ('<nav class="toc noprint" aria-label="contents"><div class="hd">IN THIS REPORT</div>'
           + "".join(f'<a href="{h}"><span>{_esc(lbl)}</span><span class="dots"></span><span class="v">{_esc(v)}</span></a>'
                     for h, lbl, v in toc_rows)
           + '<div class="note">Everything here is simulated: a model of the timing people report, '
             'rendered after the safety limiter.</div></nav>')
    dose = str(stats.get("dose_step", "") or "").upper()
    planner = (trip_script.get("provenance") or {}).get("planner", "template")
    md_link = '' if standalone else ' · <a href="simulated-trip-report.md">markdown version</a>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(report['title'])}</title>
<style>{_font_css(standalone)}{CSS}</style></head>
<body>
<div class="watermark" aria-hidden="true">SIMULATED</div>
{actions}
<div class="wrap">
<header><div class="eyebrow">HYPERSPACE · SESSION {sid}</div><h1>SIMULATED TRIP REPORT</h1>
<div class="sub">{_esc(stats.get('date', ''))}<span class="sep">·</span>{_esc(dose)} STEP<span class="sep">·</span>SIMULATED</div></header>
<div class="top"><pre class="box">{box}</pre>{toc}</div>
{hero_html}
{strip}
<p class="disclaimer"><b>DISCLAIMER ·</b> {_esc(DISCLAIMER)}</p>
<h2 id="report">{_esc(report['title'])}</h2>
<article>
{_report_html(report)}
</article>
<p class="legend">Dim italic sentences are <em class="inferred">inferred</em>: the memory model kept nothing there, so the writer filled the gap.
{_esc(report.get('word_count', 0))} words · writer: {_esc(report.get('provenance', 'template'))} · planner: {_esc(planner)}{md_link}</p>

<section class="lab">
<h2 id="lab">LAB VIEW</h2>
<p class="legend">All quantities in model units relative to the half-effect level. Never real amounts.</p>
{''.join(figs)}
<h2 id="memory">REMEMBERED vs LOGGED</h2>
<div class="cols">
{_kept_html(report, stats, rem_ids, len(rows))}
<table class="events"><thead><tr><th>id</th><th>min</th><th>event</th><th>remembered</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody></table>
</div>
</section>
<footer>HYPERSPACE · A SIMULATION · NO DRUGS · NO NETWORK · SESSION {sid}</footer>
</div>
<script>{KEYS_JS}</script>
</body></html>
"""


def write_html(session_dir, session_id: str, trip_script: dict, events: list[dict], remembered: dict,
               stats: dict, report: dict) -> Path:
    """Write report.html and report-standalone.html; returns the path of report.html."""
    session_dir = Path(session_dir)
    args = (session_dir, session_id, trip_script, events, remembered, stats, report)
    _atomic_write(session_dir / STANDALONE, render_html(*args, standalone=True))
    path = session_dir / "report.html"
    _atomic_write(path, render_html(*args, standalone=False))
    return path


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def rebuild_html(session_dir, session_id: str) -> Path | None:
    """Re-render both HTML files from the saved report.json/stats.json/remembered.json (sessions reported by an
    older version have no standalone file). None if the report data is missing."""
    from backend.report.pipeline import load_events, load_json

    d = Path(session_dir)
    report, stats = load_json(d / "report.json"), load_json(d / "stats.json")
    if not report or not stats:
        return None
    return write_html(d, session_id, load_json(d / "trip_script.json", {}) or {}, load_events(d),
                      load_json(d / "remembered.json", {}) or {}, stats, report)


def export_report(session_dir, session_id: str) -> Path | None:
    """Copy the Markdown report (and HTML) plus its images to $REPORT_EXPORT_DIR/<session_id>/ if set."""
    target = os.environ.get("REPORT_EXPORT_DIR")
    if not target:
        return None
    session_dir = Path(session_dir)
    dest = Path(target).expanduser() / session_id
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("simulated-trip-report.md", "report.html", STANDALONE):
        if (session_dir / name).exists():
            shutil.copy2(session_dir / name, dest / name)
    for sub in ("figures", "frames"):
        if (session_dir / sub).exists():
            shutil.copytree(session_dir / sub, dest / sub, dirs_exist_ok=True)
    return dest

