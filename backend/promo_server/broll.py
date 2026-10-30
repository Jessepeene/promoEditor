"""B-roll pack: every breather (range) clip of a project, delivered as files.

    exports/broll_<stamp>/
      01_<source>_<in>-<out>.mp4   frame-accurate cut from the original, native size, with audio
      ...
      broll_reel.mp4               all clips in a row, cover-cropped to the project size, no audio
      index.txt                    which source and time range each file came from
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Optional

from . import ffmpeg_bin
from .compiler import _num
from .models import Clip, Session
from .workspace import Workspace

log = logging.getLogger(__name__)


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name)[:40]


class BrollPacker:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self.status: dict = {"state": "idle"}

    def start(self, ws: Workspace, session: Session) -> dict:
        clips = [c for c in session.clips if c.mode == "RANGE"]
        if not clips:
            raise ValueError("No range (breather) clips to pack: hold 0 in the logger or harvest B-roll first.")
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise RuntimeError("A B-roll pack is already being made.")
            folder = ws.exports / f"broll_{time.strftime('%Y%m%d_%H%M%S')}"
            self.status = {"state": "running", "done": 0, "total": len(clips) + 1, "folder": None, "error": None}
            self._thread = threading.Thread(target=self._run, args=(ws, session, clips, folder), daemon=True)
            self._thread.start()
            return self.status

    def _step(self) -> None:
        with self._lock:
            self.status["done"] += 1

    def _run(self, ws: Workspace, session: Session, clips: list[Clip], folder: Path) -> None:
        try:
            folder.mkdir(parents=True)
            exe = ffmpeg_bin.ffmpeg_exe()
            W, H = session.resolution
            index, parts = [], []
            for i, clip in enumerate(clips, start=1):
                src = ws.resolve(clip.source_path)
                name = f"{i:02d}_{_safe(src.stem)}_{clip.in_sec:.1f}-{clip.out_sec:.1f}.mp4"
                dur = clip.out_sec - clip.in_sec
                # Input seek + re-encode is frame-accurate (a stream copy would snap to keyframes).
                res = ffmpeg_bin.run([exe, "-y", "-v", "error", "-ss", _num(clip.in_sec), "-i", str(src), "-t", _num(dur),
                                      "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-crf", "17", "-preset", "medium",
                                      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
                                      str(folder / name)], timeout=600)
                if res.returncode != 0:
                    raise RuntimeError(f"{name}: {res.stderr.strip()[-300:]}")
                index.append(f"{name}\t{clip.source_path}\t{clip.in_sec:.3f}-{clip.out_sec:.3f}s\t{clip.clip_id}")
                parts.append((folder / name, clip))
                self._step()
            # The reel: every clip cover-cropped around its focus point to the project frame.
            args = [exe, "-y", "-v", "error"]
            for path, _ in parts:
                args += ["-i", str(path)]
            chains = []
            for k, (_, clip) in enumerate(parts):
                fx, fy = clip.focus_xy
                chains.append(f"[{k}:v]scale={W}:{H}:force_original_aspect_ratio=increase,"
                              f"crop={W}:{H}:'min(max({_num(fx)}*iw-ow/2,0),iw-ow)':'min(max({_num(fy)}*ih-oh/2,0),ih-oh)',"
                              f"setsar=1,fps={session.fps},format=yuv420p[v{k}]")
            graph = ";".join(chains) + ";" + "".join(f"[v{k}]" for k in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0[out]"
            res = ffmpeg_bin.run(args + ["-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "18",
                                         "-preset", "medium", "-movflags", "+faststart", str(folder / "broll_reel.mp4")],
                                 timeout=1800)
            if res.returncode != 0:
                raise RuntimeError(f"reel: {res.stderr.strip()[-300:]}")
            (folder / "index.txt").write_text("file\tsource\trange\tclip\n" + "\n".join(index) + "\n", encoding="utf-8")
            self._step()
            with self._lock:
                self.status.update(state="done", folder=ws.to_manifest_path(folder), reel=ws.to_manifest_path(folder / "broll_reel.mp4"))
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            log.exception("B-roll pack failed")
            with self._lock:
                self.status.update(state="error", error=str(exc))
