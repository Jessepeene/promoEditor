from pathlib import Path

import pytest

from promo_server import ffmpeg_bin
from promo_server.harvest import Moment, analyse, select


def m(path, t, motion, contrast=0.3, level=0.4, duration=20.0):
    return Moment(path, t, motion, contrast, level, duration)


def test_select_spreads_across_files_and_tags_by_motion():
    pool = [[m(f"f{i}", 5 + j, motion=i * 0.1 + j * 0.01) for j in range(3)] for i in range(10)]
    clips = [c for c in select(pool, count=6, breathers=0)]
    assert len(clips) == 6
    assert len({c["source_path"] for c in clips}) == 6  # one per file
    # The six highest-motion files win; tags follow motion quartiles (4 = peak).
    assert {c["source_path"] for c in clips} == {f"f{i}" for i in range(4, 10)}
    by_tag = {c["source_path"]: c["energy_tag"] for c in clips}
    assert by_tag["f9"] == 4 and by_tag["f4"] == 1
    for c in clips:
        assert c["in_sec"] == pytest.approx(c["anchor_sec"] - 2) and c["out_sec"] == pytest.approx(c["anchor_sec"] + 2)


def test_select_takes_spaced_second_picks_when_files_run_out():
    pool = [[m("a", 3, 0.9), m("a", 5, 0.8), m("a", 10, 0.5)], [m("b", 6, 0.4)]]
    clips = select(pool, count=3, breathers=0)
    times = sorted(c["anchor_sec"] for c in clips if c["source_path"] == "a")
    assert times == [3, 10]  # 5 is too close to the first pick


def test_breathers_come_from_unused_calm_files():
    pool = [[m("busy", 5, 0.9)], [m("calm", 6, 0.01)], [m("short", 1, 0.0, duration=3.0)]]
    clips = select(pool, count=1, breathers=2)
    rng = [c for c in clips if c["mode"] == "RANGE"]
    assert [c["source_path"] for c in rng] == ["calm"]  # "short" can't fit a 4s breather
    assert rng[0]["energy_tag"] == 0 and rng[0]["out_sec"] - rng[0]["in_sec"] == pytest.approx(4.0)


def _make(path: Path, src: str, seconds: float):
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-i", src, "-t", str(seconds),
                          "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", str(path)])
    assert res.returncode == 0, res.stderr


def test_analyse_rejects_black_and_short_files_and_skips_edges(tmp_path):
    black, short, moving = tmp_path / "black.mp4", tmp_path / "short.mp4", tmp_path / "moving.mp4"
    _make(black, "color=c=black:s=320x180:r=30", 6)
    _make(short, "testsrc2=s=320x180:r=30", 1)
    _make(moving, "testsrc2=s=320x180:r=30", 10)
    assert analyse(str(black)) == []
    assert analyse(str(short)) == []
    moments = analyse(str(moving))
    assert moments, "a moving, contrasty clip should yield candidates"
    assert all(1.0 <= mo.t <= 9.0 for mo in moments)  # first/last 10% ignored
    assert all(mo.motion > 0 for mo in moments)
