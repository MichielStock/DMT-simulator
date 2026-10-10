#!/usr/bin/env python3
"""Contact sheet for the render galleries (BUILD.md 16.2): writes docs/gallery.html.

    uv run python tools/gallery_sheet.py [--gallery verification/gallery] [--out docs/gallery.html]

Rows = layers, columns = intensities (1, 3, 5, 7.5, 9), both seeds stacked in each cell; then the
extras (room eyes-closed field, v=9 with a difficult passage forced) and the retro screens
(verification/gallery/screens). Images are linked relatively (no copies). Includes the table from
verification/gallery/checks.json (tools/gallery_checks.py) and the generation timestamp. Styling follows
BUILD.md 15.1 (retro terminal: amber/black, monospace, static faint scanlines).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LAYERS = ["room", "form_constants", "chrysanthemum", "waiting_room", "breakthrough"]
INTENSITIES = [1, 3, 5, 7.5, 9]
SEEDS = [11, 23]

CSS = """
:root { --fg:#ffb000; --dim:#b37a00; --bg:#0b0700; --ok:#7dff6a; --bad:#ff4f4f; --line:#3a2700; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.35 "VT323","DejaVu Sans Mono",monospace; }
body::after { content:""; position:fixed; inset:0; pointer-events:none;
  background:repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 2px, rgba(0,0,0,.06) 2px 3px); }
main { padding:24px 28px 60px; max-width:1900px; margin:0 auto; }
h1 { font-size:28px; letter-spacing:.12em; margin:0 0 4px; }
h2 { font-size:20px; letter-spacing:.1em; margin:34px 0 10px; border-bottom:1px solid var(--line); padding-bottom:4px; }
.meta, .dim { color:var(--dim); }
table { border-collapse:collapse; }
table.sheet td, table.sheet th { padding:4px; vertical-align:top; }
table.sheet th { text-align:left; font-weight:normal; color:var(--dim); white-space:nowrap; }
table.sheet th.layer { color:var(--fg); letter-spacing:.08em; padding-right:12px; }
figure { margin:0 0 6px; }
figure img { display:block; width:300px; height:auto; border:1px solid var(--line); background:#000; }
figure.fail img { border-color:var(--bad); }
figcaption { font-size:13px; color:var(--dim); }
figcaption .bad { color:var(--bad); } figcaption .ok { color:var(--ok); }
.missing { width:300px; height:169px; border:1px dashed var(--line); color:var(--dim);
  display:flex; align-items:center; justify-content:center; }
.extras { display:flex; flex-wrap:wrap; gap:10px; }
table.checks { font-size:14px; margin-top:6px; }
table.checks td, table.checks th { border:1px solid var(--line); padding:2px 8px; text-align:left; }
table.checks .bad { color:var(--bad); } table.checks .ok { color:var(--ok); }
.screens img { width:460px; }
a { color:inherit; }
"""


def fmt_v(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def rel(target: Path, out_dir: Path) -> str:
    return os.path.relpath(target, out_dir).replace(os.sep, "/")


def failed_names(row: dict | None) -> list[str]:
    if not row:
        return []
    return [k for k, c in row["checks"].items() if not c.get("ok")]


def figure(img: Path, out_dir: Path, label: str, row: dict | None) -> str:
    if not img.exists():
        return f'<div class="missing">{html.escape(label)}: not captured</div>'
    bad = failed_names(row)
    status = ("" if row is None else
              f' · <span class="bad">FAIL {", ".join(bad)}</span>' if bad else ' · <span class="ok">ok</span>')
    href = html.escape(rel(img, out_dir))
    return (f'<figure class="{"fail" if bad else ""}"><a href="{href}"><img loading="lazy" src="{href}" '
            f'alt="{html.escape(label)}"></a><figcaption>{html.escape(label)}{status}</figcaption></figure>')


def checks_table(checks: dict | None) -> str:
    if not checks:
        return '<p class="dim">No checks.json yet: run <code>uv run python tools/gallery_checks.py</code>.</p>'
    rows = checks.get("all_rows") or checks.get("rows") or []
    cols = ["blank", "white", "pattern", "palette", "stuck"]
    out = ['<table class="checks"><tr><th>frame</th>' + "".join(f"<th>{c}</th>" for c in cols) + "<th>result</th></tr>"]
    for r in rows:
        tds = []
        for c in cols:
            ch = r["checks"].get(c)
            if ch is None:
                tds.append("<td class=dim>-</td>")
                continue
            val = {"blank": ch.get("std"), "white": ch.get("mean_linear_luminance"),
                   "pattern": max(ch.get("ratio_cartesian", 0) or 0, ch.get("ratio_logpolar", 0) or 0, ch.get("radial", 0) or 0),
                   "palette": ch.get("coverage"), "stuck": ch.get("diff")}.get(c)
            if ch.get("missing"):
                val = "missing"
            cls = "ok" if ch.get("ok") else "bad"
            tds.append(f'<td class="{cls}">{"ok" if ch.get("ok") else "FAIL"} {html.escape(str(val))}</td>')
        res = '<td class="ok">pass</td>' if r["ok"] else '<td class="bad">FAIL</td>'
        out.append(f"<tr><td>{html.escape(r['file'])}</td>{''.join(tds)}{res}</tr>")
    out.append("</table>")
    n = len(rows)
    nf = sum(1 for r in rows if not r["ok"])
    head = (f'<p>{n - nf}/{n} frames pass · checks generated {html.escape(str(checks.get("generated", "?")))} · '
            f'thresholds {html.escape(json.dumps(checks.get("thresholds", {})))}</p>')
    return head + "\n".join(out)


def build(gallery: Path, out: Path) -> str:
    out_dir = out.parent
    cj = gallery / "checks.json"
    checks = json.loads(cj.read_text()) if cj.exists() else None
    by_file = {r["file"]: r for r in ((checks or {}).get("all_rows") or (checks or {}).get("rows") or [])}
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    parts = [f"<!doctype html><html lang=en><head><meta charset=utf-8><title>HYPERSPACE · RENDER GALLERY</title>"
             f"<meta name=viewport content='width=device-width, initial-scale=1'><style>{CSS}</style></head><body><main>",
             "<h1>HYPERSPACE · RENDER GALLERY</h1>",
             f'<p class="meta">generated {html.escape(now)} · frames after the SafetyLimiter, 1280×720, scrub mode '
             f'(dose breakthrough, layer forced) · seeds {", ".join(map(str, SEEDS))} · '
             f'sources: <a href="{html.escape(rel(gallery, out_dir))}/">{html.escape(rel(gallery, out_dir))}/</a></p>']
    if checks is not None:
        ok = checks.get("all_ok", checks.get("ok"))
        parts.append(f'<p>AUTOMATED CHECKS: <span class="{"ok" if ok else "bad"}" style="color:var(--{"ok" if ok else "bad"})">'
                     f'{"PASS" if ok else "FAIL"}</span> (details at the end)</p>')

    parts.append("<h2>LAYERS × VISUAL INTENSITY</h2><table class=sheet><tr><th></th>"
                 + "".join(f"<th>v = {fmt_v(v)}</th>" for v in INTENSITIES) + "</tr>")
    for layer in LAYERS:
        parts.append(f'<tr><th class="layer">{layer.upper().replace("_", " ")}</th>')
        for v in INTENSITIES:
            cell = []
            for s in SEEDS:
                name = f"{layer}_v{fmt_v(v)}_s{s}.png"
                cell.append(figure(gallery / layer / name, out_dir, f"seed {s}", by_file.get(f"{layer}/{name}")))
            parts.append("<td>" + "".join(cell) + "</td>")
        parts.append("</tr>")
    parts.append("</table>")

    parts.append("<h2>EYES CLOSED (ROOM) · DIFFICULT PASSAGE (v = 9)</h2><div class=extras>")
    for s in SEEDS:
        for v in (3, 5):
            name = f"room_v{v}_s{s}_eyes.png"
            parts.append(figure(gallery / "room" / name, out_dir, f"room eyes closed v{v} seed {s}", by_file.get(f"room/{name}")))
    for layer in LAYERS:
        for s in SEEDS:
            name = f"{layer}_v9_s{s}_challenge.png"
            parts.append(figure(gallery / layer / name, out_dir, f"{layer} challenge seed {s}", by_file.get(f"{layer}/{name}")))
    parts.append("</div>")

    screens = sorted((gallery / "screens").glob("*.png")) if (gallery / "screens").is_dir() else []
    if screens:
        parts.append("<h2>SCREENS</h2><div class='extras screens'>")
        for p in screens:
            parts.append(figure(p, out_dir, p.stem, None))
        parts.append("</div>")

    parts.append("<h2>AUTOMATED CHECKS</h2>")
    parts.append(checks_table(checks))
    parts.append('<p class="dim">tools/gallery_checks.py: blank (luma std / chroma std, not uniform), white (mean linear '
                 'luminance ≤ 0.8), pattern (annulus-normalised spectral peak, Cartesian or log-polar; form constants '
                 'v ≥ 3 and chrysanthemum), palette (trip-script colour ≥ 1% of pixels), stuck (differs from v = 1 / base).</p>')
    parts.append("</main></body></html>")
    return "\n".join(parts)


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gallery", default=str(root / "verification" / "gallery"))
    ap.add_argument("--out", default=str(root / "docs" / "gallery.html"))
    a = ap.parse_args(argv)
    gallery = Path(a.gallery).resolve()
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(gallery, out), encoding="utf-8")
    print(f"contact sheet: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
