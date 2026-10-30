import math

import pytest

from promo_server.models import Cell, Clip, LayoutParams, Session, Slot, SlotFx
from promo_server.timing import (
    RAMP_HEAD_SPEED,
    RAMP_TAIL_SPEED,
    beat_to_frame,
    bounce_scale,
    cell_timing,
    layout_regions,
    ramp_position,
    ramp_shape,
    ramp_speed,
    source_time,
)


@pytest.mark.parametrize("n", [16, 27, 53, 107, 240])
def test_ramp_position_matches_numeric_integral(n):
    shape = ramp_shape(float(n))
    steps = 20000
    acc, prev = 0.0, ramp_speed(0, shape)
    for i in range(1, steps + 1):
        f = n * i / steps
        cur = ramp_speed(f, shape)
        acc += (prev + cur) / 2 * (n / steps)
        prev = cur
    assert ramp_position(n, shape) == pytest.approx(acc, rel=1e-3)


def test_ramp_profile_endpoints():
    shape = ramp_shape(60.0)
    assert ramp_speed(0, shape) == RAMP_HEAD_SPEED
    assert ramp_speed(30, shape) == pytest.approx(0.7)
    assert ramp_speed(59, shape) == RAMP_TAIL_SPEED


def test_beat_frames_never_drift():
    # 135 BPM at 60 fps: a beat is 26.666 frames; slot boundaries must tile exactly.
    edges = [beat_to_frame(b * 0.25, 135, 60) for b in range(400)]
    assert all(b >= a for a, b in zip(edges, edges[1:]))
    assert beat_to_frame(100, 135, 60) == round(100 * 60 / 135 * 60)


def test_bounce_curve():
    assert bounce_scale(0) == pytest.approx(1.14)
    assert bounce_scale(0.15) == pytest.approx(1 + 0.14 * math.exp(-1.8))


def test_layouts_tile_canvas():
    for layout, params in [
        ("FULLSCREEN_VELOCITY", LayoutParams()),
        ("STACK_3_ROW", LayoutParams()),
        ("STROBE_MATRIX", LayoutParams(matrix="3x3")),
        ("STROBE_MATRIX", LayoutParams(matrix="3x4")),
        ("STROBE_MATRIX", LayoutParams(matrix="2x5")),
    ]:
        regions = layout_regions(layout, params, 1080, 1920)
        assert sum(w * h for _, _, w, h in regions.values()) == 1080 * 1920
        assert all(w % 2 == 0 and h % 2 == 0 for _, _, w, h in regions.values())
    pip = layout_regions("CENTER_PIP_PUNCH", LayoutParams(pip_aspect="4:3"), 1080, 1920)["pip"]
    assert pip == (216, 716, 648, 486)


def _session(bpm=128.0):
    s = Session()
    s.sequence.bpm = bpm
    return s


def test_anchor_locked_on_downbeat_and_midpoint():
    s = _session()
    clip = Clip(clip_id="c", source_path="x", in_sec=10, anchor_sec=12, out_sec=14, energy_tag=3)
    slot = Slot(slot_id="s", start_beat=4, duration_beats=2, zone_type="HYBRID_DROP")
    down = cell_timing(s, slot, Cell(region="full", clip_id="c"), clip)
    assert source_time(down, 0, 60) == pytest.approx(12.0)
    mid = cell_timing(s, slot, Cell(region="full", clip_id="c", anchor_lock="MIDPOINT"), clip)
    assert source_time(mid, mid.n_frames / 2, 60) == pytest.approx(12.0)
    assert mid.ramp is not None


def test_slip_shifts_anchor_by_frames():
    s = _session()
    clip = Clip(clip_id="c", source_path="x", in_sec=10, anchor_sec=12, out_sec=14)
    slot = Slot(slot_id="s", start_beat=0, duration_beats=1, zone_type="HYBRID_DROP")
    t = cell_timing(s, slot, Cell(region="full", clip_id="c", slip_frames=2), clip)
    assert source_time(t, 0, 60) == pytest.approx(12 + 2 / 60)


def test_window_fit_slows_instead_of_overrunning():
    s = _session(bpm=90)
    clip = Clip(clip_id="c", source_path="x", mode="RANGE", in_sec=5, out_sec=6, energy_tag=0)
    slot = Slot(slot_id="s", start_beat=0, duration_beats=4, zone_type="VOCAL_BREATHER",
                fx=SlotFx(speed_ramp=False, speed=0.75))
    t = cell_timing(s, slot, Cell(region="full", clip_id="c"), clip)
    # 4 beats at 90 BPM = 2.67 s; at 0.75x that needs 2 s of source but only 1 s exists.
    assert t.scale == pytest.approx(0.5, rel=0.02)
    assert source_time(t, t.n_frames, 60) == pytest.approx(6.0, abs=1e-6)
