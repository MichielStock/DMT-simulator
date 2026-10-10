"""Graphics-memory discipline (BUILD.md §3.3): per-phase peak measurement and verified unloading.

`PhaseMeter` records, per named phase, the peak torch allocation/reservation of this process and the
wall time. `free_gpu()` runs gc + torch.cuda.empty_cache and returns the allocated MB afterwards.
Never imports torch at module import time (the procedural path must not touch CUDA).
"""
from __future__ import annotations

import contextlib
import gc
import sys
import time

MB = 1024 * 1024


def _torch():
    """torch if it is already imported or importable with CUDA, else None (never initialises CUDA needlessly)."""
    try:
        import torch  # noqa: WPS433
    except Exception:
        return None
    try:
        return torch if torch.cuda.is_available() else None
    except Exception:
        return None


def allocated_mb() -> float:
    if "torch" not in sys.modules:
        return 0.0
    t = _torch()
    if t is None or not t.cuda.is_initialized():
        return 0.0
    return t.cuda.memory_allocated() / MB


def free_gpu() -> float:
    """Collect garbage and release cached blocks; returns torch.cuda.memory_allocated() in MB afterwards."""
    gc.collect()
    if "torch" in sys.modules:
        t = _torch()
        if t is not None and t.cuda.is_initialized():
            t.cuda.synchronize()
            t.cuda.empty_cache()
            with contextlib.suppress(Exception):
                t.cuda.ipc_collect()
    gc.collect()
    return allocated_mb()


class PhaseMeter:
    """with meter.phase("images"): ...  → meter.phases["images"] = {seconds, peak_allocated_gb, peak_reserved_gb}."""

    def __init__(self) -> None:
        self.phases: dict[str, dict] = {}

    @contextlib.contextmanager
    def phase(self, name: str):
        t = _torch() if "torch" in sys.modules else None
        if t is not None and t.cuda.is_initialized():
            t.cuda.reset_peak_memory_stats()
        t0 = time.time()
        try:
            yield
        finally:
            rec = self.phases.setdefault(name, {"seconds": 0.0, "peak_allocated_gb": 0.0, "peak_reserved_gb": 0.0})
            rec["seconds"] = round(rec["seconds"] + time.time() - t0, 2)
            t = _torch() if "torch" in sys.modules else None
            if t is not None and t.cuda.is_initialized():
                rec["peak_allocated_gb"] = round(max(rec["peak_allocated_gb"], t.cuda.max_memory_allocated() / 1024 ** 3), 3)
                rec["peak_reserved_gb"] = round(max(rec["peak_reserved_gb"], t.cuda.max_memory_reserved() / 1024 ** 3), 3)
