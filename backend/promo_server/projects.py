"""Named projects: each is its own workspace folder (session, .cache, exports).

    <root>/                     the "default" project (pre-projects workspaces keep working)
    <root>/projects/<id>/       every other project
    <root>/.current_project     id of the project that is open

Keeping projects in separate folders means clip ids, proxies and exports can never
collide between projects.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path

DEFAULT_ID = "default"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


def _projects_dir(root: Path) -> Path:
    return root / "projects"


def project_path(root: Path, project_id: str) -> Path:
    if project_id == DEFAULT_ID:
        return root
    if not _ID_RE.fullmatch(project_id):
        raise ValueError(f"invalid project id {project_id!r}")
    return _projects_dir(root) / project_id


def _meta_file(path: Path) -> Path:
    return path / "project.json"


def project_name(root: Path, project_id: str) -> str:
    meta = _meta_file(project_path(root, project_id))
    if meta.exists():
        return json.loads(meta.read_text(encoding="utf-8")).get("name") or project_id
    return "Default" if project_id == DEFAULT_ID else project_id


def list_projects(root: Path) -> list[dict]:
    ids = [DEFAULT_ID] + sorted(p.name for p in _projects_dir(root).glob("*") if p.is_dir() and _ID_RE.fullmatch(p.name))
    out = []
    for pid in ids:
        path = project_path(root, pid)
        session = path / "session.promo.json"
        clips = 0
        if session.exists():
            try:
                clips = len(json.loads(session.read_text(encoding="utf-8")).get("clips", []))
            except ValueError:
                clips = 0
        out.append({
            "id": pid,
            "name": project_name(root, pid),
            "clips": clips,
            "updated": datetime.fromtimestamp(session.stat().st_mtime).isoformat(timespec="seconds") if session.exists() else None,
        })
    return out


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
    return s or "project"


def create_project(root: Path, name: str, copy_from: Path | None = None) -> str:
    """New project folder (empty, or a copy of `copy_from` incl. its slices). Returns its id."""
    name = name.strip()
    if not name:
        raise ValueError("A project needs a name.")
    base = _slug(name)
    pid, n = base, 2
    while project_path(root, pid).exists() or pid == DEFAULT_ID:
        pid, n = f"{base}-{n}", n + 1
    dest = project_path(root, pid)
    if copy_from is not None:
        dest.mkdir(parents=True)
        for item in ("session.promo.json", ".cache", "raw", "audio", "assets"):
            src = copy_from / item
            if src.is_dir():
                shutil.copytree(src, dest / item, ignore=shutil.ignore_patterns("text", "*.tmp*"))
            elif src.is_file():
                shutil.copy2(src, dest / item)
    else:
        dest.mkdir(parents=True)
    _meta_file(dest).write_text(json.dumps({"name": name}), encoding="utf-8")
    return pid


def current_project(root: Path) -> str:
    marker = root / ".current_project"
    if marker.exists():
        pid = marker.read_text(encoding="utf-8").strip()
        try:
            if project_path(root, pid).is_dir():
                return pid
        except ValueError:
            pass
    return DEFAULT_ID


def set_current_project(root: Path, project_id: str) -> None:
    (root / ".current_project").write_text(project_id, encoding="utf-8")
