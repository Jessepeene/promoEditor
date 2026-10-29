"""Background slicing queue.

Stage 1 (fast pool): lossless `-c copy` slice -> .cache/{clip_id}.mp4. Stream copy
starts at the keyframe at or before in_sec, so we record that keyframe's source
time as `proxy_start_sec`; every consumer maps source time -> proxy time with it.

Stage 2 (single low-priority worker): small short-GOP H.264 preview for the
canvas compositor, plus a thumbnail if the UI didn't upload one.
"""

from __future__ import annotations

import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from . import ffmpeg_bin
from .models import Clip
from .workspace import Workspace, source_key

log = logging.getLogger(__name__)

_TB_RE = re.compile(r"^#tb 0: (\d+)/(\d+)", re.M)
PREVIEW_MAX_DIM = 960


def keyframe_at_or_before(src: str, t: float) -> Optional[float]:
    """Source time of the keyframe a stream-copy seek to `t` lands on."""
    out = ffmpeg_bin.run(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-ss", f"{t:.6f}", "-i", src, "-map", "0:v:0",
         "-c", "copy", "-copyts", "-frames:v", "1", "-f", "framecrc", "-"],
        timeout=30,
    )
    tb = _TB_RE.search(out.stdout)
    for line in out.stdout.splitlines():
        if line and not line.startswith("#") and tb:
            pts = int(line.split(",")[2].strip())
            return pts * int(tb.group(1)) / int(tb.group(2))
    return None


class Slicer:
    def __init__(self, ws: Workspace):
        self.ws = ws
        self._fast = ThreadPoolExecutor(max_workers=2, thread_name_prefix="slice")
        self._slow = ThreadPoolExecutor(max_workers=1, thread_name_prefix="preview")
        self._lock = threading.Lock()
        self._latest: dict[str, str] = {}  # clip_id -> source_key of the newest request

    def submit(self, clip: Clip) -> None:
        key = source_key(clip)
        with self._lock:
            self._latest[clip.clip_id] = key
        self.ws.write_sidecar(clip.clip_id, {"source_key": key, "proxy_status": "pending", "proxy_error": None})
        self._fast.submit(self._slice, clip, key)

    def _stale(self, clip_id: str, key: str) -> bool:
        with self._lock:
            return self._latest.get(clip_id) != key

    def _slice(self, clip: Clip, key: str) -> None:
        if self._stale(clip.clip_id, key):
            return
        self.ws.write_sidecar(clip.clip_id, {"proxy_status": "slicing"})
        try:
            src = str(self.ws.resolve(clip.source_path))
            info = ffmpeg_bin.probe(src)
            kf = keyframe_at_or_before(src, clip.in_sec)
            out = self.ws.cache / f"{clip.clip_id}.mp4"
            tmp = out.with_name(f"{clip.clip_id}.{abs(hash(key)) % 10**8}.tmp.mp4")
            # Audio is dropped: the music track drives the promo, and an audio stream
            # starting before the video keyframe would shift the proxy's t=0.
            res = ffmpeg_bin.run(
                [ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-ss", f"{clip.in_sec:.6f}",
                 "-to", f"{clip.out_sec:.6f}", "-i", src, "-map", "0:v:0", "-an", "-c", "copy",
                 "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(tmp)],
                timeout=120,
            )
            if res.returncode != 0 or not tmp.exists():
                raise RuntimeError(res.stderr.strip()[-500:] or "ffmpeg slice failed")
            if self._stale(clip.clip_id, key):
                tmp.unlink(missing_ok=True)
                return
            tmp.replace(out)
            start = (kf - info.start_time) if kf is not None else clip.in_sec
            self.ws.write_sidecar(clip.clip_id, {
                "proxy_path": self.ws.to_manifest_path(out),
                "proxy_start_sec": round(max(start, 0.0), 6),
                "proxy_status": "ready",
                "source_duration_sec": info.duration,
            })
            self._slow.submit(self._finish, clip, key, max(start, 0.0))
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            log.exception("slice failed for %s", clip.clip_id)
            self.ws.write_sidecar(clip.clip_id, {"proxy_status": "error", "proxy_error": str(exc)})

    def _finish(self, clip: Clip, key: str, proxy_start: float) -> None:
        if self._stale(clip.clip_id, key):
            return
        proxy = self.ws.cache / f"{clip.clip_id}.mp4"
        thumb = self.ws.thumbs / f"{clip.clip_id}.jpg"
        exe = ffmpeg_bin.ffmpeg_exe()
        if not thumb.exists():
            at = max((clip.anchor_sec if clip.anchor_sec is not None else clip.in_sec) - proxy_start, 0.0)
            ffmpeg_bin.run([exe, "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", str(proxy), "-frames:v", "1",
                            "-vf", "scale=320:-2", "-q:v", "4", str(thumb)], timeout=30)
            if thumb.exists():
                self.ws.write_sidecar(clip.clip_id, {"thumb_path": self.ws.to_manifest_path(thumb)})

        preview = self.ws.cache / f"{clip.clip_id}.preview.mp4"
        tmp = preview.with_suffix(".tmp.mp4")
        d = PREVIEW_MAX_DIM
        res = ffmpeg_bin.run(
            [exe, "-y", "-v", "error", "-i", str(proxy), "-an",
             # PTS-STARTPTS: the copy-sliced proxy can carry a B-frame start offset;
             # the preview's t=0 must be the proxy's first frame (= proxy_start_sec).
             "-vf", f"setpts=PTS-STARTPTS,scale='if(gt(iw,ih),min({d},iw),-2)':'if(gt(iw,ih),-2,min({d},ih))',"
                    "format=yuv420p",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "6", "-bf", "0",
             "-movflags", "+faststart", str(tmp)],
            timeout=600,
        )
        if res.returncode == 0 and tmp.exists() and not self._stale(clip.clip_id, key):
            tmp.replace(preview)
            self.ws.write_sidecar(clip.clip_id, {"preview_path": self.ws.to_manifest_path(preview)})
        else:
            tmp.unlink(missing_ok=True)
            if res.returncode != 0:
                log.warning("preview transcode failed for %s: %s", clip.clip_id, res.stderr[-300:])

    def shutdown(self) -> None:
        self._fast.shutdown(wait=False, cancel_futures=True)
        self._slow.shutdown(wait=False, cancel_futures=True)
