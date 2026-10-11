"""Downloadable report (export.zip), the standalone HTML, the chronological snapshot strip and GET /frames."""
import base64
import importlib
import io
import json
import re
import time
import zipfile

import pytest
from PIL import Image


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("export")
    mp = pytest.MonkeyPatch()
    mp.setenv("HYPERSPACE_FORCE_TEMPLATES", "1")
    mp.setenv("HYPERSPACE_NO_IMAGES", "1")
    mp.setenv("HYPERSPACE_SESSIONS_DIR", str(tmp_path / "sessions"))
    mp.delenv("REPORT_EXPORT_DIR", raising=False)
    from fastapi.testclient import TestClient

    import backend.app as appmod

    importlib.reload(appmod)
    try:
        with TestClient(appmod.create_app()) as c:
            c.sessions_dir = tmp_path / "sessions"
            yield c
    finally:
        mp.undo()


@pytest.fixture(scope="module")
def sid(client):
    return _reported_session(client)


def _wait(fn, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = fn()
        if r:
            return r
        time.sleep(0.1)
    raise AssertionError("timed out")


def _png(colour, size=(64, 36)):
    buf = io.BytesIO()
    Image.new("RGBA", size, colour).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


# (name, t_min, layer) — posted out of chronological order on purpose
FRAMES = [("peak", 1.85, "breakthrough"), ("snap_02", 2.4, "waiting_room"), ("layer_enter_form_constants", 0.31, "room"),
          ("snap_01", 1.2, "chrysanthemum"), ("entity_0", 1.5, "breakthrough"), ("message", 1.7, "breakthrough")]


def _reported_session(client):
    from backend.batch.synth import synthesise_drawn_curve, synthesise_events
    from backend.tests.test_api import _intake

    sid = client.post("/api/session", json={"seed": 777}).json()["id"]
    assert client.post(f"/api/session/{sid}/intake", json=_intake(777, source="default")).json() == {"accepted": True}
    _wait(lambda: client.get(f"/api/session/{sid}/progress").json()["ready"])
    ts = client.get(f"/api/session/{sid}/trip_script").json()
    events = [e for e in synthesise_events(ts) if e["type"] != "frame_captured"]
    for i, (name, t, layer) in enumerate(FRAMES):
        r = client.post(f"/api/session/{sid}/frame", json={"name": name, "t_min": t, "layer": layer,
                                                            "png_base64": _png((40 * i, 120, 200 - 30 * i, 255))})
        assert r.status_code == 200
        if name != "message":  # one frame without its event: timing must come from the sidecar
            events.append({"t_min": t, "type": "frame_captured", "payload": {"name": name, "path": f"frames/{name}.png",
                                                                             "layer": layer}})
    assert client.post(f"/api/session/{sid}/events", json={"events": events}).status_code == 200
    client.post(f"/api/session/{sid}/curve", json=synthesise_drawn_curve(events, seed=3))
    # not reported yet: no export
    assert client.get(f"/api/session/{sid}/export.zip").status_code == 404
    assert client.get(f"/api/session/{sid}/export.json").status_code == 404
    client.post(f"/api/session/{sid}/finish", json={})
    _wait(lambda: client.get(f"/api/session/{sid}/report_status").json()["done"])
    return sid


def test_frames_listing_chronological_with_captions(client, sid):
    fr = client.get(f"/api/session/{sid}/frames").json()
    assert [f["name"] for f in fr] == ["layer_enter_form_constants", "snap_01", "entity_0", "message", "peak", "snap_02"]
    caps = {f["name"]: f["caption"] for f in fr}
    assert caps == {"layer_enter_form_constants": "0:19 · entering form constants", "snap_01": "1:12 · chrysanthemum",
                    "entity_0": "1:30 · a being", "message": "1:42 · the message", "peak": "1:51 · the peak",
                    "snap_02": "2:24 · waiting room"}
    assert all(f["path"] == f"frames/{f['name']}.png" for f in fr)


def test_export_zip_members_and_standalone_html(client, sid):
    sdir = client.sessions_dir / sid
    assert (sdir / "report-standalone.html").exists()

    r = client.get(f"/api/session/{sid}/export.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert f'simulated-trip-report-{sid}.zip' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    expect = {"report.html", "simulated-trip-report.md", "stats.json"} | {f"frames/{n}.png" for n, _, _ in FRAMES} | {
        f"figures/{f}" for f in ("curves.png", "timeline.png", "curve_vs_drawn.png")}
    assert names == expect, names ^ expect
    # nothing private or sealed
    assert not any(n.startswith(("trip_script", "intake", "assets", "event_log", "session")) for n in names)

    html = z.read("report.html").decode()
    assert html == (sdir / "report-standalone.html").read_text()
    assert "SIMULATED" in html and 'class="watermark"' in html and "@media print" in html
    imgs = re.findall(r'<img[^>]*\ssrc="([^"]*)"', html)
    assert len(imgs) >= 1 + 3 + 3  # hero + strip (a multiple of 3, hero left out; NOTES D-F3) + figures
    assert all(s.startswith("data:image/") for s in imgs), [s[:40] for s in imgs if not s.startswith("data:")]
    urls = re.findall(r"url\(\s*['\"]?([^'\")]*)", html)
    assert urls and all(u.startswith("data:") for u in urls)
    assert "data:font/ttf;base64," in html  # VT323 inlined
    assert not re.search(r'\s(?:src|href)="/(?!/)', html)  # no server-absolute links in the offline copy
    # the inlined frames really are images
    for s in imgs:
        head, b64 = s.split(",", 1)
        Image.open(io.BytesIO(base64.b64decode(b64))).verify()

    md = z.read("simulated-trip-report.md").decode()
    assert "## Snapshots" in md and "## Captured frames" not in md
    assert "![1:12 · chrysanthemum](frames/snap_01.png)" in md
    assert md.index("frames/layer_enter_form_constants.png") < md.index("frames/snap_01.png") < md.index("frames/snap_02.png")
    assert json.loads(z.read("stats.json"))["dose_step"] == "BREAKTHROUGH"

    info = client.get(f"/api/session/{sid}/export.json").json()
    assert {m["name"] for m in info["members"]} == expect and info["filename"].endswith(".zip")


def test_report_page_strip_and_actions(client, sid):
    html = (client.sessions_dir / sid / "report.html").read_text()
    assert f'href="/api/session/{sid}/export.zip"' in html and " download=" in html
    for k in ("[D] DOWNLOAD .ZIP", "[P] PRINT", "[R] REPLAY", "[T] TITLE"):
        assert k.replace("[", "<b>[").replace("]", "]</b>") in html, k
    assert f"/?replay={sid}" in html and 'data-key="d"' in html
    strip = re.findall(r'<figure data-name="([^"]+)" data-t-min="([0-9.]+)"', html)
    ts = [float(t) for _, t in strip]
    assert ts == sorted(ts)
    # NOTES D-F3: the peak is the hero, not in the strip; trimmed to a multiple of 3 by dropping the periodic
    # snaps closest to another frame (snap_01 is 0.3 min from entity_0, then snap_02)
    assert [n for n, _ in strip] == ["layer_enter_form_constants", "entity_0", "message"]
    assert 'data-testid="hero"' in html and 'src="frames/peak.png"' in html


def test_old_session_gets_standalone_on_export(client, sid):
    sdir = client.sessions_dir / sid
    (sdir / "report-standalone.html").unlink()
    (sdir / "export.zip").unlink(missing_ok=True)
    r = client.get(f"/api/session/{sid}/export.zip")
    assert r.status_code == 200 and "report.html" in zipfile.ZipFile(io.BytesIO(r.content)).namelist()


def test_export_unknown_session_404(client):
    assert client.get("/api/session/2020-01-01_0000/export.zip").status_code == 404
    assert client.get("/api/session/../etc/export.zip").status_code == 404


def test_story_frames_drops_copies_and_relabels(tmp_path):
    """NOTES D-F2/D-F3: byte-identical frames once (the named moment wins), hero out, layer_enter captioned by
    what it shows, at most 6 periodic snaps, a multiple of 3."""
    from backend.report.html import story_frames

    (tmp_path / "frames").mkdir()

    def fr(name, t, kind, layer=None, data=None):
        (tmp_path / "frames" / f"{name}.png").write_bytes(data or name.encode())
        return {"name": name, "path": f"frames/{name}.png", "t_min": t, "layer": layer, "kind": kind,
                "caption": f"{t} · {name}"}

    frames = [fr("layer_enter_breakthrough", 1.0, "layer", "chrysanthemum"), fr("entity_0", 1.5, "being", data=b"same"),
              fr("snap_02", 1.5, "snapshot", data=b"same"), fr("peak", 2.0, "peak")]
    frames += [fr(f"snap_{i:02d}", 2.0 + i, "snapshot") for i in range(3, 13)]
    out = story_frames(tmp_path, frames, exclude="peak", multiple=3)
    names = [f["name"] for f in out]
    assert "snap_02" not in names and "entity_0" in names and "peak" not in names
    assert sum(f["kind"] == "snapshot" for f in out) <= 6 and len(out) % 3 == 0
    assert out[0]["caption"] == "1:00 · chrysanthemum → breakthrough"
