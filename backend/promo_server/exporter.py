"""Runs an ExportPlan in the background and tracks progress."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

from . import ffmpeg_bin
from .compiler import describe, plan_export
from .models import Session
from .workspace import Workspace

log = logging.getLogger(__name__)


class ExportCancelled(Exception):
    pass


class Exporter:
    def __init__(self, ws: Workspace):
        self.ws = ws
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._cancel = threading.Event()
        self._procs: set[subprocess.Popen] = set()
        self.status: dict = {"state": "idle"}

    def _set(self, **kw) -> None:
        with self._lock:
            self.status = {**self.status, **kw}

    def start(self, session: Session) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise RuntimeError("An export is already running.")
            self._cancel.clear()
            stamp = time.strftime("%Y%m%d_%H%M%S")
            output = self.ws.exports / f"promo_{stamp}.mp4"
            self.status = {"state": "planning", "progress": 0.0, "output": None, "error": None,
                           "message": "Compiling filtergraph", "started": time.time()}
            self._thread = threading.Thread(target=self._run, args=(session, output), daemon=True)
            self._thread.start()
            return self.status

    def cancel(self) -> None:
        self._cancel.set()
        for p in list(self._procs):
            p.kill()

    def _exec(self, args: list[str]) -> None:
        if self._cancel.is_set():
            raise ExportCancelled()
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self._procs.add(proc)
        try:
            _, err = proc.communicate()
        finally:
            self._procs.discard(proc)
        if self._cancel.is_set():
            raise ExportCancelled()
        if proc.returncode != 0:
            raise RuntimeError(err.strip()[-1500:] or f"ffmpeg exited with {proc.returncode}")

    def _run(self, session: Session, output: Path) -> None:
        work = self.ws.exports / f".work_{output.stem}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            plan = plan_export(session, self.ws, work, output)
            output.with_suffix(".commands.txt").write_text(describe(plan), encoding="utf-8")
            n = len(plan.segments)
            self._set(state="rendering", message=f"Rendering {n} segments", segments=n, segments_done=0)
            workers = max(1, min(4, (os.cpu_count() or 4) // 4))
            done = 0
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(self._exec, seg.args) for seg in plan.segments]
                for fut in as_completed(futures):
                    fut.result()
                    done += 1
                    self._set(segments_done=done, progress=0.85 * done / n)
            self._set(state="finalizing", message=f"Encoding with {ffmpeg_bin.best_h264_encoder()}", progress=0.86)
            self._exec(plan.final_args)
            self._set(state="done", progress=1.0, message="Export complete",
                      output=self.ws.to_manifest_path(output), finished=time.time())
        except ExportCancelled:
            output.unlink(missing_ok=True)
            self._set(state="cancelled", message="Export cancelled")
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            log.exception("export failed")
            self._set(state="error", error=str(exc), message="Export failed")
        finally:
            if os.environ.get("PROMO_KEEP_SEGMENTS") != "1":
                shutil.rmtree(work, ignore_errors=True)
