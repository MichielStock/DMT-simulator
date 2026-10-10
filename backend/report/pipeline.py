"""After-trip pipeline (BUILD.md §13): stats → memory model → writer → figures → HTML → export."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from backend.report.figures import make_figures
from backend.report.html import export_report, write_html
from backend.report.memory_model import remember
from backend.report.stats import compute_stats
from backend.report.writer import write_report


def load_events(session_dir) -> list[dict]:
    p = Path(session_dir) / "event_log.jsonl"
    out = []
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    out.sort(key=lambda e: float(e.get("t_min", 0.0)))  # stable: same-time events keep log order
    return out


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def session_date(session_id: str) -> str:
    return session_id[:10]


def session_stats(session_dir, session_id: str) -> dict:
    d = Path(session_dir)
    return compute_stats(load_json(d / "trip_script.json", {}), load_events(d), load_json(d / "curve.json"),
                         load_json(d / "intake.json", {}), date=session_date(session_id))


def run_report(session_dir, session_id: str, stage: Callable[[str], None] | None = None, logger=None) -> dict:
    stage = stage or (lambda s: None)
    d = Path(session_dir)
    trip = load_json(d / "trip_script.json", {})
    intake = load_json(d / "intake.json", {})
    events = load_events(d)
    curve = load_json(d / "curve.json")
    stage("memory")
    stats = compute_stats(trip, events, curve, intake, date=session_date(session_id))
    (d / "stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")
    remembered = remember(events, int(trip.get("seed", 0)))
    (d / "remembered.json").write_text(json.dumps(remembered, indent=1), encoding="utf-8")
    stage("figures")
    make_figures(d, events, curve)
    stage("writing")
    report = write_report(d, trip, intake, events, remembered, stats, logger=logger)
    stage("html")
    write_html(d, session_id, trip, events, remembered, stats, report)
    export_report(d, session_id)
    return report
