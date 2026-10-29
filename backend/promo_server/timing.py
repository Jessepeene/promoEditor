"""Beat-grid math, layout regions and anchor-locked time remapping.

This is a line-for-line port of frontend/src/lib/timing.ts. The canvas
preview and the ffmpeg export both depend on these functions agreeing, which
tests/test_parity.py enforces against shared/fixtures/timing_parity.json.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from .models import Cell, Clip, LayoutParams, Session, Slot

# --- speed ramp constants (spec §4.C.1) ---
RAMP_HEAD_SPEED = 2.2
RAMP_MID_SPEED = 0.7
RAMP_TAIL_SPEED = 2.5
RAMP_HEAD_FRAMES = 3
RAMP_TAIL_FRAMES = 4
RAMP_EASE_FRAC = 0.18
RAMP_MIN_FRAMES = 16  # shorter cells play at constant speed
MIN_FIT_SCALE = 0.25

# --- scale bounce (spec §4.C.2) ---
BOUNCE_AMP = 0.14
BOUNCE_DECAY = 12.0


def beat_duration(bpm: float) -> float:
    return 60.0 / bpm


def beat_to_frame(beat: float, bpm: float, fps: int) -> int:
    """Frame index (from promo start, beat 0) of a beat position. Rounded so slots never drift."""
    return int(math.floor(beat * beat_duration(bpm) * fps + 0.5))


def audio_time_of_beat(beat: float, bpm: float, beat_1_offset_sec: float) -> float:
    return beat_1_offset_sec + beat * beat_duration(bpm)


def bounce_scale(t: float) -> float:
    return 1.0 + BOUNCE_AMP * math.exp(-BOUNCE_DECAY * max(t, 0.0))


# ---------------------------------------------------------------------------
# Layout regions
# ---------------------------------------------------------------------------

Rect = tuple[int, int, int, int]  # x, y, w, h (pixels)


def _even_split(total: int, parts: int) -> list[int]:
    """Boundaries 0..total split into `parts`, rounded to even pixels (yuv420 friendly)."""
    return [2 * int(math.floor(i * total / parts / 2 + 0.5)) for i in range(parts)] + [total]


def matrix_dims(kind: str) -> tuple[int, int]:
    cols, rows = kind.split("x")
    return int(cols), int(rows)


def layout_regions(layout: str, params: LayoutParams, width: int, height: int) -> dict[str, Rect]:
    if layout == "FULLSCREEN_VELOCITY":
        return {"full": (0, 0, width, height)}
    if layout == "STACK_3_ROW":
        ys = _even_split(height, 3)
        return {f"row{i}": (0, ys[i], width, ys[i + 1] - ys[i]) for i in range(3)}
    if layout == "CENTER_PIP_PUNCH":
        bg_layout = "STACK_3_ROW" if params.pip_background == "STACK" else "FULLSCREEN_VELOCITY"
        regions = layout_regions(bg_layout, params, width, height)
        pw = 2 * int(math.floor(width * 0.6 / 2 + 0.5))
        ph = pw if params.pip_aspect == "1:1" else 2 * int(math.floor(pw * 0.75 / 2 + 0.5))
        regions["pip"] = ((width - pw) // 2 // 2 * 2, (height - ph) // 2 // 2 * 2, pw, ph)
        return regions
    if layout == "STROBE_MATRIX":
        cols, rows = matrix_dims(params.matrix)
        xs, ys = _even_split(width, cols), _even_split(height, rows)
        return {
            f"m{r * cols + c}": (xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r])
            for r in range(rows)
            for c in range(cols)
        }
    raise ValueError(f"unknown layout {layout}")


# ---------------------------------------------------------------------------
# Speed ramp
# ---------------------------------------------------------------------------


def _smoothstep_integral(x: float) -> float:
    """∫0..x of 3u²-2u³ du."""
    return x**3 - 0.5 * x**4


@dataclass(frozen=True)
class RampShape:
    n: float  # total output frames
    head: float
    ease: float
    mid_end: float  # frame where the tail ease starts
    tail_start: float


def ramp_shape(n_frames: float) -> RampShape:
    head = float(RAMP_HEAD_FRAMES)
    tail = float(RAMP_TAIL_FRAMES)
    ease = max(2.0, RAMP_EASE_FRAC * n_frames)
    tail_start = n_frames - tail
    # Shrink the eases if the slot is too short to fit both at full length.
    room = tail_start - head
    if 2 * ease > room:
        ease = max(room / 2.0, 0.0)
    return RampShape(n_frames, head, ease, tail_start - ease, tail_start)


def ramp_speed(f: float, shape: RampShape) -> float:
    if f < shape.head:
        return RAMP_HEAD_SPEED
    if f < shape.head + shape.ease:
        u = (f - shape.head) / shape.ease
        return RAMP_HEAD_SPEED + (RAMP_MID_SPEED - RAMP_HEAD_SPEED) * (3 * u * u - 2 * u**3)
    if f < shape.mid_end:
        return RAMP_MID_SPEED
    if f < shape.tail_start:
        u = (f - shape.mid_end) / shape.ease
        return RAMP_MID_SPEED + (RAMP_TAIL_SPEED - RAMP_MID_SPEED) * (3 * u * u - 2 * u**3)
    return RAMP_TAIL_SPEED


def ramp_position(f: float, shape: RampShape) -> float:
    """∫0..f of ramp_speed, in source frames. Closed form, so TS and Python agree exactly."""
    f = max(0.0, f)
    pos = 0.0
    seg = min(f, shape.head)
    pos += RAMP_HEAD_SPEED * seg
    if f <= shape.head:
        return pos
    if shape.ease > 0:
        x = min(f - shape.head, shape.ease) / shape.ease
        pos += shape.ease * (RAMP_HEAD_SPEED * x + (RAMP_MID_SPEED - RAMP_HEAD_SPEED) * _smoothstep_integral(x))
    if f <= shape.head + shape.ease:
        return pos
    pos += RAMP_MID_SPEED * (min(f, shape.mid_end) - (shape.head + shape.ease))
    if f <= shape.mid_end:
        return pos
    if shape.ease > 0:
        x = min(f - shape.mid_end, shape.ease) / shape.ease
        pos += shape.ease * (RAMP_MID_SPEED * x + (RAMP_TAIL_SPEED - RAMP_MID_SPEED) * _smoothstep_integral(x))
    if f <= shape.tail_start:
        return pos
    pos += RAMP_TAIL_SPEED * (f - shape.tail_start)
    return pos


# ---------------------------------------------------------------------------
# Cell → source time mapping
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CellTiming:
    start_frame: int  # absolute frame (promo timeline) where the cell appears
    end_frame: int  # exclusive
    anchor: float  # source seconds the lock frame shows
    lock_frame: float  # local frame index where `anchor` is shown
    ramp: Optional[RampShape]
    speed: float  # constant speed (when ramp is None)
    scale: float  # fit factor applied to the speed profile
    lo: float
    hi: float

    @property
    def n_frames(self) -> int:
        return self.end_frame - self.start_frame


def _profile_pos(f: float, ramp: Optional[RampShape], speed: float) -> float:
    return ramp_position(f, ramp) if ramp else speed * max(f, 0.0)


def cell_timing(session: Session, slot: Slot, cell: Cell, clip: Clip) -> CellTiming:
    seq = session.sequence
    fps = session.fps
    cell_end = slot.duration_beats if cell.end is None else min(cell.end, slot.duration_beats)
    start_frame = beat_to_frame(slot.start_beat + cell.start, seq.bpm, fps)
    end_frame = max(start_frame + 1, beat_to_frame(slot.start_beat + cell_end, seq.bpm, fps))
    n = end_frame - start_frame

    slip = cell.slip_frames / fps
    lo, hi = clip.in_sec, clip.out_sec
    if clip.mode == "RANGE" or clip.anchor_sec is None:
        anchor, lock_frame = clip.in_sec + slip, 0.0
    else:
        anchor = clip.anchor_sec + slip
        lock_frame = 0.0 if cell.anchor_lock == "DOWNBEAT" else n / 2.0

    use_ramp = (
        slot.fx.speed_ramp and clip.mode == "ANCHOR" and cell.region == "full" and n >= RAMP_MIN_FRAMES
    )
    ramp = ramp_shape(float(n)) if use_ramp else None
    speed = 1.0 if use_ramp else slot.fx.speed

    # Scale the speed profile down if it would run past the logged window.
    need_pre = (_profile_pos(lock_frame, ramp, speed) - _profile_pos(0, ramp, speed)) / fps
    need_post = (_profile_pos(n, ramp, speed) - _profile_pos(lock_frame, ramp, speed)) / fps
    scale = 1.0
    if need_pre > 1e-9:
        scale = min(scale, max(anchor - lo, 0.0) / need_pre)
    if need_post > 1e-9:
        scale = min(scale, max(hi - anchor, 0.0) / need_post)
    scale = max(scale, MIN_FIT_SCALE)
    return CellTiming(start_frame, end_frame, anchor, lock_frame, ramp, speed, scale, lo, hi)


def source_time(t: CellTiming, local_frame: float, fps: int) -> float:
    """Source-file seconds displayed at `local_frame` frames after the cell appears."""
    pos = _profile_pos(local_frame, t.ramp, t.speed) - _profile_pos(t.lock_frame, t.ramp, t.speed)
    s = t.anchor + t.scale * pos / fps
    return min(max(s, t.lo), t.hi)


def promo_frame_count(session: Session) -> int:
    seq = session.sequence
    end_beat = 0.0
    for z in seq.zones:
        end_beat = max(end_beat, z.end_beat)
    for s in seq.slots:
        end_beat = max(end_beat, s.start_beat + s.duration_beats)
    return beat_to_frame(end_beat, seq.bpm, session.fps)
