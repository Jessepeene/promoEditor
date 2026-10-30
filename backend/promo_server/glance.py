"""Short low-res "glance" clips for the logger's contact-sheet grid.

Twenty raw camera files can't decode side by side in a browser, so each tile
plays a 3-second, 240p H.264 excerpt starting 30% into the file (past the
camera-setup frames). Glances are made on demand, page by page.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import ffmpeg_bin

log = logging.getLogger(__name__)

START_FRAC = 0.30
LENGTH_SEC = 3.0
HEIGHT = 240


class GlanceQueue:
    def __init__(self, cache_dir: Path):
        self.dir = cache_dir / "glance"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="glance")
        self._lock = threading.Lock()
        self._inflight: set[str] = set()
        self._errors: dict[str, str] = {}

    def _key(self, src: Path) -> str:
        st = src.stat()
        return hashlib.sha1(f"{src.resolve()}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]

    def status(self, src: Path) -> dict:
        """Ready glance info, or the pending/error state (and enqueue it if not started)."""
        key = self._key(src)
        meta_path = self.dir / f"{key}.json"
        if meta_path.exists():
            return {"status": "ready", **json.loads(meta_path.read_text())}
        with self._lock:
            if key in self._errors:
                return {"status": "error", "error": self._errors[key]}
            if key not in self._inflight:
                self._inflight.add(key)
                self._pool.submit(self._make, src, key)
        return {"status": "pending"}

    def _make(self, src: Path, key: str) -> None:
        try:
            info = ffmpeg_bin.probe(str(src))
            if not info.duration:
                raise RuntimeError("could not read duration")
            length = min(LENGTH_SEC, info.duration)
            start = min(info.duration * START_FRAC, max(info.duration - length, 0.0))
            out = self.dir / f"{key}.mp4"
            tmp = out.with_suffix(".tmp.mp4")
            res = ffmpeg_bin.run(
                [ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
                 "-i", str(src), "-an", "-vf", f"scale=-2:{HEIGHT},format=yuv420p",
                 "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "15", "-movflags", "+faststart",
                 str(tmp)],
                timeout=300,
            )
            if res.returncode != 0 or not tmp.exists():
                raise RuntimeError(res.stderr.strip()[-300:] or "ffmpeg failed")
            tmp.replace(out)
            meta = {"glance_path": str(out), "start_sec": round(start, 4), "length_sec": round(length, 4),
                    "source_duration_sec": info.duration}
            # Written last: its existence is what marks the glance ready.
            (self.dir / f"{key}.json").write_text(json.dumps(meta))
        except Exception as exc:  # noqa: BLE001 - reported per file to the UI
            log.warning("glance failed for %s: %s", src, exc)
            with self._lock:
                self._errors[key] = str(exc)
        finally:
            with self._lock:
                self._inflight.discard(key)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
