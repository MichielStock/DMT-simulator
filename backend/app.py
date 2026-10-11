"""Hyperspace back end (CONTRACTS.md): FastAPI on 127.0.0.1:8765.

Run: uv run python -m backend.app   (or uvicorn backend.app:app --host 127.0.0.1 --port 8765)
"""
from __future__ import annotations

import base64
import binascii
import datetime as _dt
import json
import logging
import platform
import re
import threading
import time
import traceback
from pathlib import Path

from backend import runtime
from backend.safety import socket_guard

runtime.set_offline_env()
socket_guard.install()

import fastapi  # noqa: E402
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402

from backend import assets as assets_mod  # noqa: E402
from backend import llm  # noqa: E402
from backend.planner import expand as expand_mod  # noqa: E402
from backend.planner.sampler import sample_skeleton  # noqa: E402
from backend.report import export as export_mod  # noqa: E402
from backend.report import frames as frames_mod  # noqa: E402
from backend.report import pipeline  # noqa: E402

log = logging.getLogger("hyperspace")
VERSION = "1.0.0"
ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{4}(?:_\d+)?$")
NAME_RE = re.compile(r"[^a-zA-Z0-9_.-]+")
PROGRESS_LABELS = ["Preparing your room", "Imagining the other side", "Clearing the table"]

_lock = threading.Lock()
_progress: dict[str, dict] = {}
_reports: dict[str, dict] = {}
_event_locks: dict[str, threading.Lock] = {}


# --------------------------------------------------------------------------- helpers

def session_path(sid: str) -> Path:
    if not ID_RE.match(sid or ""):
        raise HTTPException(404, "unknown session")
    p = runtime.sessions_dir() / sid
    if not p.is_dir():
        raise HTTPException(404, "unknown session")
    return p


def new_session_id(now: _dt.datetime | None = None) -> str:
    base = (now or _dt.datetime.now()).strftime("%Y-%m-%d_%H%M")
    root = runtime.sessions_dir()
    sid, n = base, 1
    while (root / sid).exists():
        n += 1
        sid = f"{base}_{n}"
    return sid


def _plog(sdir: Path, msg: str) -> None:
    with open(sdir / "planner.log", "a", encoding="utf-8") as f:
        f.write(f"{_dt.datetime.now().isoformat(timespec='seconds')} {msg}\n")


def _new_progress() -> dict:
    return {"stage": "queued", "lines": [{"label": l, "done": False, "detail": ""} for l in PROGRESS_LABELS],
            "ready": False, "error": None}


def _set(sid: str, **kw) -> None:
    with _lock:
        p = _progress.setdefault(sid, _new_progress())
        p.update(kw)


def _line(sid: str, i: int, done: bool | None = None, detail: str | None = None) -> None:
    with _lock:
        p = _progress.setdefault(sid, _new_progress())
        if done is not None:
            p["lines"][i]["done"] = done
        if detail is not None:
            p["lines"][i]["detail"] = detail


def _write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- planning thread

def plan_session(sid: str, sdir: Path, intake: dict) -> None:
    try:
        seed = int(intake.get("seed", 0)) if isinstance(intake.get("seed"), int) else int(
            (pipeline.load_json(sdir / "session.json", {}) or {}).get("seed", 0))
        _plog(sdir, f"planning seed={seed}")
        _set(sid, stage="planning")
        skeleton = sample_skeleton(intake, seed)
        _plog(sdir, f"stage one: dose={skeleton['pharmacology']['dose_step']} predicted={skeleton['predicted']}")

        _set(sid, stage="room")
        room = intake.get("room") if isinstance(intake.get("room"), dict) else {"source": "default"}
        src = room.get("source", "default")
        if src in ("photo", "panorama"):
            if not (sdir / "assets" / "room.jpg").exists() or not (sdir / "assets" / "room_depth.png").exists():
                _line(sid, 0, detail="using the sample room")
                assets_mod.prepare_room(sdir, src)
            _line(sid, 0, True, "depth ready")
        else:
            _line(sid, 0, True, "default room")

        _set(sid, stage="planning")
        _line(sid, 1, detail="planning the other side")
        expansion, prov = expand_mod.expand_with_provenance(skeleton, intake, seed, logger=lambda m: _plog(sdir, m))
        _plog(sdir, f"stage two: {prov}")
        script = expand_mod.assemble_trip_script(skeleton, expansion, intake, sdir, planner=prov)
        _set(sid, stage="images")
        _line(sid, 1, detail="images")
        def _asset_progress(stage: str, detail: str) -> None:
            if stage in ("room", "images", "unloading"):
                _set(sid, stage=stage)
            _line(sid, {"room": 0, "images": 1, "unloading": 2}.get(stage, 1), detail=detail)
            _plog(sdir, f"assets: {stage}: {detail}")

        script = assets_mod.generate_assets(script, sdir, _asset_progress)
        errs = expand_mod.validate_trip_script(script)
        if errs:
            _plog(sdir, f"trip script schema errors: {errs[:5]}")
            raise ValueError(f"trip script invalid: {errs[:3]}")
        _line(sid, 1, True, f"planner: {prov}")

        _set(sid, stage="unloading")
        deadline = time.time() + 60
        while runtime.resident_models() and time.time() < deadline:
            time.sleep(0.25)
        if runtime.resident_models():
            raise RuntimeError("models still resident after 60 s")
        _line(sid, 2, True, "nothing resident")
        _write_json(sdir / "trip_script.json", script)
        _plog(sdir, "ready")
        _set(sid, stage="ready", ready=True)
    except Exception as e:  # never leave the settling screen hanging
        _plog(sdir, "error: " + "".join(traceback.format_exception(e))[-2000:])
        _set(sid, stage="error", error=str(e), ready=False)


def report_session(sid: str, sdir: Path) -> None:
    def stage(s):
        with _lock:
            _reports[sid].update(stage=s)

    try:
        pipeline.run_report(sdir, sid, stage, logger=lambda m: _plog(sdir, m))
        with _lock:
            _reports[sid].update(stage="done", done=True, report_html=f"/sessions/{sid}/report.html")
    except Exception as e:
        _plog(sdir, "report error: " + "".join(traceback.format_exception(e))[-2000:])
        with _lock:
            _reports[sid].update(stage="error", error=str(e))


# --------------------------------------------------------------------------- app

NOT_BUILT = """<!doctype html><html><head><meta charset="utf-8"><title>Hyperspace</title>
<style>body{background:#0a0700;color:#ffb000;font-family:monospace;padding:40px}</style></head>
<body><pre>HYPERSPACE

The front end is not built yet. Run ./run.sh (it builds frontend/dist), or cd frontend &amp;&amp; npm run build.
</pre></body></html>"""


def create_app() -> FastAPI:
    runtime.set_offline_env()
    socket_guard.install()
    app = FastAPI(title="Hyperspace", version=VERSION)

    @app.get("/api/status")
    def status():
        try:
            from backend.models_registry import get_registry

            reg = get_registry()
        except Exception:
            reg = {}
        llm_on = not runtime.force_templates()
        images = "procedural" if runtime.no_images() else getattr(assets_mod, "IMAGE_BACKEND", "procedural")
        return {
            "ok": True,
            "resident_models": runtime.resident_models(),
            "versions": {"hyperspace": VERSION, "python": platform.python_version(), "fastapi": fastapi.__version__,
                         "contracts": 1},
            "fallbacks": list(dict.fromkeys(list(reg.get("fallbacks") or []) + runtime.fallbacks()
                                            + (["planner/writer: templates forced"] if not llm_on else [])
                                            + (["images: procedural forced"] if runtime.no_images() else []))),
            "llm": {"runtime": "ollama" if llm_on else "none", "model": runtime.llm_model(), "host": runtime.ollama_host()},
            "images": images,
            "socket_guard": socket_guard.installed(),
        }

    @app.get("/api/sessions")
    def sessions():
        out = []
        for d in sorted(runtime.sessions_dir().iterdir(), reverse=True):
            if not d.is_dir() or not ID_RE.match(d.name):
                continue
            ts = pipeline.load_json(d / "trip_script.json", {}) or {}
            st = pipeline.load_json(d / "stats.json")
            pred = ts.get("predicted") or {}
            out.append({
                "id": d.name, "date": d.name[:10],
                "dose_step": (ts.get("pharmacology") or {}).get("dose_step") or (pipeline.load_json(d / "intake.json", {}) or {}).get("dose_step"),
                "peak_visual": st["peak_visual"] if st else pred.get("peak_visual"),
                "deepest_layer": st["deepest_layer"] if st else (pred.get("deepest_layer") or "").replace("_", " ").upper() or None,
                "beings": st["beings_met"] if st else None,
                "has_report": (d / "report.html").exists(),
            })
        return out

    @app.post("/api/session")
    def create_session(body: dict | None = Body(default=None)):
        seed = (body or {}).get("seed")
        if seed is None:
            seed = int(time.time() * 1000) % (2**31 - 1)
        seed = abs(int(seed))
        with _lock:
            sid = new_session_id()
            sdir = runtime.sessions_dir() / sid
            for sub in ("frames", "figures", "assets"):
                (sdir / sub).mkdir(parents=True, exist_ok=True)
            _progress[sid] = _new_progress()
        _write_json(sdir / "session.json", {"id": sid, "seed": seed, "created": _dt.datetime.now().isoformat(timespec="seconds")})
        return {"id": sid, "seed": seed}

    @app.post("/api/session/{sid}/room")
    async def room(sid: str, file: UploadFile = File(...), kind: str = Form("photo")):
        sdir = session_path(sid)
        data = await file.read()
        if not data:
            raise HTTPException(400, "empty file")
        try:
            # depth estimation (~3 s on the GPU) must not block the event loop
            return await run_in_threadpool(assets_mod.prepare_room, sdir, kind, data)
        except Exception as e:
            raise HTTPException(400, f"could not read image: {e}")

    @app.post("/api/session/{sid}/intake")
    def intake(sid: str, body: dict = Body(...)):
        sdir = session_path(sid)
        if not isinstance(body, dict):
            raise HTTPException(422, "intake must be an object")
        try:
            import jsonschema

            errs = [e.message for e in jsonschema.Draft202012Validator(expand_mod.load_schema("intake")).iter_errors(body)]
        except Exception:
            errs = []
        if errs:
            _plog(sdir, f"intake schema warnings (accepted, normalised): {errs[:5]}")
        if "seed" not in body:
            body = dict(body, seed=(pipeline.load_json(sdir / "session.json", {}) or {}).get("seed", 0))
        _write_json(sdir / "intake.json", body)
        _set(sid, **_new_progress())
        threading.Thread(target=plan_session, args=(sid, sdir, body), daemon=True, name=f"plan-{sid}").start()
        return {"accepted": True}

    @app.get("/api/session/{sid}/progress")
    def progress(sid: str):
        sdir = session_path(sid)
        with _lock:
            p = _progress.get(sid)
            if p is None:  # e.g. after a restart
                p = _new_progress()
                if (sdir / "trip_script.json").exists():
                    p.update(stage="ready", ready=True)
                    for l in p["lines"]:
                        l["done"] = True
            return json.loads(json.dumps(p))

    @app.get("/api/session/{sid}/trip_script")
    def trip_script(sid: str):
        sdir = session_path(sid)
        ts = pipeline.load_json(sdir / "trip_script.json")
        if ts is None:
            raise HTTPException(404, "not ready")
        return ts

    @app.post("/api/session/{sid}/events")
    def events(sid: str, body: dict = Body(...)):
        sdir = session_path(sid)
        evs = body.get("events") if isinstance(body, dict) else None
        if not isinstance(evs, list):
            raise HTTPException(422, "events must be a list")
        lines = []
        for e in evs:
            if not isinstance(e, dict) or "type" not in e:
                continue
            lines.append(json.dumps({"t_min": float(e.get("t_min", 0.0)), "type": str(e["type"]),
                                     "payload": e.get("payload") or {}}, ensure_ascii=False))
        with _lock:
            lk = _event_locks.setdefault(sid, threading.Lock())
        with lk:
            with open(sdir / "event_log.jsonl", "a", encoding="utf-8") as f:
                for l in lines:
                    f.write(l + "\n")
        return {"count": len(lines)}

    @app.post("/api/session/{sid}/frame")
    def frame(sid: str, body: dict = Body(...)):
        sdir = session_path(sid)
        name = NAME_RE.sub("_", str(body.get("name", "frame")))[:80].strip("._") or "frame"
        b64 = str(body.get("png_base64", ""))
        if "," in b64[:100] and b64.startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            data = base64.b64decode(b64, validate=False)
        except (binascii.Error, ValueError):
            raise HTTPException(422, "bad base64")
        if not data.startswith(b"\x89PNG"):
            raise HTTPException(422, "not a PNG")
        (sdir / "frames").mkdir(exist_ok=True)
        (sdir / "frames" / f"{name}.png").write_bytes(data)
        # sidecar with the capture time and the deepest layer (captions; the event log has the same data)
        meta = {}
        try:
            if body.get("t_min") is not None:
                meta["t_min"] = round(float(body["t_min"]), 4)
        except (TypeError, ValueError):
            pass
        layer = NAME_RE.sub("_", str(body.get("layer") or ""))[:40]
        if layer:
            meta["layer"] = layer
        with _lock:
            side = frames_mod.read_sidecar(sdir)
            side[name] = meta
            _write_json(sdir / frames_mod.SIDECAR, side)
        return {"path": f"frames/{name}.png"}

    @app.get("/api/session/{sid}/frames")
    def frames(sid: str):
        sdir = session_path(sid)
        return frames_mod.list_frames(sdir, pipeline.load_events(sdir))

    @app.post("/api/session/{sid}/curve")
    def curve(sid: str, body: dict = Body(...)):
        sdir = session_path(sid)
        pts = body.get("points") if isinstance(body, dict) else None
        if not isinstance(pts, list):
            raise HTTPException(422, "points must be a list")
        clean = []
        for p in pts:
            try:
                clean.append([float(p[0]), max(0.0, min(10.0, float(p[1])))])
            except (TypeError, ValueError, IndexError):
                continue
        _write_json(sdir / "curve.json", {"points": clean})
        return {"ok": True}

    @app.post("/api/session/{sid}/finish")
    def finish(sid: str, body: dict | None = Body(default=None)):
        sdir = session_path(sid)
        with _lock:
            cur = _reports.get(sid)
            if cur and cur["stage"] not in ("done", "error"):
                return {"started": True}
            _reports[sid] = {"stage": "memory", "done": False, "report_html": None, "error": None}
        threading.Thread(target=report_session, args=(sid, sdir), daemon=True, name=f"report-{sid}").start()
        return {"started": True}

    @app.get("/api/session/{sid}/report_status")
    def report_status(sid: str):
        sdir = session_path(sid)
        with _lock:
            r = _reports.get(sid)
            if r is None:
                done = (sdir / "report.html").exists()
                return {"stage": "done" if done else "memory", "done": done,
                        "report_html": f"/sessions/{sid}/report.html" if done else None, "error": None}
            return dict(r)

    def _reported(sid: str) -> Path:
        sdir = session_path(sid)
        with _lock:
            r = _reports.get(sid)
            busy = r is not None and not r.get("done")
        if busy or not (sdir / "report.html").exists():
            raise HTTPException(404, "the report is not ready")
        return sdir

    @app.get("/api/session/{sid}/export.zip")
    def export_zip(sid: str):
        sdir = _reported(sid)
        z = export_mod.build_zip(sdir, sid)
        return FileResponse(z, media_type="application/zip", filename=export_mod.zip_name(sid))

    @app.get("/api/session/{sid}/export.json")
    def export_json(sid: str):
        sdir = _reported(sid)
        z = export_mod.build_zip(sdir, sid)
        return {"filename": export_mod.zip_name(sid), "url": f"/api/session/{sid}/export.zip",
                "size": z.stat().st_size, "members": export_mod.listing(z)}

    @app.get("/api/session/{sid}/stats")
    def stats(sid: str):
        sdir = session_path(sid)
        return pipeline.session_stats(sdir, sid)

    @app.get("/api/session/{sid}/replay")
    def replay(sid: str):
        sdir = session_path(sid)
        ts = pipeline.load_json(sdir / "trip_script.json")
        if ts is None:
            raise HTTPException(404, "no trip script")
        return {"seed": ts.get("seed"), "trip_script": ts, "events": pipeline.load_events(sdir),
                "intake": pipeline.load_json(sdir / "intake.json", {})}

    # static files
    app.mount("/sessions", StaticFiles(directory=str(runtime.sessions_dir()), html=True), name="sessions")
    fonts = runtime.ROOT / "frontend" / "public" / "fonts"
    if fonts.is_dir():
        app.mount("/fonts", StaticFiles(directory=str(fonts)), name="fonts")
    dist = runtime.ROOT / "frontend" / "dist"
    if (dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")
    else:
        @app.get("/", response_class=HTMLResponse)
        def index():
            return NOT_BUILT

    @app.exception_handler(Exception)
    async def _err(request, exc):  # pragma: no cover
        return JSONResponse({"error": str(exc)}, status_code=500)

    return app


app = create_app()


def main() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="info")


if __name__ == "__main__":
    main()
