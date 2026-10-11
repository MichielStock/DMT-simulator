"""The downloadable report: `export.zip` with the standalone report.html (everything inline), the Markdown report,
frames/*.png, figures/*.png and stats.json. Nothing else (no trip script with sealed text, no intake, no room photo).

The zip is built once into the session folder (`export.zip`, written to a temp file then renamed) and rebuilt only
when one of its members is newer.
"""
from __future__ import annotations

import threading
import zipfile
from pathlib import Path

from backend.report.html import STANDALONE, rebuild_html

ZIP_NAME = "export.zip"
_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def members(session_dir) -> list[tuple[Path, str]]:
    """(source path, name inside the zip) for every member, in zip order."""
    d = Path(session_dir)
    out: list[tuple[Path, str]] = []
    if (d / STANDALONE).exists():
        out.append((d / STANDALONE, "report.html"))
    for name in ("simulated-trip-report.md", "stats.json"):
        if (d / name).exists():
            out.append((d / name, name))
    for sub in ("frames", "figures"):
        if (d / sub).is_dir():
            out += [(f, f"{sub}/{f.name}") for f in sorted((d / sub).glob("*.png"))]
    return out


def zip_name(session_id: str) -> str:
    return f"simulated-trip-report-{session_id}.zip"


def build_zip(session_dir, session_id: str) -> Path:
    """Return the up-to-date export.zip of a reported session (builds or rebuilds it if needed)."""
    d = Path(session_dir)
    with _guard:
        lock = _locks.setdefault(str(d), threading.Lock())
    with lock:
        if not (d / STANDALONE).exists():
            rebuild_html(d, session_id)
        mem = members(d)
        out = d / ZIP_NAME
        if out.exists():
            newest = max((p.stat().st_mtime for p, _ in mem), default=0.0)
            with zipfile.ZipFile(out) as z:
                same = sorted(z.namelist()) == sorted(n for _, n in mem)
            if same and out.stat().st_mtime >= newest:
                return out
        tmp = d / (ZIP_NAME + ".tmp")
        with zipfile.ZipFile(tmp, "w") as z:
            for src, name in mem:
                # PNGs are already compressed: store them; deflate the text files
                comp = zipfile.ZIP_STORED if name.endswith(".png") else zipfile.ZIP_DEFLATED
                z.write(src, name, compress_type=comp)
        tmp.replace(out)
        return out


def listing(zip_path) -> list[dict]:
    with zipfile.ZipFile(zip_path) as z:
        return [{"name": i.filename, "size": i.file_size} for i in z.infolist()]
