"""Dominant-look tag for a clip, from one small frame.

Tags: dark_ambient (most of the frame is dark), neutral (bright but unsaturated:
white light, daylight, grey), or a hue family of the saturated pixels:
red, orange, yellow, green, cyan, blue, purple, magenta.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

from . import ffmpeg_bin

W, H = 32, 18
DARK_V = 0.18  # mean brightness below this reads as "dark ambient"
SAT_MIN = 0.25  # pixels below this saturation don't vote for a hue
NEUTRAL_SHARE = 0.2  # fewer saturated pixels than this → neutral

# Upper hue bounds (degrees) for each family; red wraps around 0/360.
HUE_FAMILIES = [(15, "red"), (45, "orange"), (70, "yellow"), (165, "green"), (200, "cyan"),
                (255, "blue"), (290, "purple"), (340, "magenta"), (360, "red")]


def classify(rgb: np.ndarray) -> tuple[str, tuple[int, int, int]]:
    """Tag and mean colour for an (h, w, 3) uint8 frame."""
    px = rgb.reshape(-1, 3).astype(np.float32) / 255.0
    mx, mn = px.max(axis=1), px.min(axis=1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    mean_rgb = tuple(int(c) for c in (px.mean(axis=0) * 255).round())
    if v.mean() < DARK_V:
        return "dark_ambient", mean_rgb
    vivid = (s >= SAT_MIN) & (v >= 0.2)
    if vivid.mean() < NEUTRAL_SHARE:
        return "neutral", mean_rgb
    r, g, b = px[vivid, 0], px[vivid, 1], px[vivid, 2]
    c = mx[vivid] - mn[vivid]
    hue = np.select(
        [mx[vivid] == r, mx[vivid] == g],
        [((g - b) / c) % 6, (b - r) / c + 2],
        (r - g) / c + 4,
    ) * 60.0
    # Weight by saturation * value so the most vivid light decides.
    weights = s[vivid] * v[vivid]
    hist, edges = np.histogram(hue, bins=36, range=(0, 360), weights=weights)
    peak = (edges[hist.argmax()] + edges[hist.argmax() + 1]) / 2
    for upper, name in HUE_FAMILIES:
        if peak < upper:
            return name, mean_rgb
    return "red", mean_rgb


def clip_color(media: Path, at_sec: float) -> Optional[tuple[str, tuple[int, int, int]]]:
    res = ffmpeg_bin.run_bytes(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-ss", f"{max(at_sec, 0.0):.3f}", "-i", str(media),
         "-frames:v", "1", "-vf", f"scale={W}:{H},format=rgb24", "-f", "rawvideo", "-"],
        timeout=30,
    )
    if res.returncode != 0 or len(res.stdout) < W * H * 3:
        return None
    return classify(np.frombuffer(res.stdout[: W * H * 3], np.uint8).reshape(H, W, 3))
