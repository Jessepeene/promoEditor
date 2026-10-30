"""Auto-harvest: propose good moments from a large pool of raw files without watching them.

Only keyframes are decoded (`-skip_frame nokey`), scaled to 64x36 grayscale, so
analysing a long 4K file costs a fraction of a second. Each keyframe gets:
  motion   – mean absolute difference from the previous keyframe, per second
  contrast – standard deviation of the frame
  level    – mean brightness
Dark or flat frames and the first/last 10% of each file are ignored. The best
moment per file is ranked by motion x contrast; energy tags follow motion rank.
The calmest well-exposed picks become RANGE breather clips (tier 0).
"""

from __future__ import annotations

import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from . import ffmpeg_bin

log = logging.getLogger(__name__)

W, H = 64, 36
MIN_DURATION = 1.5
EDGE_FRAC = 0.10
DARK_LEVEL = 0.03  # near-black only: rave footage is dark but contrasty
FLAT_CONTRAST = 0.04
ANCHOR_PAD = 2.0
BREATHER_LEN = 4.0
SECOND_PICK_GAP = 4.0

_PTS_RE = re.compile(r"pts_time:\s*(-?[\d.]+)")


@dataclass
class Moment:
    path: str
    t: float
    motion: float
    contrast: float
    level: float
    duration: float

    @property
    def score(self) -> float:
        return self.motion * (0.5 + self.contrast)


def analyse(path: str) -> list[Moment]:
    """Scored keyframes of one file (empty if too short or unreadable)."""
    info = ffmpeg_bin.probe(path)
    if not info.duration or info.duration < MIN_DURATION:
        return []
    res = ffmpeg_bin.run_bytes(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "info", "-hide_banner", "-skip_frame", "nokey", "-i", path, "-an",
         "-vf", f"scale={W}:{H},format=gray,showinfo", "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        timeout=600,
    )
    frames = np.frombuffer(res.stdout, dtype=np.uint8)
    n = len(frames) // (W * H)
    times = [float(t) for t in _PTS_RE.findall(res.stderr.decode(errors="replace"))][:n]
    if n < 2 or len(times) < n:
        return []
    frames = frames[: n * W * H].reshape(n, H, W).astype(np.float32) / 255.0
    lo, hi = info.duration * EDGE_FRAC, info.duration * (1 - EDGE_FRAC)
    out = []
    for i in range(1, n):
        t = times[i]
        dt = max(times[i] - times[i - 1], 1e-3)
        f = frames[i]
        level, contrast = float(f.mean()), float(f.std())
        if not lo <= t <= hi or level < DARK_LEVEL or contrast < FLAT_CONTRAST:
            continue
        motion = float(np.abs(f - frames[i - 1]).mean()) / dt
        out.append(Moment(path, t, motion, contrast, level, info.duration))
    return out


def select(moments_per_file: list[list[Moment]], count: int, breathers: int) -> list[dict]:
    """Pick `count` anchor clips spread across files plus `breathers` calm RANGE clips."""
    best = [max(ms, key=lambda m: m.score) for ms in moments_per_file if ms]
    best.sort(key=lambda m: m.score, reverse=True)
    picks = best[:count]
    if len(picks) < count:
        # Fewer files than wanted: take second moments, well apart from the first pick.
        taken = {m.path: m.t for m in picks}
        extra = [m for ms in moments_per_file for m in ms
                 if m.path in taken and abs(m.t - taken[m.path]) >= SECOND_PICK_GAP]
        extra.sort(key=lambda m: m.score, reverse=True)
        used: set[str] = set()
        for m in extra:
            if len(picks) >= count:
                break
            if m.path not in used:
                picks.append(m)
                used.add(m.path)

    clips = []
    ranked = sorted(picks, key=lambda m: m.motion, reverse=True)
    for rank, m in enumerate(ranked):
        frac = rank / max(len(ranked), 1)
        tag = 4 if frac < 0.25 else 3 if frac < 0.5 else 2 if frac < 0.75 else 1  # motion quartiles
        clips.append({"source_path": m.path, "mode": "ANCHOR", "energy_tag": tag, "anchor_sec": round(m.t, 4),
                      "in_sec": round(max(0.0, m.t - ANCHOR_PAD), 4),
                      "out_sec": round(min(m.duration, m.t + ANCHOR_PAD), 4)})

    # Breathers: the smoothest bright, contrasty moment in files not already used.
    used_paths = {m.path for m in picks}
    calm = [min(ms, key=lambda m: m.motion) for ms in moments_per_file if ms and ms[0].path not in used_paths]
    calm = [m for m in calm if m.duration >= BREATHER_LEN]
    calm.sort(key=lambda m: (m.motion, -m.contrast))
    for m in calm[:breathers]:
        start = min(max(0.0, m.t - BREATHER_LEN / 2), m.duration - BREATHER_LEN)
        clips.append({"source_path": m.path, "mode": "RANGE", "energy_tag": 0, "anchor_sec": None,
                      "in_sec": round(start, 4), "out_sec": round(start + BREATHER_LEN, 4)})
    return clips


class Harvester:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self.status: dict = {"state": "idle"}

    def start(self, paths: list[str], count: int, breathers: int) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise RuntimeError("A harvest is already running.")
            self.status = {"state": "running", "done": 0, "total": len(paths), "clips": None, "error": None,
                           "skipped": 0}
            self._thread = threading.Thread(target=self._run, args=(paths, count, breathers), daemon=True)
            self._thread.start()
            return self.status

    def _run(self, paths: list[str], count: int, breathers: int) -> None:
        results: list[list[Moment]] = []
        try:
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix="harvest") as pool:
                for moments in pool.map(_safe_analyse, paths):
                    results.append(moments)
                    with self._lock:
                        self.status["done"] += 1
                        self.status["skipped"] += 0 if moments else 1
            clips = select(results, count, breathers)
            with self._lock:
                self.status.update(state="done", clips=clips)
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            log.exception("harvest failed")
            with self._lock:
                self.status.update(state="error", error=str(exc))


def _safe_analyse(path: str) -> list[Moment]:
    """One unreadable file shouldn't sink the whole harvest; it is counted as skipped."""
    try:
        return analyse(path)
    except Exception as exc:  # noqa: BLE001
        log.warning("harvest: skipping %s: %s", path, exc)
        return []
