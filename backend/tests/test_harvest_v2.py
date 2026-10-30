from pathlib import Path

import numpy as np
import pytest

from promo_server import ffmpeg_bin
from promo_server import harvest_v2 as v2
from promo_server.harvest import Moment


def _run(args):
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", *args])
    assert res.returncode == 0, res.stderr


ENC = ["-c:v", "libx264", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p"]


@pytest.fixture(scope="module")
def media(tmp_path_factory) -> dict[str, str]:
    d: Path = tmp_path_factory.mktemp("harvest_v2")
    bg = d / "bg.png"
    _run(["-f", "lavfi", "-i", "testsrc2=s=1280x720", "-frames:v", "1", str(bg)])
    still_bg = ["-loop", "1", "-framerate", "30", "-i", str(bg)]
    out = {name: str(d / f"{name}.mp4") for name in ("subject", "shake", "cut", "calm")}
    # Locked-off camera, a red square darting around the top right between 3.0 and 3.6 s.
    _run([*still_bg, "-f", "lavfi", "-i", "color=red:s=120x120:r=30", "-filter_complex",
          "[0][1]overlay=x='1000+150*sin(t*9)':y='120+60*cos(t*7)':enable='between(t,3,3.6)',scale=640:360",
          "-t", "6", *ENC, out["subject"]])
    # Nothing moves in the scene; the camera shakes hard.
    _run([*still_bg, "-vf", "crop=640:360:x='300+40*sin(t*37)':y='150+30*sin(t*29)'", "-t", "6", *ENC, out["shake"]])
    # An edited source: a hard cut at 3.0 s.
    _run(["-f", "lavfi", "-i", "smptebars=s=640x360:r=30", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-filter_complex",
          "[0]trim=0:3,setpts=PTS-STARTPTS[a];[1]trim=0:3,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1",
          *ENC, out["cut"]])
    _run([*still_bg, "-vf", "scale=640:360", "-t", "10", *ENC, out["calm"]])
    return out


def test_shift_recovers_subpixel_camera_moves():
    img = np.random.default_rng(0).random((130, 200)).astype(np.float32)
    img = v2._box(img, 3)
    a, b = img[20:110, 20:180], img[17:107, 25:185]  # a[y, x] == b[y + 3, x - 5]
    dy, dx = v2._shift(a, b)
    assert dy == pytest.approx(-3, abs=0.05) and dx == pytest.approx(5, abs=0.05)
    pa, pb, _ = v2._aligned(a, b, dy, dx)
    assert np.abs(pa - pb).mean() < 0.01


def test_subject_motion_beats_camera_shake_and_sets_anchor_and_focus(media):
    subject = v2.refine_anchor(Moment(media["subject"], 3.0, 0, 0.3, 0.4, 6.0))
    shake = v2.refine_anchor(Moment(media["shake"], 3.0, 0, 0.3, 0.4, 6.0))
    assert subject and shake
    assert 3.0 <= subject.anchor <= 3.6  # the peak frame of the action, not the keyframe
    assert subject.focus[0] > 0.65 and subject.focus[1] < 0.35  # the square is top right
    assert shake.shake > 5 * max(subject.shake, 0.1)
    assert subject.score > 5 * shake.score


def test_clips_never_cross_a_hard_cut(media):
    after = v2.refine_anchor(Moment(media["cut"], 3.0, 0, 0.3, 0.4, 6.0))
    before = v2.refine_anchor(Moment(media["cut"], 2.4, 0, 0.3, 0.4, 6.0))
    assert after and after.in_sec >= 3.0 - 1 / 30 and after.anchor >= 3.0 + v2.CUT_MARGIN - 1 / 30
    assert before is None or before.out_sec <= 3.0 + 1e-6
    # No 4 s stretch without a cut near 3 s in a 6 s file → no breather from it.
    assert v2.refine_calm(Moment(media["cut"], 3.0, 0, 0.3, 0.4, 6.0)) is None
    calm = v2.refine_calm(Moment(media["calm"], 5.0, 0, 0.3, 0.4, 10.0))
    assert calm and calm.out_sec - calm.in_sec == pytest.approx(v2.BREATHER_LEN) and calm.action < 1


def test_quality_separates_sharp_from_blurred_and_upscaled(tmp_path):
    clips = {"sharp": ("1920x1080", ""), "blurred": ("1920x1080", "gblur=sigma=3"), "low_res": ("480x270", "")}
    q = {}
    for name, (size, vf) in clips.items():
        path = tmp_path / f"{name}.mp4"
        _run(["-f", "lavfi", "-i", f"testsrc2=s={size}:r=30", *(["-vf", vf] if vf else []), "-t", "1", *ENC, str(path)])
        q[name] = v2.quality_of(v2.still(str(path), 0.5, (0.5, 0.5)))
    assert q["sharp"] >= 0.8
    assert q["blurred"] < 0.5 and q["low_res"] < 0.5


def _shot(path, t, score, look, duration=60.0):
    return v2.Shot(path=path, anchor=t, in_sec=t - 2, out_sec=t + 2, action=score, shake=0, pan=0, contrast=0.5,
                   quality=1.0, focus=(0.5, 0.5), look=np.full(27, look), duration=duration)


def test_picks_per_file_scale_with_length():
    assert v2.picks_allowed(10) == 1 and v2.picks_allowed(60) == 2 and v2.picks_allowed(600) == v2.MAX_PICKS_PER_FILE


def test_pick_diverse_prefers_new_looks_and_files_and_never_overlaps():
    shots = [
        _shot("a", 10, 1.00, 0.8),
        _shot("b", 10, 0.95, 0.8),  # same look as a
        _shot("c", 10, 0.70, 0.2),  # different look, lower score
        _shot("a", 11, 0.99, 0.5),  # overlaps a@10
        _shot("a", 30, 0.98, 0.5),
        _shot("short", 5, 0.97, 0.1, duration=10.0),
        _shot("short", 9, 0.96, 0.9, duration=10.0),  # a 10 s file allows one pick
    ]
    chosen = v2.pick_diverse(shots, 3, lambda s: s.action)
    keys = [(s.path, s.anchor) for s in chosen]
    assert keys[0] == ("a", 10)
    assert ("a", 11) not in keys
    assert sum(1 for p, _ in keys if p == "short") <= 1
    assert ("c", 10) in keys and ("b", 10) not in keys  # a new look beats a near-copy of the first pick


def test_pick_diverse_tops_up_from_extra_moments_when_files_run_out():
    shots = [_shot("a", t, 1.0 - t / 100, t / 60, duration=20.0) for t in (5, 10, 15)] + [_shot("b", 8, 0.5, 0.9, duration=20.0)]
    chosen = v2.pick_diverse(shots, 10, lambda s: s.action)
    assert v2.picks_allowed(20.0) == 1
    assert {(s.path, s.anchor) for s in chosen} == {("a", 5), ("a", 10), ("a", 15), ("b", 8)}
    assert [s.path for s in chosen[:2]] == ["a", "b"]  # every file once before any repeats
