"""Local media service: session manifest, slicing queue, waveform, export, media serving."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import ffmpeg_bin, harvest, harvest_v2, projects
from .exporter import Exporter
from .glance import GlanceQueue
from .broll import BrollPacker
from .dupes import DupeScanner
from .harvest import Harvester
from .models import Clip, Session, TextTrack
from .slicer import Slicer
from .waveform import extract_peaks
from .workspace import SIDECAR_FIELDS, Workspace, list_videos, source_key

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get("PROMO_WORKSPACE", REPO_ROOT / "workspace")).resolve()
harvester = Harvester()
dupe_scanner = DupeScanner()
broll_packer = BrollPacker()

# Per-project services; rebound by _activate when another project is opened.
ws: Workspace
slicer: Slicer
exporter: Exporter
glances: GlanceQueue


def _activate(project_id: str) -> None:
    global ws, slicer, exporter, glances
    previous = (slicer, glances) if "slicer" in globals() else None
    ws = Workspace(projects.project_path(ROOT, project_id))
    slicer, exporter, glances = Slicer(ws), Exporter(ws), GlanceQueue(ws.cache)
    projects.set_current_project(ROOT, project_id)
    if previous:
        # Jobs already running finish into the old project's folder; queued ones are dropped.
        for service in previous:
            service.shutdown()


ROOT.mkdir(parents=True, exist_ok=True)
_activate(projects.current_project(ROOT))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    slicer.shutdown()
    glances.shutdown()
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


# --- projects ------------------------------------------------------------------
@app.get("/api/projects")
def list_projects():
    return {"current": projects.current_project(ROOT), "projects": projects.list_projects(ROOT)}


class ProjectReq(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    # Save as: copy the open project (session, slices, uploads) into the new one.
    copy_current: bool = False


def _ensure_idle() -> None:
    if exporter.busy:
        raise HTTPException(409, "An export is running in this project; wait for it or cancel it first.")


@app.post("/api/projects")
def create_project(req: ProjectReq):
    _ensure_idle()
    try:
        pid = projects.create_project(ROOT, req.name, copy_from=ws.root if req.copy_current else None)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _activate(pid)
    return list_projects()


@app.post("/api/projects/{project_id}/open")
def open_project(project_id: str):
    _ensure_idle()
    try:
        path = projects.project_path(ROOT, project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not path.is_dir():
        raise HTTPException(404, f"No project {project_id}")
    _activate(project_id)
    return list_projects()


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
            if meta.get("proxy_status") == "ready" and "color_tag" not in meta:
                slicer.ensure_color(clip)  # clips sliced before colour tagging existed
    return out


@app.post("/api/clips/{clip_id}/thumb")
async def upload_thumb(clip_id: str, request: Request):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", clip_id):
        raise HTTPException(400, "bad clip id")
    target = ws.thumbs / f"{clip_id}.jpg"
    target.write_bytes(await request.body())
    return {"thumb_path": ws.to_manifest_path(target)}


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


# --- bulk culling ----------------------------------------------------------------
class PathsReq(BaseModel):
    paths: list[str] = Field(max_length=500)


def _allowed_video(path: str) -> Path:
    p = ws.resolve(path)
    if not p.is_file():
        raise HTTPException(404, f"not found: {path}")
    if not ws.is_allowed(p):
        raise HTTPException(403, f"not in an opened folder: {path}")
    return p


@app.post("/api/glance")
def glance(req: PathsReq):
    """Status of each file's glance clip; missing ones are queued in request order."""
    out = {}
    for path in req.paths:
        st = glances.status(_allowed_video(path))
        if st["status"] == "ready":
            st["glance_path"] = ws.to_manifest_path(Path(st["glance_path"]))
        out[path] = st
    return out


class HarvestReq(PathsReq):
    count: int = Field(35, ge=0, le=200)  # 0 = only breathers (a B-roll harvest)
    breathers: int = Field(3, ge=0, le=200)
    version: Literal[1, 2] = 2


@app.post("/api/auto-harvest")
def start_harvest(req: HarvestReq):
    paths = [str(_allowed_video(p)) for p in req.paths]

    def selector(moments, progress):
        if req.version == 1:
            return harvest.select(moments, req.count, req.breathers)
        return harvest_v2.select(moments, req.count, req.breathers, progress)

    try:
        return harvester.start(paths, selector)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/auto-harvest")
def harvest_status():
    return harvester.status


@app.post("/api/broll-pack")
def start_broll_pack():
    try:
        return broll_packer.start(ws, ws.load())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/broll-pack")
def broll_pack_status():
    return broll_packer.status


@app.post("/api/dupes")
def start_dupe_scan(req: PathsReq):
    paths = [str(_allowed_video(p)) for p in req.paths]
    try:
        status = dict(dupe_scanner.start(paths))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    return status


@app.get("/api/dupes")
def dupe_status():
    status = dict(dupe_scanner.status)
    # Report paths the way the client sent them (manifest form), not resolved OS paths.
    if status.get("groups"):
        status["groups"] = [[ws.to_manifest_path(Path(p)) for p in g] for g in status["groups"]]
    return status


# --- export ------------------------------------------------------------------
def _text_dir() -> Path:
    return ws.cache / "text"


@app.post("/api/text-track")
async def upload_text_track(files: list[UploadFile], manifest: str = Form(...)):
    """Store the browser-rendered text layer: PNGs plus the frame spans they cover."""
    try:
        track = TextTrack.model_validate_json(manifest)
    except ValidationError as exc:
        raise HTTPException(422, f"bad text manifest: {exc}") from exc
    names = {f.filename for f in files}
    missing = {s.file for s in track.spans} - names
    if missing:
        raise HTTPException(422, f"missing text frames: {sorted(missing)[:5]}")
    track_id = uuid.uuid4().hex
    folder = _text_dir() / track_id
    folder.mkdir(parents=True)
    wanted = {s.file for s in track.spans}
    for f in files:
        if f.filename in wanted:  # names were validated by the TextSpan pattern
            data = await f.read()
            if not data.startswith(b"\x89PNG"):
                raise HTTPException(422, f"{f.filename} is not a PNG")
            (folder / f.filename).write_bytes(data)
    (folder / "track.json").write_text(track.model_dump_json(), encoding="utf-8")
    return {"text_track_id": track_id}


class ExportReq(BaseModel):
    session: Session
    text_track_id: Optional[str] = Field(None, pattern=r"^[0-9a-f]{32}$")


@app.post("/api/export")
def start_export(req: ExportReq):
    session = ws.save(req.session)
    text = None
    if req.text_track_id:
        folder = _text_dir() / req.text_track_id
        if not (folder / "track.json").exists():
            raise HTTPException(404, "text track not found; export again")
        text = (TextTrack.model_validate_json((folder / "track.json").read_text(encoding="utf-8")), folder)
    try:
        return exporter.start(session, text)
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


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def unknown_api(path: str):
    # Without this, unknown API calls fall through to the static mount below and come back
    # as a bare 405, which is what an out-of-date backend looks like to a newer frontend.
    raise HTTPException(404, f"Unknown API endpoint /api/{path}. If the app was just updated, restart the backend.")


_dist = REPO_ROOT / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
