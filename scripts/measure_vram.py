"""Measure graphics memory per intake phase and intake→ready wall time (BUILD.md §3.3, M8 gate).

Runs a real breakthrough session (language model + real images) against a back end, sampling every 0.25 s:
nvidia-smi (whole card and the back-end process), Ollama /api/ps size_vram, and the settling progress stage.
Writes verification/vram.json and prints the §3.3 table. Gate: intake→ready < 180 s and no resident models.

  uv run python scripts/measure_vram.py [--port 8776] [--start] [--seed 20261010] [--dose breakthrough]

--start launches `uvicorn backend.app:app` on the port with HYPERSPACE_SESSIONS_DIR=verification/tmp/vram/sessions
(no FORCE_TEMPLATES, no NO_IMAGES) and stops it afterwards.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
GIB = 1024 ** 3


def smi() -> tuple[float, dict[int, float]]:
    try:
        tot = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        apps = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                              capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        per = {}
        for line in apps:
            pid, mb = [x.strip() for x in line.split(",")]
            per[int(pid)] = float(mb) / 1024
        return float(tot[0]) / 1024, per
    except Exception:
        return 0.0, {}


class Sampler(threading.Thread):
    def __init__(self, base: str, ollama: str, server_pid: int | None):
        super().__init__(daemon=True)
        self.base, self.ollama, self.server_pid = base, ollama, server_pid
        self.sid = None
        self.stage = "idle"
        self.samples: list[dict] = []
        self.stop = threading.Event()

    def run(self):
        with httpx.Client(timeout=3) as c:
            while not self.stop.is_set():
                t = time.time()
                total, per = smi()
                try:
                    ps = c.get(self.ollama + "/api/ps").json().get("models", [])
                    llm = sum(m.get("size_vram", 0) for m in ps) / GIB
                except Exception:
                    llm = 0.0
                if self.sid:
                    try:
                        self.stage = c.get(f"{self.base}/api/session/{self.sid}/progress").json().get("stage", self.stage)
                    except Exception:
                        pass
                self.samples.append({"t": t, "stage": self.stage, "card_gb": round(total, 3),
                                     "server_gb": round(per.get(self.server_pid, 0.0), 3) if self.server_pid else None,
                                     "llm_gb": round(llm, 3)})
                self.stop.wait(max(0.0, 0.25 - (time.time() - t)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8776)
    ap.add_argument("--start", action="store_true")
    ap.add_argument("--seed", type=int, default=20261010)
    ap.add_argument("--dose", default="breakthrough")
    ap.add_argument("--sessions-dir", default=str(ROOT / "verification" / "tmp" / "vram" / "sessions"))
    ap.add_argument("--out", default=str(ROOT / "verification" / "vram.json"))
    a = ap.parse_args()
    base = f"http://127.0.0.1:{a.port}"
    ollama = os.environ.get("HYPERSPACE_OLLAMA_HOST", "http://127.0.0.1:11435").rstrip("/")
    proc = None
    if a.start:
        env = dict(os.environ, HYPERSPACE_SESSIONS_DIR=a.sessions_dir)
        for k in ("HYPERSPACE_FORCE_TEMPLATES", "HYPERSPACE_NO_IMAGES"):
            env.pop(k, None)
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1",
                                 "--port", str(a.port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                                stderr=open(ROOT / "verification" / "tmp" / "vram_server.log", "w"))
    c = httpx.Client(base_url=base, timeout=60)
    for _ in range(240):
        try:
            if c.get("/api/status").json().get("ok"):
                break
        except Exception:
            time.sleep(0.5)
    st0 = c.get("/api/status").json()
    server_pid = proc.pid if proc else None
    baseline, _ = smi()
    smp = Sampler(base, ollama, server_pid)
    smp.start()
    try:
        sid = c.post("/api/session", json={"seed": a.seed}).json()["id"]
        smp.sid = sid
        t_upload = time.time()
        smp.stage = "room_upload"
        room = (ROOT / "assets" / "sample" / "room.jpg").read_bytes()
        r = c.post(f"/api/session/{sid}/room", files={"file": ("room.jpg", room, "image/jpeg")}, data={"kind": "photo"})
        r.raise_for_status()
        t_room = time.time() - t_upload
        intake = json.loads((ROOT / "tests" / "e2e" / "profiles" / "neutral.json").read_text())
        intake.update(dose_step=a.dose, seed=a.seed)
        intake["room"] = {"source": "photo", "image": "assets/room.jpg", "depth": "assets/room_depth.png"}
        t0 = time.time()
        assert c.post(f"/api/session/{sid}/intake", json=intake).json()["accepted"]
        while True:
            p = c.get(f"/api/session/{sid}/progress").json()
            if p["ready"] or p["stage"] == "error" or time.time() - t0 > 600:
                break
            time.sleep(0.25)
        t_ready = time.time() - t0
        time.sleep(1.0)
        st = c.get("/api/status").json()
    finally:
        smp.stop.set()
        smp.join(2)
    sdir = Path(a.sessions_dir) / sid
    try:
        ts = c.get(f"/api/session/{sid}/trip_script").json()
    except Exception:
        ts = {}
    man = {}
    for cand in (sdir / "assets" / "manifest.json",):
        if cand.exists():
            man = json.loads(cand.read_text())
    phases: dict[str, dict] = {}
    for s in smp.samples:
        ph = {"room_upload": "room", "room": "room", "planning": "planning", "images": "images",
              "unloading": "unloading", "ready": "ready"}.get(s["stage"], s["stage"])
        rec = phases.setdefault(ph, {"samples": 0, "card_peak_gb": 0.0, "server_peak_gb": 0.0, "llm_peak_gb": 0.0})
        rec["samples"] += 1
        rec["card_peak_gb"] = max(rec["card_peak_gb"], s["card_gb"])
        rec["server_peak_gb"] = max(rec["server_peak_gb"], s["server_gb"] or 0.0)
        rec["llm_peak_gb"] = max(rec["llm_peak_gb"], s["llm_gb"])
    for rec in phases.values():
        rec["card_peak_above_baseline_gb"] = round(rec["card_peak_gb"] - baseline, 3)
    after_ready = [s for s in smp.samples if s["stage"] == "ready"]
    out = {
        "measured": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "session": sid, "dose": a.dose, "seed": a.seed,
        "planner": (ts.get("provenance") or {}).get("planner"), "images": (ts.get("provenance") or {}).get("images"),
        "room_upload_seconds": round(t_room, 1), "intake_to_ready_seconds": round(t_ready, 1),
        "gate_seconds": 180, "gate_passed": bool(p.get("ready")) and t_ready < 180 and st["resident_models"] == [],
        "resident_models_after_ready": st["resident_models"], "progress_final": p,
        "card_baseline_gb": round(baseline, 3), "phases_nvidia_smi": phases,
        "phases_torch": man.get("phases"),
        "room_depth_torch": (json.loads((sdir / "assets" / "room_meta.json").read_text()).get("vram")
                             if (sdir / "assets" / "room_meta.json").exists() else None), "asset_seconds": man.get("seconds"),
        "asset_budget": man.get("budget"), "rejections": len(man.get("rejections", [])),
        "server_gb_after_ready": after_ready[-1]["server_gb"] if after_ready else None,
        "samples": smp.samples[::4],
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, indent=1))
    print(f"intake→ready {t_ready:.1f} s (gate < 180 s: {'PASS' if out['gate_passed'] else 'FAIL'}); "
          f"planner={out['planner']} images={out['images']} resident after ready={st['resident_models']}")
    print("| Phase | card peak above baseline (GB) | back-end process peak (GB) | Ollama size_vram peak (GB) |")
    print("|---|---|---|---|")
    for ph, rec in phases.items():
        print(f"| {ph} | {rec['card_peak_above_baseline_gb']:.2f} | {rec['server_peak_gb']:.2f} | {rec['llm_peak_gb']:.2f} |")
    if proc:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(20)
        except Exception:
            proc.kill()
    return 0 if out["gate_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
