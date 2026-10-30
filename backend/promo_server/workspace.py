"""Workspace layout and session persistence.

    <workspace>/
      session.promo.json
      .cache/            c_001.mp4 (lossless slice), c_001.preview.mp4, c_001.json (sidecar)
      .cache/thumbs/     c_001.jpg
      raw/ audio/ assets/  files uploaded via drag & drop
      exports/

Paths inside the manifest that start with "/" and exist under the workspace
(e.g. "/.cache/c_001.mp4") are workspace-relative; anything else is an OS path.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Optional

from .models import Session

SIDECAR_FIELDS = ("proxy_path", "proxy_start_sec", "proxy_status", "proxy_error", "preview_path", "thumb_path",
                  "source_duration_sec", "color_tag", "color_rgb")
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.cache = self.root / ".cache"
        self.thumbs = self.cache / "thumbs"
        self.exports = self.root / "exports"
        for d in (self.root, self.cache, self.thumbs, self.exports):
            d.mkdir(parents=True, exist_ok=True)
        self.session_file = self.root / "session.promo.json"
        self._lock = threading.RLock()

    # --- paths -----------------------------------------------------------
    def resolve(self, p: str) -> Path:
        if p.startswith("/") and not p.startswith("//"):
            candidate = self.root / p.lstrip("/")
            if candidate.exists() or p.lstrip("/").split("/")[0] in (".cache", "raw", "audio", "assets", "exports"):
                return candidate
        return Path(p)

    def to_manifest_path(self, p: Path) -> str:
        p = p.resolve()
        try:
            return "/" + p.relative_to(self.root).as_posix()
        except ValueError:
            return str(p)

    def is_allowed(self, p: Path) -> bool:
        """Only serve files under the workspace or folders/files the session references."""
        p = p.resolve()
        roots = [self.root]
        with self._lock:
            session = self.load()
        roots += [Path(f) for f in session.source_folders]
        refs = [c.source_path for c in session.clips]
        refs += [session.sequence.audio_path or ""] + [logo.path for logo in session.sequence.style.logos]
        for r in roots:
            try:
                p.relative_to(r.resolve())
                return True
            except ValueError:
                pass
        return any(r and self.resolve(r).resolve() == p for r in refs)

    # --- session ---------------------------------------------------------
    def load(self) -> Session:
        with self._lock:
            if not self.session_file.exists():
                session = Session()
                self._write(session)
                return session
            session = Session.model_validate_json(self.session_file.read_text(encoding="utf-8"))
            return self._merge_sidecars(session)

    def save(self, session: Session) -> Session:
        with self._lock:
            session = self._merge_sidecars(session)
            self._write(session)
            return session

    def _write(self, session: Session) -> None:
        tmp = self.session_file.with_suffix(".json.tmp")
        tmp.write_text(session.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, self.session_file)

    def _merge_sidecars(self, session: Session) -> Session:
        """The slicer writes results to sidecars so it never races the UI for the manifest."""
        for clip in session.clips:
            meta = self.read_sidecar(clip.clip_id)
            if meta and meta.get("source_key") == source_key(clip):
                for k in SIDECAR_FIELDS:
                    if k in meta:
                        setattr(clip, k, meta[k])
        return session

    # --- sidecars --------------------------------------------------------
    def sidecar_path(self, clip_id: str) -> Path:
        return self.cache / f"{clip_id}.json"

    def read_sidecar(self, clip_id: str) -> Optional[dict]:
        path = self.sidecar_path(clip_id)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def write_sidecar(self, clip_id: str, meta: dict) -> None:
        with self._lock:
            current = self.read_sidecar(clip_id) or {}
            current.update(meta)
            tmp = self.sidecar_path(clip_id).with_suffix(".json.tmp")
            tmp.write_text(json.dumps(current, indent=2), encoding="utf-8")
            os.replace(tmp, self.sidecar_path(clip_id))


def source_key(clip) -> str:
    """Identifies the slice a sidecar belongs to, so stale results are ignored after an edit."""
    return f"{clip.source_path}|{clip.in_sec:.4f}|{clip.out_sec:.4f}"


def list_videos(folder: Path) -> list[Path]:
    import re

    def natural(p: Path):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]

    return sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTS), key=natural)
