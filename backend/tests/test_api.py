"""API end to end with TestClient (templates forced, no images)."""
import importlib
import json
import time
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")
    monkeypatch.setenv("HYPERSPACE_NO_IMAGES", "1")
    monkeypatch.setenv("HYPERSPACE_SESSIONS_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("REPORT_EXPORT_DIR", str(tmp_path / "export"))
    from fastapi.testclient import TestClient

    import backend.app as appmod

    importlib.reload(appmod)
    with TestClient(appmod.create_app()) as c:
        c.sessions_dir = tmp_path / "sessions"
        c.export_dir = tmp_path / "export"
        yield c


def _schema(name):
    return json.loads((ROOT / "shared" / "schemas" / f"{name}.schema.json").read_text())


def _intake(seed, dose="breakthrough", source="photo"):
    return {"version": 1, "room": {"source": source, "image": None, "depth": None},
            "answers": {"clarity": 5, "set": 0, "absorption": [5, 5, 5], "surrender": 5, "intention": "curiosity",
                        "expectations": ["jesters"]},
            "dose_step": dose, "hold_fraction": 1.0,
            "options": {"difficult_passages": True, "eyes": "auto", "audio": True, "microphone": False, "live_diffusion": False},
            "seed": seed}


def _wait(fn, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = fn()
        if r:
            return r
        time.sleep(0.1)
    raise AssertionError("timed out")


def test_full_session(client):
    from backend.batch.synth import synthesise_drawn_curve, synthesise_events
    from backend.report.pipeline import load_events, load_json
    from backend.report.stats import compute_stats

    st = client.get("/api/status").json()
    assert st["ok"] and st["resident_models"] == [] and st["llm"]["runtime"] == "none"

    r = client.post("/api/session", json={"seed": 4242}).json()
    sid, seed = r["id"], r["seed"]
    assert seed == 4242
    sdir = client.sessions_dir / sid
    for sub in ("frames", "figures", "assets"):
        assert (sdir / sub).is_dir()
    # a second session in the same minute gets a suffix
    r2 = client.post("/api/session", json={"seed": 1}).json()
    assert r2["id"] != sid and r2["id"].startswith(sid[:15])

    assert client.get(f"/api/session/{sid}/trip_script").status_code == 404
    jsonschema.validate(_intake(seed), _schema("intake"))
    assert client.post(f"/api/session/{sid}/intake", json=_intake(seed)).json() == {"accepted": True}
    prog = _wait(lambda: (lambda p: p if p["ready"] or p["error"] else None)(client.get(f"/api/session/{sid}/progress").json()))
    assert prog["error"] is None and prog["stage"] == "ready", prog
    assert [l["label"] for l in prog["lines"]] == ["Preparing your room", "Imagining the other side", "Clearing the table"]
    assert all(l["done"] for l in prog["lines"])
    ts = client.get(f"/api/session/{sid}/trip_script").json()
    jsonschema.validate(ts, _schema("trip_script"))
    assert ts["seed"] == seed and ts["provenance"] == {"planner": "template", "images": "procedural"}
    assert (sdir / "assets" / "room.jpg").exists() and (sdir / "assets" / "room_depth.png").exists()
    assert client.get(f"/sessions/{sid}/assets/room.jpg").status_code == 200

    # front-end output: events (in two batches), a frame, the drawn curve
    events = synthesise_events(ts)
    half = len(events) // 2
    assert client.post(f"/api/session/{sid}/events", json={"events": events[:half]}).json() == {"count": half}
    assert client.post(f"/api/session/{sid}/events", json={"events": events[half:]}).json() == {"count": len(events) - half}
    import base64
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 100, 0)).save(buf, "PNG")
    fr = client.post(f"/api/session/{sid}/frame", json={"name": "peak", "t_min": 1.8,
                                                          "png_base64": base64.b64encode(buf.getvalue()).decode()}).json()
    assert fr == {"path": "frames/peak.png"} and (sdir / "frames" / "peak.png").exists()
    curve = synthesise_drawn_curve(events, seed=3)
    assert client.post(f"/api/session/{sid}/curve", json=curve).json() == {"ok": True}

    assert client.post(f"/api/session/{sid}/finish", json={}).json() == {"started": True}
    rs = _wait(lambda: (lambda r: r if r["done"] or r["error"] else None)(client.get(f"/api/session/{sid}/report_status").json()))
    assert rs["error"] is None and rs["stage"] == "done" and rs["report_html"] == f"/sessions/{sid}/report.html"

    stats = client.get(f"/api/session/{sid}/stats").json()
    expect = compute_stats(load_json(sdir / "trip_script.json"), load_events(sdir), load_json(sdir / "curve.json"),
                           load_json(sdir / "intake.json"), date=sid[:10])
    assert stats == json.loads(json.dumps(expect, ensure_ascii=False))
    assert all(len(line) == 46 for line in stats["box"])

    md = (sdir / "simulated-trip-report.md").read_text()
    assert md.startswith("---\n") and 'title: "Simulated trip report' in md and "simulated: true" in md
    assert "tags: [simulated-trip]" in md and "```text" in md and stats["box"][0] in md
    assert "does not reproduce the drug's effects" in md
    html = (sdir / "report.html").read_text()
    assert "SIMULATED" in html and 'class="watermark"' in html and f"/?replay={sid}" in html and "@media print" in html
    for f in ("report.json", "stats.json", "figures/curves.png", "figures/timeline.png", "figures/curve_vs_drawn.png",
              "event_log.jsonl", "curve.json", "intake.json", "planner.log"):
        assert (sdir / f).exists(), f
    rep = json.loads((sdir / "report.json").read_text())
    assert rep["title"].startswith("Simulated trip report") and 120 * 0.8 <= rep["word_count"] <= 900 * 1.25
    assert (client.export_dir / sid / "simulated-trip-report.md").exists()
    assert client.get(f"/sessions/{sid}/report.html").status_code == 200

    rp = client.get(f"/api/session/{sid}/replay").json()
    assert rp["seed"] == seed and len(rp["events"]) == len(events) and rp["intake"]["seed"] == seed

    lst = client.get("/api/sessions").json()
    row = [x for x in lst if x["id"] == sid][0]
    assert row["has_report"] and row["dose_step"] == "breakthrough" and row["peak_visual"] == stats["peak_visual"]

    assert client.get("/api/status").json()["resident_models"] == []


def test_room_upload_strips_exif(client):
    import io

    from PIL import Image

    sid = client.post("/api/session", json={}).json()["id"]
    img = Image.new("RGB", (3000, 1500), (90, 120, 150))
    exif = Image.Exif()
    exif[0x010F] = "SomeCamera"
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    r = client.post(f"/api/session/{sid}/room", files={"file": ("room.jpg", buf.getvalue(), "image/jpeg")},
                    data={"kind": "panorama"}).json()
    assert r == {"image": "assets/room.jpg", "depth": "assets/room_depth.png", "source": "panorama"}
    out = Image.open(client.sessions_dir / sid / "assets" / "room.jpg")
    assert max(out.size) == 2048 and len(out.getexif()) == 0


def test_unknown_session_404(client):
    assert client.get("/api/session/2020-01-01_0000/progress").status_code == 404
    assert client.get("/api/session/..%2Fetc/progress").status_code == 404
    assert client.get("/").status_code == 200
