import numpy as np
import pytest
from pydantic import ValidationError

from promo_server import ffmpeg_bin
from promo_server.color import classify
from promo_server.dupes import Signature, group, is_duplicate, signature
from promo_server.models import Clip, Session


# --- energy tiers -------------------------------------------------------------

def test_old_sessions_migrate_breathers_to_tier_0():
    old = {"clips": [
        {"clip_id": "a", "source_path": "x", "mode": "RANGE", "in_sec": 1, "out_sec": 5, "energy_tag": 4},
        {"clip_id": "b", "source_path": "x", "mode": "ANCHOR", "in_sec": 1, "anchor_sec": 3, "out_sec": 5, "energy_tag": 3},
    ]}
    s = Session.model_validate(old)
    assert [c.energy_tag for c in s.clips] == [0, 3]


def test_old_overlay_becomes_a_logo_and_new_layouts_start_off():
    s = Session.model_validate({"sequence": {"style": {
        "overlay": {"path": "/assets/logo.png", "motion": "JITTER", "width_frac": 0.5},
        "layout_weights": {"FULLSCREEN_VELOCITY": 1.0}}}})
    [logo] = s.sequence.style.logos
    assert (logo.path, logo.placement, logo.motion, logo.width_frac) == ("/assets/logo.png", "CENTER", "JITTER", 0.5)
    assert s.sequence.style.layout_weights["SPLIT_2"] == 0.0
    assert Session.model_validate({"sequence": {"style": {"overlay": {"path": None}}}}).sequence.style.logos == []


def test_tier_0_is_only_for_breathers():
    with pytest.raises(ValidationError):
        Clip(clip_id="a", source_path="x", mode="ANCHOR", in_sec=1, anchor_sec=2, out_sec=3, energy_tag=0)
    with pytest.raises(ValidationError):
        Clip(clip_id="a", source_path="x", mode="ANCHOR", in_sec=1, anchor_sec=2, out_sec=3, energy_tag=5)


# --- colour -----------------------------------------------------------------------

def frame(rgb, noise=0):
    rng = np.random.default_rng(0)
    f = np.full((18, 32, 3), rgb, np.float32) + rng.normal(0, noise, (18, 32, 3))
    return np.clip(f, 0, 255).astype(np.uint8)


@pytest.mark.parametrize("rgb, tag", [
    ((10, 10, 14), "dark_ambient"),
    ((200, 200, 205), "neutral"),
    ((230, 30, 40), "red"),
    ((30, 60, 230), "blue"),
    ((40, 200, 60), "green"),
    ((200, 40, 220), "magenta"),
    ((240, 140, 20), "orange"),
])
def test_classify_solid_looks(rgb, tag):
    assert classify(frame(rgb, noise=6))[0] == tag


def test_vivid_lights_decide_over_a_dark_room():
    # A mostly dim frame with a bright blue strobe band: the band sets the hue.
    f = frame((25, 25, 30))
    f[:, :12] = (40, 80, 255)
    assert classify(f)[0] == "blue"


# --- duplicates ---------------------------------------------------------------

def sig(path, duration=10.0, hashes=(1, 2, 3), size=100, head="h"):
    return Signature(path, size, f"{head}{path}", duration, list(hashes))


def test_visual_duplicates_need_two_matching_detailed_frames():
    a = sig("a", hashes=(0b1011, 0xFF00, 0xF0F0))
    assert is_duplicate(a, sig("b", hashes=(0b1011, 0xFF01, 0xF0F0)))  # 1 bit off is a match
    assert not is_duplicate(a, sig("c", hashes=(0b1011, 0xFF00, 0x0F0F)))  # one frame differs
    assert not is_duplicate(a, sig("d", duration=14.0, hashes=(0b1011, 0xFF00, 0xF0F0)))  # different length
    # Blank samples (None) never make files equal: pocket shots must not group together.
    assert not is_duplicate(sig("e", hashes=(None, None, 5)), sig("f", hashes=(None, None, 5)))


def test_exact_copies_match_even_without_frames():
    a = Signature("a", 500, "same", None, [None, None, None])
    b = Signature("b", 500, "same", None, [None, None, None])
    assert is_duplicate(a, b)


def test_group_keeps_first_in_input_order():
    far = 0xFFFF_FFFF_FFFF  # 48 bits away from the others' hashes
    sigs = [sig("x", hashes=(far, far, far)), sig("a", hashes=(1, 2, 3)), sig("b", hashes=(1, 2, 3)), sig("c", hashes=(1, 2, 3))]
    assert group(sigs) == [["a", "b", "c"]]


def _make(path, src, seconds, extra=()):
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-i", src, "-t", str(seconds),
                          *extra, "-pix_fmt", "yuv420p", str(path)])
    assert res.returncode == 0, res.stderr


def test_real_files_reencode_matches_but_different_content_and_black_dont(tmp_path):
    a, b, c = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "c.mp4"
    k1, k2 = tmp_path / "k1.mp4", tmp_path / "k2.mp4"
    _make(a, "testsrc2=s=320x180:r=30", 6, ["-c:v", "libx264", "-crf", "18"])
    # Same footage re-encoded at another quality and size: a near-duplicate.
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-i", str(a), "-vf", "scale=256:144",
                          "-c:v", "libx264", "-crf", "35", str(b)])
    assert res.returncode == 0
    _make(c, "mandelbrot=s=320x180:r=30", 6, ["-c:v", "libx264"])
    _make(k1, "color=c=black:s=320x180:r=30", 6, ["-c:v", "libx264"])
    _make(k2, "color=c=black:s=320x180:r=30", 6, ["-c:v", "libx264", "-crf", "40"])
    sigs = [signature(str(p)) for p in (a, b, c, k1, k2)]
    assert group(sigs) == [[str(a), str(b)]]


def test_colour_of_a_clip_tagged_on_the_last_frame(tmp_path):
    """Regression: the anchor sat on the file's final frame, so colour analysis seeked past the end."""
    from promo_server.models import Clip
    from promo_server.slicer import Slicer
    from promo_server.workspace import Workspace

    src = tmp_path / "red.mp4"
    _make(src, "color=c=red:s=320x180:r=30", 4, ["-c:v", "libx264", "-g", "30"])
    ws = Workspace(tmp_path / "ws")
    clip = Clip(clip_id="c_001", source_path=str(src), in_sec=2.0, anchor_sec=4.0, out_sec=4.0, energy_tag=3)
    slicer = Slicer(ws)
    slicer.submit(clip)
    import time
    for _ in range(100):
        meta = ws.read_sidecar("c_001") or {}
        if meta.get("color_tag"):
            break
        time.sleep(0.1)
    assert meta.get("color_tag") == "red"
