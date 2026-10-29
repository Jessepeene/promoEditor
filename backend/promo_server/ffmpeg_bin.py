"""Locate usable ffmpeg/ffprobe binaries and probe media.

Resolution order for ffmpeg: $FFMPEG_PATH, a *full* build on PATH, then the
binary bundled with imageio-ffmpeg. Stub builds (e.g. audio-only builds that
some apps drop on PATH) are rejected by checking for an H.264 encoder.
"""

from __future__ import annotations

import functools
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(args: list[str], timeout: Optional[float] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, creationflags=_NO_WINDOW,
    )


def _encoders(exe: str) -> str:
    try:
        return run([exe, "-hide_banner", "-encoders"], timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _is_full_build(exe: str) -> bool:
    enc = _encoders(exe)
    return "libx264" in enc or "h264_nvenc" in enc


@functools.cache
def ffmpeg_exe() -> str:
    env = os.environ.get("FFMPEG_PATH")
    if env and Path(env).exists():
        return env
    on_path = shutil.which("ffmpeg")
    if on_path and _is_full_build(on_path):
        return on_path
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - depends on install
        raise RuntimeError(
            "No usable ffmpeg found. Set FFMPEG_PATH or `pip install imageio-ffmpeg`."
        ) from exc


@functools.cache
def ffprobe_exe() -> Optional[str]:
    env = os.environ.get("FFPROBE_PATH")
    if env and Path(env).exists():
        return env
    sibling = Path(ffmpeg_exe()).with_name("ffprobe" + Path(ffmpeg_exe()).suffix)
    if sibling.exists():
        return str(sibling)
    on_path = shutil.which("ffprobe")
    # Only trust a PATH ffprobe if the PATH ffmpeg next to it is a full build.
    if on_path and shutil.which("ffmpeg") == ffmpeg_exe():
        return on_path
    return None


@functools.cache
def best_h264_encoder() -> str:
    """Prefer NVENC, but only if it actually initialises on this machine."""
    exe = ffmpeg_exe()
    if os.environ.get("PROMO_DISABLE_NVENC") != "1" and "h264_nvenc" in _encoders(exe):
        probe = run(
            [exe, "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            timeout=20,
        )
        if probe.returncode == 0:
            return "h264_nvenc"
    return "libx264"


@dataclass
class ProbeResult:
    duration: Optional[float]
    start_time: float
    width: Optional[int]
    height: Optional[int]
    fps: Optional[float]
    has_audio: bool


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):([\d.]+),\s*start:\s*(-?[\d.]+)")
_VIDEO_RE = re.compile(r"Stream #\S+.*?Video:.*?(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"([\d.]+)\s*fps")


def probe(path: str) -> ProbeResult:
    probe_bin = ffprobe_exe()
    if probe_bin:
        out = run([probe_bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], 30)
        if out.returncode == 0:
            data = json.loads(out.stdout)
            fmt = data.get("format", {})
            video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
            fps = None
            if "/" in (video.get("avg_frame_rate") or ""):
                n, d = video["avg_frame_rate"].split("/")
                fps = float(n) / float(d) if float(d) else None
            return ProbeResult(
                duration=float(fmt["duration"]) if "duration" in fmt else None,
                start_time=float(fmt.get("start_time", 0.0)),
                width=video.get("width"),
                height=video.get("height"),
                fps=fps,
                has_audio=any(s.get("codec_type") == "audio" for s in data.get("streams", [])),
            )
    # Fallback: parse `ffmpeg -i` banner (it exits non-zero because no output is given).
    err = run([ffmpeg_exe(), "-hide_banner", "-i", path], 30).stderr
    dur = start = None
    if m := _DURATION_RE.search(err):
        h, mi, s, st = m.groups()
        dur, start = int(h) * 3600 + int(mi) * 60 + float(s), float(st)
    width = height = None
    fps = None
    for line in err.splitlines():
        if "Video:" in line:
            if vm := _VIDEO_RE.search(line):
                width, height = int(vm.group(1)), int(vm.group(2))
            if fm := _FPS_RE.search(line):
                fps = float(fm.group(1))
            break
    return ProbeResult(dur, start or 0.0, width, height, fps, "Audio:" in err)
