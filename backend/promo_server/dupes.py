"""Find duplicate / near-duplicate raw files before anyone spends time logging them.

Two checks:
  exact  – same size and same SHA-1 of the first 4 MB (copies of the same file)
  visual – similar duration and a matching 64-bit dHash at 30%, 50% and 70% of the
           file (re-encodes, re-exports, the same clip saved twice)

Frames with almost no detail (black, pocket, floor shots) don't count as evidence,
otherwise every dark file would "match". A trimmed copy of a clip won't line up at
the same relative times and isn't detected.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from . import ffmpeg_bin

log = logging.getLogger(__name__)

SAMPLE_FRACS = (0.3, 0.5, 0.7)
HASH_W, HASH_H = 9, 8  # dHash: 8x8 horizontal gradients = 64 bits
MAX_HAMMING = 6  # of 64 bits
MIN_DETAIL = 0.03  # std of the sample frame; below this it's a blank frame
DURATION_TOL = 0.5  # seconds, or 2% of the duration if larger
HEAD_BYTES = 4 * 1024 * 1024


@dataclass
class Signature:
    path: str
    size: int
    head_sha1: str
    duration: Optional[float]
    hashes: list[Optional[int]]  # None for a blank or unreadable sample


def dhash(gray: np.ndarray) -> int:
    """64-bit difference hash of a (8, 9) grayscale frame."""
    bits = (gray[:, 1:] > gray[:, :-1]).flatten()
    return int(sum(1 << i for i, b in enumerate(bits) if b))


def signature(path: str) -> Signature:
    p = Path(path)
    with p.open("rb") as f:
        head = hashlib.sha1(f.read(HEAD_BYTES)).hexdigest()
    info = ffmpeg_bin.probe(path)
    hashes: list[Optional[int]] = []
    for frac in SAMPLE_FRACS:
        if not info.duration:
            hashes.append(None)
            continue
        res = ffmpeg_bin.run_bytes(
            [ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-ss", f"{info.duration * frac:.3f}", "-i", path,
             "-frames:v", "1", "-vf", f"scale={HASH_W}:{HASH_H},format=gray", "-f", "rawvideo", "-"],
            timeout=60,
        )
        n = HASH_W * HASH_H
        if res.returncode != 0 or len(res.stdout) < n:
            hashes.append(None)
            continue
        gray = np.frombuffer(res.stdout[:n], np.uint8).reshape(HASH_H, HASH_W).astype(np.float32) / 255.0
        hashes.append(dhash(gray) if gray.std() >= MIN_DETAIL else None)
    return Signature(path, p.stat().st_size, head, info.duration, hashes)


def is_duplicate(a: Signature, b: Signature) -> bool:
    if a.size == b.size and a.head_sha1 == b.head_sha1:
        return True
    if not a.duration or not b.duration:
        return False
    if abs(a.duration - b.duration) > max(DURATION_TOL, 0.02 * max(a.duration, b.duration)):
        return False
    compared = 0
    for ha, hb in zip(a.hashes, b.hashes):
        if ha is None or hb is None:
            continue
        if bin(ha ^ hb).count("1") > MAX_HAMMING:
            return False
        compared += 1
    # Two matching detailed frames are needed; blank samples never make files equal.
    return compared >= 2


def group(sigs: list[Signature]) -> list[list[str]]:
    """Groups of duplicate paths (size >= 2), each in the input order, first = the one to keep."""
    parent = list(range(len(sigs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(sigs)):
        for j in range(i + 1, len(sigs)):
            if is_duplicate(sigs[i], sigs[j]):
                parent[find(j)] = find(i)
    groups: dict[int, list[str]] = {}
    for i, s in enumerate(sigs):
        groups.setdefault(find(i), []).append(s.path)
    return [g for g in groups.values() if len(g) > 1]


class DupeScanner:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._cache: dict[tuple[str, int, int], Signature] = {}
        self.status: dict = {"state": "idle"}

    def start(self, paths: list[str]) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise RuntimeError("A duplicate scan is already running.")
            self.status = {"state": "running", "done": 0, "total": len(paths), "groups": None, "error": None}
            self._thread = threading.Thread(target=self._run, args=(paths,), daemon=True)
            self._thread.start()
            return self.status

    def _sig(self, path: str) -> Optional[Signature]:
        try:
            st = Path(path).stat()
            key = (path, st.st_size, st.st_mtime_ns)
            if key not in self._cache:
                self._cache[key] = signature(path)
            return self._cache[key]
        except Exception as exc:  # noqa: BLE001 - an unreadable file just isn't compared
            log.warning("dupe scan: skipping %s: %s", path, exc)
            return None
        finally:
            with self._lock:
                self.status["done"] += 1

    def _run(self, paths: list[str]) -> None:
        try:
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix="dupes") as pool:
                sigs = [s for s in pool.map(self._sig, paths) if s is not None]
            with self._lock:
                self.status.update(state="done", groups=group(sigs))
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            log.exception("duplicate scan failed")
            with self._lock:
                self.status.update(state="error", error=str(exc))
