"""Local media service: session manifest, slicing queue, waveform, export, media serving."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ffmpeg_bin
from .exporter import Exporter
from .models import Clip, Session
from .slicer import Slicer
from .waveform import extract_peaks
from .workspace import SIDECAR_FIELDS, Workspace, list_videos, source_key

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

REPO_ROOT = Path(__file__).resolve().parents[2]
ws = Workspace(Path(os.environ.get("PROMO_WORKSPACE", REPO_ROOT / "workspace")))
slicer = Slicer(ws)
exporter = Exporter(ws)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    slicer.shutdown()
    exporter.cancel()


app = FastAPI(title="promoEditor media service", lifespan=lifespan)


# --- health ------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "workspace": str(ws.root),
        "ffmpeg": ffmpeg_bin.ffmpeg_exe(),
        "ffprobe": ffmpeg_bin.ffprobe_exe(),
        "encoder": ffmpeg_bin.best_h264_encoder(),
    }


# --- session -----------------------------------------------------------------
@app.get("/api/session", response_model=Session)
def get_session():
    return ws.load()


@app.put("/api/session", response_model=Session)
def put_session(session: Session):
    return ws.save(session)


# --- folders / files -----------------------------------------------------------
class FolderReq(BaseModel):
    path: str


def _file_entry(p: Path) -> dict:
    return {"name": p.name, "path": ws.to_manifest_path(p), "size": p.stat().st_size}


@app.post("/api/folders")
def open_folder(req: FolderReq):
    folder = Path(req.path.strip().strip('"'))
    if not folder.is_dir():
        raise HTTPException(404, f"Not a folder: {folder}")
    session = ws.load()
    key = str(folder.resolve())
    if key not in session.source_folders:
        session.source_folders.append(key)
        ws.save(session)
    return {"folder": key, "files": [_file_entry(p) for p in list_videos(folder)]}


@app.post("/api/pick")
def pick(kind: Literal["folder", "audio", "image"] = Query("folder")):
    """Native file dialog on the machine running the server (it is always local)."""
    script = (
        "import sys, tkinter as tk\n"
        "from tkinter import filedialog as fd\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "k = sys.argv[1]\n"
        "if k == 'folder': p = fd.askdirectory(title='Choose a folder of raw clips')\n"
        "elif k == 'audio': p = fd.askopenfilename(title='Choose the music track', filetypes=[('Audio', "
        "'*.mp3 *.wav *.m4a *.aac *.flac *.ogg'), ('All files', '*.*')])\n"
        "else: p = fd.askopenfilename(title='Choose an overlay', filetypes=[('Images', '*.png *.webp'), "
        "('All files', '*.*')])\n"
        "print(p or '')\n"
    )
    res = subprocess.run([sys.executable, "-c", script, kind], capture_output=True, text=True, timeout=600)
    path = res.stdout.strip()
    return {"path": str(Path(path)) if path else None}


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


@app.post("/api/upload")
async def upload(files: list[UploadFile], kind: Literal["raw", "audio", "assets"] = Query("raw")):
    dest = ws.root / kind
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = _SAFE_NAME.sub("_", Path(f.filename or "upload").name)
        target = dest / name
        stem, suffix, i = target.stem, target.suffix, 1
        while target.exists():
            target = dest / f"{stem}_{i}{suffix}"
            i += 1
        with target.open("wb") as out:
            shutil.copyfileobj(f.file, out, length=8 * 1024 * 1024)
        saved.append(_file_entry(target))
    if kind == "raw":
        session = ws.load()
        key = str(dest.resolve())
        if key not in session.source_folders:
            session.source_folders.append(key)
            ws.save(session)
    return {"files": saved}


# --- clips -------------------------------------------------------------------
@app.post("/api/slice")
def slice_clip(clip: Clip):
    if not ws.resolve(clip.source_path).exists():
        raise HTTPException(404, f"Source not found: {clip.source_path}")
    if clip.out_sec <= clip.in_sec:
        raise HTTPException(400, "out_sec must be after in_sec")
    slicer.submit(clip)
    return {"clip_id": clip.clip_id, "proxy_status": "pending"}


@app.get("/api/clips/status")
def clip_status():
    """Slicer results per clip (only those matching the clip's current in/out)."""
    session = ws.load()
    out = {}
    for clip in session.clips:
        meta = ws.read_sidecar(clip.clip_id) or {}
        if meta.get("source_key") == source_key(clip):
            out[clip.clip_id] = {k: meta.get(k) for k in SIDECAR_FIELDS if k in meta}
    return out


@app.post("/api/clips/{clip_id}/thumb")
async def upload_thumb(clip_id: str, request: Request):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", clip_id):
        raise HTTPException(400, "bad clip id")
    target = ws.thumbs / f"{clip_id}.jpg"
    target.write_bytes(await request.body())
    return {"thumb_path": ws.to_manifest_path(target)}


@app.delete("/api/clips/{clip_id}/cache")
def delete_clip_cache(clip_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", clip_id):
        raise HTTPException(400, "bad clip id")
    ws.remove_clip_cache(clip_id)
    return {"ok": True}


# --- audio -------------------------------------------------------------------
@app.get("/api/waveform")
def waveform(path: str):
    p = ws.resolve(path)
    if not p.exists():
        raise HTTPException(404, f"Audio not found: {path}")
    try:
        return extract_peaks(p, ws.cache)
    except RuntimeError as exc:
        raise HTTPException(422, str(exc)) from exc


# --- export ------------------------------------------------------------------
@app.post("/api/export")
def start_export(session: Optional[Session] = None):
    session = ws.save(session) if session else ws.load()
    try:
        return exporter.start(session)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/export")
def export_status():
    return exporter.status


@app.post("/api/export/cancel")
def cancel_export():
    exporter.cancel()
    return exporter.status


# --- media -------------------------------------------------------------------
@app.get("/media")
def media(path: str):
    p = ws.resolve(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    if not ws.is_allowed(p):
        raise HTTPException(403, "path is outside the workspace and opened folders")
    # FileResponse handles Range requests, which <video> seeking relies on.
    return FileResponse(p, headers={"Cache-Control": "no-cache"})


_dist = REPO_ROOT / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
