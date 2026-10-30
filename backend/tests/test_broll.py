import time

import pytest

from promo_server import ffmpeg_bin
from promo_server.broll import BrollPacker
from promo_server.models import Clip, Session
from promo_server.workspace import Workspace


def _src(path, color, seconds=6):
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s=640x360:r=30",
                          "-f", "lavfi", "-i", "sine=f=440", "-t", str(seconds), "-vf", f"drawbox=c={color}:t=20",
                          "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", str(path)])
    assert res.returncode == 0, res.stderr


def test_packs_only_range_clips_frame_accurately_with_reel(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _src(a, "red")
    _src(b, "blue")
    ws = Workspace(tmp_path / "ws")
    s = Session(resolution=(270, 480), fps=30, clips=[
        Clip(clip_id="c_001", source_path=str(a), mode="RANGE", in_sec=1.0, out_sec=3.0),
        Clip(clip_id="c_002", source_path=str(b), mode="RANGE", in_sec=2.5, out_sec=4.0),
        Clip(clip_id="c_003", source_path=str(a), mode="ANCHOR", in_sec=0, anchor_sec=1, out_sec=2, energy_tag=3),
    ])
    packer = BrollPacker()
    packer.start(ws, s)
    for _ in range(300):
        if packer.status["state"] != "running":
            break
        time.sleep(0.1)
    assert packer.status["state"] == "done", packer.status.get("error")
    folder = ws.resolve(packer.status["folder"])
    files = sorted(p.name for p in folder.glob("0*.mp4"))
    assert len(files) == 2  # the anchor clip isn't B-roll
    first = ffmpeg_bin.probe(str(folder / files[0]))
    assert first.duration == pytest.approx(2.0, abs=0.07) and first.has_audio and first.width == 640
    reel = ffmpeg_bin.probe(str(folder / "broll_reel.mp4"))
    assert (reel.width, reel.height) == (270, 480) and reel.duration == pytest.approx(3.5, abs=0.1)
    assert "c_002" in (folder / "index.txt").read_text()


def test_refuses_without_range_clips(tmp_path):
    with pytest.raises(ValueError):
        BrollPacker().start(Workspace(tmp_path / "ws"), Session())
