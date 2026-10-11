"""Captured frames of a session in chronological order, with short captions (report page, Markdown, end screen).

Timing comes from the `frame_captured` events (t_min, and `layer` = the deepest layer on screen at that moment),
then from the `frames.json` sidecar the frame endpoint writes, then from the name order.
Captions: "m:ss · <what>", e.g. "2:10 · chrysanthemum", "0:21 · entering form constants", "1:49 · the peak".
"""
from __future__ import annotations

import json
import re
from pathlib import Path

LAYER_LABELS = {
    "room": "the room",
    "form_constants": "form constants",
    "chrysanthemum": "chrysanthemum",
    "waiting_room": "waiting room",
    "breakthrough": "breakthrough",
}
SIDECAR = "frames.json"
_SNAP = re.compile(r"^snap_(\d+)$")
_ENTITY = re.compile(r"^entity_(\d+)$")


def fmt_ms(t_min: float | None) -> str:
    if t_min is None:
        return ""
    s = max(0, int(round(float(t_min) * 60)))
    return f"{s // 60}:{s % 60:02d}"


def layer_label(layer: str | None) -> str:
    if not layer:
        return ""
    return LAYER_LABELS.get(str(layer), str(layer).replace("_", " "))


def describe(name: str, layer: str | None = None) -> str:
    """What a frame shows, in a few lowercase words."""
    if name.startswith("layer_enter_"):
        return "entering " + layer_label(name[len("layer_enter_"):])
    if name == "peak":
        return "the peak"
    if _ENTITY.match(name):
        return "a being"
    if name == "message":
        return "the message"
    if _SNAP.match(name):
        return layer_label(layer) or "snapshot"
    return name.replace("_", " ")


def caption(name: str, t_min: float | None, layer: str | None = None) -> str:
    what = describe(name, layer)
    return f"{fmt_ms(t_min)} · {what}" if t_min is not None else what


def read_sidecar(session_dir) -> dict:
    p = Path(session_dir) / SIDECAR
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def list_frames(session_dir, events: list[dict] | None = None) -> list[dict]:
    """[{name, file, path, t_min, layer, caption, kind}] for frames/*.png, chronological (t_min, then name)."""
    d = Path(session_dir)
    fdir = d / "frames"
    files = sorted(fdir.glob("*.png")) if fdir.is_dir() else []
    if not files:
        return []
    side = read_sidecar(d)
    logged: dict[str, dict] = {}
    for e in events or []:
        if e.get("type") != "frame_captured":
            continue
        p = e.get("payload") or {}
        n = str(p.get("name") or "")
        if n and n not in logged:
            logged[n] = {"t_min": e.get("t_min"), "layer": p.get("layer")}
    out = []
    for f in files:
        name = f.stem
        meta = dict(side.get(name) or {})
        meta.update({k: v for k, v in (logged.get(name) or {}).items() if v is not None})
        t = meta.get("t_min")
        try:
            t = float(t) if t is not None else None
        except (TypeError, ValueError):
            t = None
        layer = meta.get("layer")
        layer = str(layer) if layer else None
        kind = ("snapshot" if _SNAP.match(name) else "layer" if name.startswith("layer_enter_") else
                "peak" if name == "peak" else "being" if _ENTITY.match(name) else
                "message" if name == "message" else "other")
        out.append({"name": name, "file": f.name, "path": f"frames/{f.name}", "t_min": t, "layer": layer,
                    "kind": kind, "caption": caption(name, t, layer)})
    order = {n: i for i, n in enumerate(f.stem for f in files)}
    out.sort(key=lambda r: (r["t_min"] is None, r["t_min"] if r["t_min"] is not None else 0.0, order[r["name"]]))
    return out


def hero_frame(frames: list[dict]) -> dict | None:
    """peak.png if present, else the last snapshot, else the last frame."""
    if not frames:
        return None
    for f in frames:
        if f["name"] == "peak":
            return f
    snaps = [f for f in frames if f["kind"] == "snapshot"]
    return (snaps or frames)[-1]
