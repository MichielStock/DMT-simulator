"""Room depth (BUILD.md §10, §0.6): Depth Anything V2 Small via the transformers depth-estimation pipeline.

Convention (CONTRACTS.md amendment): `room_depth.png` is an 8-bit greyscale PNG, same size as `room.jpg`
(≤ 2048 px long side), WHITE = NEAR, BLACK = FAR, normalised to the 1st–99th percentile. The synthetic
fallback (`backend.assets.synthetic_depth`) uses the same convention. Panoramas: the same model on the
equirect image, run twice (rolled by half a turn) and blended so the 360° seam is continuous.
"""
from __future__ import annotations

import time

import numpy as np
from PIL import Image

from backend import runtime

REGISTRY_NAME = "depth_anything_v2_small"
LAST_PHASE: dict = {}  # torch peak/seconds of the last room_depth() call (recorded in room_meta.json)


class DepthModel:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.pipe = None
        self.load_seconds = None

    def load(self) -> "DepthModel":
        if self.pipe is not None:
            return self
        runtime.set_offline_env()
        t0 = time.time()
        runtime.register(REGISTRY_NAME, "depth", device=self.device)
        try:
            import torch
            from huggingface_hub import snapshot_download
            from transformers import pipeline

            from backend.models_registry import HF_IDS

            path = snapshot_download(HF_IDS["depth"], local_files_only=True)
            dev = 0 if (self.device == "cuda" and torch.cuda.is_available()) else -1
            self.pipe = pipeline("depth-estimation", model=path, device=dev,
                                 torch_dtype=torch.float16 if dev == 0 else torch.float32)
        except Exception:
            self.unload()
            raise
        self.load_seconds = round(time.time() - t0, 2)
        return self

    def unload(self) -> None:
        self.pipe = None
        from backend.assets.vram import free_gpu

        free_gpu()
        runtime.unregister(REGISTRY_NAME)

    def __enter__(self):
        return self.load()

    def __exit__(self, *exc):
        self.unload()
        return False

    def raw(self, img: Image.Image) -> np.ndarray:
        """float32 HxW in 0..1 at the image size, near = 1 (Depth Anything predicts relative inverse depth)."""
        import torch

        img = img.convert("RGB")
        w, h = img.size
        with torch.inference_mode():
            out = self.pipe(img)
        pd = out["predicted_depth"]
        pd = pd if pd.dim() == 4 else pd.reshape(1, 1, *pd.shape[-2:])
        pd = torch.nn.functional.interpolate(pd.float(), size=(h, w), mode="bicubic", align_corners=False)[0, 0]
        d = pd.cpu().numpy().astype(np.float32)
        lo, hi = np.percentile(d, 1), np.percentile(d, 99)
        return np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)

    def estimate(self, img: Image.Image, panorama: bool = False, smooth: bool = True) -> Image.Image:
        if panorama:
            from backend.assets.panorama import wrap_blend

            d = wrap_blend(self.raw, img)
        else:
            d = self.raw(img)
        return to_png(d, img if smooth else None)


def to_png(d: np.ndarray, guide: Image.Image | None = None) -> Image.Image:
    """float depth (near = 1) → 8-bit L image; optional edge-aware smoothing guided by the photo."""
    d8 = (np.clip(d, 0, 1) * 255 + 0.5).astype(np.uint8)
    if guide is not None:
        import cv2

        g = np.asarray(guide.convert("RGB"))
        try:
            d8 = cv2.ximgproc.jointBilateralFilter(g, d8, 7, 12, 5)  # opencv-contrib only
        except Exception:
            d8 = cv2.bilateralFilter(d8, 7, 12, 5)
    return Image.fromarray(d8, mode="L")


def room_depth(img: Image.Image, panorama: bool = False) -> tuple[Image.Image, str]:
    """Depth model if possible, else the synthetic fallback. Returns (depth image, source tag). Unloads after."""
    if not runtime.no_images():
        try:
            from backend.assets.vram import PhaseMeter

            meter = PhaseMeter()
            with meter.phase("room"), DepthModel() as m:
                d = m.estimate(img, panorama=panorama)
            LAST_PHASE.clear()
            LAST_PHASE.update(meter.phases.get("room", {}))
            return d, "depth_anything_v2_small"
        except Exception as e:  # §0.6: synthetic depth
            runtime.note_fallback(f"room depth: synthetic ({type(e).__name__})")
    from backend.assets import synthetic_depth

    return synthetic_depth(img), "synthetic"
