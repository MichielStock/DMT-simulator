#!/usr/bin/env python3
"""Environment checks (BUILD.md 3.1 steps 1 and 3). Prints a table; exit 0 if all core checks pass.
--json writes verification/env.json (findings + chosen models + fallbacks)."""
from __future__ import annotations

import argparse, json, os, platform, re, shutil, subprocess, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLLAMA = os.environ.get("HYPERSPACE_OLLAMA_HOST", "http://127.0.0.1:11435").rstrip("/")


def run(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def chrome_version():
    for c in ("google-chrome", "chromium", "chromium-browser"):
        p = shutil.which(c)
        if p:
            v = run([p, "--version"])
            if v:
                return v
    return None


def playwright_chromium():
    base = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", Path.home() / ".cache" / "ms-playwright"))
    found = sorted(base.glob("chromium*")) if base.exists() else []
    return found[-1].name if found else None


def node_version():
    p = shutil.which("node")
    v = run([p, "--version"]) if p else None
    return v


def ver_tuple(s):
    m = re.search(r"(\d+)\.(\d+)", s or "")
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="write verification/env.json")
    a = ap.parse_args()
    rows = []  # (name, ok, value, core)
    info = {}

    q = run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
    if q:
        name, mem, drv = [x.strip() for x in q.splitlines()[0].split(",")]
        info["gpu"] = {"name": name, "vram_mib": int(float(mem)), "driver": drv}
        rows.append(("GPU memory >= 20 GB", int(float(mem)) >= 20000, f"{name}, {float(mem) / 1024:.1f} GiB, driver {drv}", True))
    else:
        rows.append(("GPU memory >= 20 GB", False, "nvidia-smi failed", True))

    free = shutil.disk_usage(str(ROOT)).free / 1e9
    info["disk_free_gb"] = round(free, 1)
    rows.append(("disk free >= 60 GB", free >= 60, f"{free:.0f} GB", True))

    py = sys.version_info
    info["python"] = platform.python_version()
    rows.append(("python >= 3.11", py >= (3, 11), info["python"], True))

    nv = node_version()
    info["node"] = nv
    rows.append(("node >= 20", ver_tuple(nv)[0] >= 20, nv or "missing", True))

    try:
        import torch
        cuda = torch.cuda.is_available()
        info["torch"] = torch.__version__
        info["cuda_runtime"] = torch.version.cuda
        rows.append(("torch.cuda.is_available()", cuda, f"torch {torch.__version__} cuda {torch.version.cuda}", True))
    except Exception as e:
        rows.append(("torch.cuda.is_available()", False, f"import failed: {e}", True))

    try:
        with urllib.request.urlopen(OLLAMA + "/api/version", timeout=3) as r:
            ov = json.loads(r.read()).get("version")
        info["ollama"] = {"host": OLLAMA, "version": ov}
        rows.append(("ollama answers (>= 0.5)", ver_tuple(ov) >= (0, 5), f"{ov} at {OLLAMA}", True))
    except Exception as e:
        rows.append(("ollama answers (>= 0.5)", False, f"no answer at {OLLAMA}", True))

    pw = playwright_chromium()
    info["playwright_chromium"] = pw
    rows.append(("playwright chromium", pw is not None, pw or "missing (npx playwright install chromium)", True))

    ff = shutil.which("ffmpeg")
    rows.append(("ffmpeg", ff is not None, ff or "missing", True))

    cv = chrome_version()
    info["browser"] = cv
    rows.append(("system browser (optional)", cv is not None, cv or "none", False))

    w = max(len(r[0]) for r in rows)
    for n, ok, v, core in rows:
        print(f"{'OK  ' if ok else ('FAIL' if core else 'warn')}  {n.ljust(w)}  {v}")
    core_ok = all(ok for _, ok, _, core in rows if core)

    if a.json:
        models = {}
        mj = ROOT / "verification" / "models.json"
        if mj.exists():
            models = json.loads(mj.read_text())
        comps = models.get("components", {})
        env = {
            "written": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "core_ok": core_ok,
            "checks": [{"name": n, "ok": ok, "value": v, "core": c} for n, ok, v, c in rows],
            **info,
            "models": {k: {x: v.get(x) for x in ("status", "id", "peak_vram_gb", "host", "runtime") if x in v}
                       for k, v in comps.items()},
            "llm_model": comps.get("llm", {}).get("id"),
            "llm_host": OLLAMA,
            "images": comps.get("sdxl", {}).get("id", "procedural"),
            "depth": comps.get("depth", {}).get("id", "synthetic"),
            "rembg": comps.get("rembg", {}).get("id"),
            "safety": comps.get("safety", {}).get("id", "clip_only"),
            "clip": comps.get("clip", {}).get("id"),
            "fallbacks": models.get("fallbacks", []),
        }
        out = ROOT / "verification" / "env.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(env, indent=2))
        print(f"wrote {out}")
    return 0 if core_ok else 1


if __name__ == "__main__":
    sys.exit(main())
