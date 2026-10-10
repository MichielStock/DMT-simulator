"""report.html (BUILD.md §13.5, §15.1): retro amber header + stats box, disclaimer, report with inferred sentences
highlighted, a fixed "SIMULATED" watermark, the lab view, a Replay link and a print stylesheet.
Also `export_report` for REPORT_EXPORT_DIR.
"""
from __future__ import annotations

import html as _h
import os
import shutil
from pathlib import Path

from backend.report.stats import render_text
from backend.report.writer import DISCLAIMER

CSS = """
@font-face { font-family: 'VT323'; src: url('/fonts/VT323-Regular.ttf') format('truetype'); }
@font-face { font-family: 'Source Serif 4'; src: url('/fonts/SourceSerif4.ttf') format('truetype'); }
:root { --bg: #0a0700; --amber: #ffb000; --dim: #7a5400; --cyan: #4fe3ff; }
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--amber); margin: 0; }
body { font-family: 'VT323', monospace; font-size: 22px; line-height: 1.3; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 24px 80px; }
header h1 { font-weight: normal; font-size: 40px; margin: 0 0 4px; letter-spacing: 1px; text-shadow: 0 0 4px rgba(255,176,0,.35); }
header .sub { color: var(--dim); }
pre.box { font-family: 'VT323', monospace; font-size: 22px; line-height: 1.12; margin: 24px 0; white-space: pre; overflow-x: auto;
  text-shadow: 0 0 3px rgba(255,176,0,.3); }
pre.box .you { color: var(--cyan); }
.disclaimer { border: 1px solid var(--dim); padding: 12px 16px; color: var(--amber); font-size: 20px; }
article { font-family: 'Source Serif 4', Georgia, serif; font-size: 19px; line-height: 1.65; color: #ffd27a; margin: 32px 0; }
article p { margin: 0 0 1em; }
em.inferred { color: var(--dim); font-style: italic; }
h2 { font-weight: normal; font-size: 30px; border-bottom: 1px solid var(--dim); margin-top: 48px; }
.legend { color: var(--dim); font-size: 18px; }
.lab img { max-width: 100%; display: block; margin: 12px 0 24px; border: 1px solid #2a1e00; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
.cols article { margin: 0; font-size: 16px; }
table.events { border-collapse: collapse; width: 100%; font-size: 18px; }
table.events th, table.events td { border-bottom: 1px solid #2a1e00; padding: 2px 6px; text-align: left; vertical-align: top; }
table.events th { color: var(--dim); font-weight: normal; }
table.events tr.remembered td { color: var(--cyan); }
.frames { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.frames figure { margin: 0; } .frames img { width: 100%; border: 1px solid #2a1e00; }
.frames figcaption { color: var(--dim); font-size: 16px; }
a { color: var(--cyan); }
.keys { margin-top: 24px; }
.watermark { position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-28deg); font-size: 160px;
  color: var(--amber); opacity: 0.07; pointer-events: none; z-index: 10; letter-spacing: 12px; white-space: nowrap;
  font-family: 'VT323', monospace; }
@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } pre.box { font-size: 15px; } }
@media print {
  html, body { background: #fff; color: #000; }
  body { font-size: 14px; }
  header h1, pre.box, .disclaimer, h2 { color: #000; text-shadow: none; }
  pre.box .you { color: #036; }
  article { color: #111; }
  em.inferred { color: #666; }
  .watermark { color: #000; opacity: 0.08; }
  .keys, .noprint { display: none; }
  .lab img { border-color: #ccc; }
  table.events tr.remembered td { color: #036; }
}
"""


def _esc(s) -> str:
    return _h.escape(str(s), quote=True)


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


def write_html(session_dir, session_id: str, trip_script: dict, events: list[dict], remembered: dict,
               stats: dict, report: dict) -> Path:
    session_dir = Path(session_dir)
    box = _esc(render_text(stats))
    if stats.get("sparkline_you"):
        box = box.replace(" YOU   ", '<span class="you"> YOU   ', 1) + "</span>" if " YOU   " in box else box
    rem_ids = {r["id"] for r in remembered.get("remembered", [])}
    rows = []
    for i, e in enumerate(events):
        if e.get("type") in ("intensity_sample", "frame_captured"):
            continue
        rid = f"e{i}"
        cls = ' class="remembered"' if rid in rem_ids else ""
        rows.append(f"<tr{cls}><td>{_esc(rid)}</td><td>{float(e.get('t_min', 0)):.2f}</td><td>{_esc(_event_label(e))}</td>"
                    f"<td>{'yes' if rid in rem_ids else ''}</td></tr>")
    frames = sorted((session_dir / "frames").glob("*.png")) if (session_dir / "frames").exists() else []
    frames_html = "".join(f'<figure><img src="frames/{_esc(f.name)}" alt="{_esc(f.stem)}"><figcaption>{_esc(f.stem.replace("_", " "))}'
                          f"</figcaption></figure>" for f in frames)
    sid = _esc(session_id)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(report['title'])}</title>
<style>{CSS}</style></head>
<body>
<div class="watermark" aria-hidden="true">SIMULATED</div>
<div class="wrap">
<header><h1>SIMULATED TRIP REPORT</h1><div class="sub">HYPERSPACE · SESSION {sid} · {_esc(stats.get('dose_step', ''))} · SIMULATED</div></header>
<pre class="box">{box}</pre>
<p class="disclaimer">{_esc(DISCLAIMER)}</p>
<h2>{_esc(report['title'])}</h2>
<article>
{_report_html(report)}
</article>
<p class="legend">Dim italic sentences are <em class="inferred">inferred</em>: the memory model kept nothing there, so the writer filled the gap.
{_esc(report.get('word_count', 0))} words · writer: {_esc(report.get('provenance', 'template'))} · planner: {_esc((trip_script.get('provenance') or {}).get('planner', 'template'))}</p>
<p class="keys noprint"><a href="/?replay={sid}">[P] REPLAY THIS SESSION</a> &nbsp; <a href="simulated-trip-report.md">[M] MARKDOWN</a> &nbsp; <a href="/">[T] TITLE</a></p>

<section class="lab">
<h2>LAB VIEW</h2>
<p class="legend">All quantities in model units relative to the half-effect level. Never real amounts.</p>
<img src="figures/curves.png" alt="plasma and channel intensity curves">
<img src="figures/timeline.png" alt="layer timeline">
<img src="figures/curve_vs_drawn.png" alt="drawn curve against the real visual curve">
<h2>REMEMBERED vs LOGGED</h2>
<div class="cols">
<article>
{_report_html(report)}
</article>
<table class="events"><thead><tr><th>id</th><th>min</th><th>event</th><th>remembered</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody></table>
</div>
{'<h2>CAPTURED FRAMES</h2><div class="frames">' + frames_html + '</div>' if frames_html else ''}
</section>
</div>
</body></html>
"""
    path = session_dir / "report.html"
    path.write_text(doc, encoding="utf-8")
    return path


def export_report(session_dir, session_id: str) -> Path | None:
    """Copy the Markdown report (and HTML) plus its images to $REPORT_EXPORT_DIR/<session_id>/ if set."""
    target = os.environ.get("REPORT_EXPORT_DIR")
    if not target:
        return None
    session_dir = Path(session_dir)
    dest = Path(target).expanduser() / session_id
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("simulated-trip-report.md", "report.html"):
        if (session_dir / name).exists():
            shutil.copy2(session_dir / name, dest / name)
    for sub in ("figures", "frames"):
        if (session_dir / sub).exists():
            shutil.copytree(session_dir / sub, dest / sub, dirs_exist_ok=True)
    return dest
