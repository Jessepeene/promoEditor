"""Pydantic models for the shared `session.promo.json` contract.

Mirrors frontend/src/types/session.ts. Fields beyond the original spec
(proxy metadata, slot cells, style) are optional so a minimal manifest
from the spec still validates.
"""

from __future__ import annotations

import uuid
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

ClipMode = Literal["ANCHOR", "RANGE"]
ZoneType = Literal["INTRO_STORY", "STUTTER_BUILD", "VOCAL_BREATHER", "HYBRID_DROP"]
LayoutType = Literal["FULLSCREEN_VELOCITY", "STACK_3_ROW", "CENTER_PIP_PUNCH", "STROBE_MATRIX"]
AnchorLock = Literal["DOWNBEAT", "MIDPOINT"]
Transition = Literal["CUT", "CROSSFADE", "FLASH"]
ProxyStatus = Literal["pending", "slicing", "ready", "error"]


class _Model(BaseModel):
    # Keep unknown keys so newer frontends can round-trip through an older backend.
    model_config = ConfigDict(extra="allow")


class Clip(_Model):
    clip_id: str
    source_path: str
    proxy_path: Optional[str] = None
    mode: ClipMode = "ANCHOR"
    in_sec: float
    anchor_sec: Optional[float] = None
    out_sec: float
    # 1 = vibe, 2 = groove, 3 = peak, 4 = continuous/breather (RANGE)
    energy_tag: int = Field(1, ge=1, le=4)
    focus_xy: tuple[float, float] = (0.5, 0.5)
    # Source time of the proxy's first frame. `-c copy` snaps to the previous
    # keyframe, so this is <= in_sec.
    proxy_start_sec: Optional[float] = None
    proxy_status: ProxyStatus = "pending"
    proxy_error: Optional[str] = None
    # Low-res, short-GOP transcode of the proxy for multi-clip canvas preview.
    # Same timeline as the proxy (t=0 is proxy_start_sec).
    preview_path: Optional[str] = None
    thumb_path: Optional[str] = None
    source_duration_sec: Optional[float] = None


class Zone(_Model):
    start_beat: float
    end_beat: float
    type: ZoneType

    @field_validator("type", mode="before")
    @classmethod
    def _legacy_names(cls, v: str) -> str:
        return "INTRO_STORY" if v == "INTRO_BUILD" else v


class Cell(_Model):
    """One clip placement inside a slot. Times are in beats relative to the slot start."""

    region: str  # full | row0..row2 | pip | m0..m11
    clip_id: str
    start: float = 0.0
    end: Optional[float] = None  # None = until slot end
    slip_frames: int = 0
    anchor_lock: AnchorLock = "DOWNBEAT"


class SlotFx(_Model):
    bounce: bool = False
    rgb_split: bool = False
    glitch: bool = False
    speed_ramp: bool = True
    speed: float = 1.0  # constant speed used when speed_ramp is off
    transition: Transition = "CUT"


class LayoutParams(_Model):
    matrix: Literal["3x3", "3x4", "2x5"] = "3x3"
    pip_aspect: Literal["1:1", "4:3"] = "1:1"
    pip_background: Literal["FULLSCREEN", "STACK"] = "FULLSCREEN"


class Slot(_Model):
    slot_id: str
    start_beat: float
    duration_beats: float
    zone_type: ZoneType
    layout: LayoutType = "FULLSCREEN_VELOCITY"
    layout_params: LayoutParams = Field(default_factory=LayoutParams)
    locked: bool = False
    cells: list[Cell] = Field(default_factory=list)
    fx: SlotFx = Field(default_factory=SlotFx)


class Overlay(_Model):
    path: Optional[str] = None
    motion: Literal["STATIC", "JITTER"] = "STATIC"
    width_frac: float = 0.8  # overlay width as a fraction of canvas width


class Style(_Model):
    bounce: bool = True
    rgb_split: bool = True
    vhs_glitch: bool = False
    layout_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "FULLSCREEN_VELOCITY": 0.4,
            "STACK_3_ROW": 0.25,
            "CENTER_PIP_PUNCH": 0.2,
            "STROBE_MATRIX": 0.15,
        }
    )
    overlay: Overlay = Field(default_factory=Overlay)


class Sequence(_Model):
    audio_path: Optional[str] = None
    bpm: float = 128.0
    beat_1_offset_sec: float = 0.0
    drop_beat_index: int = 16
    zones: list[Zone] = Field(default_factory=list)
    slots: list[Slot] = Field(default_factory=list)
    seed: int = 1
    style: Style = Field(default_factory=Style)


class Session(_Model):
    project_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    target_aspect: str = "9:16"
    resolution: tuple[int, int] = (1080, 1920)
    fps: int = 60
    clips: list[Clip] = Field(default_factory=list)
    sequence: Sequence = Field(default_factory=Sequence)
    # Folders the user has opened in the logger, in playlist order.
    source_folders: list[str] = Field(default_factory=list)
