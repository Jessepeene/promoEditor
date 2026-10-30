"""Pydantic models for the shared `session.promo.json` contract.

Mirrors frontend/src/types/session.ts. Fields beyond the original spec
(proxy metadata, slot cells, style) are optional so a minimal manifest
from the spec still validates.
"""

from __future__ import annotations

import uuid
from typing import Literal, Optional, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ClipMode = Literal["ANCHOR", "RANGE"]
ZoneType = Literal["INTRO_STORY", "STUTTER_BUILD", "VOCAL_BREATHER", "HYBRID_DROP", "OUTRO"]
LayoutType = Literal["FULLSCREEN_VELOCITY", "STACK_3_ROW", "CENTER_PIP_PUNCH", "STROBE_MATRIX", "SPLIT_2"]
LAYOUT_NAMES = get_args(LayoutType)
AnchorLock = Literal["DOWNBEAT", "MIDPOINT"]
Transition = Literal["CUT", "CROSSFADE", "FLASH"]
ProxyStatus = Literal["pending", "slicing", "ready", "error"]
TextAnim = Literal["AUTO", "POP", "TYPEWRITER", "WORDS", "SLIDE", "SLAM", "GLITCH", "FLICKER", "ZOOM", "LETTERS"]


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
    # 0 = breather (always a RANGE clip); 1 vibe, 2 groove, 3 hype, 4 peak (ANCHOR clips)
    energy_tag: int = Field(1, ge=0, le=4)
    focus_xy: tuple[float, float] = (0.5, 0.5)
    # Dominant look of the frame at the anchor (see color.py), used to spread colors in the edit.
    color_tag: Optional[str] = None
    color_rgb: Optional[list[int]] = Field(None, min_length=3, max_length=3)
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

    @model_validator(mode="after")
    def _tier_matches_mode(self) -> "Clip":
        # Breathers are tier 0 by definition. Sessions from before the 0-4 scheme stored
        # RANGE clips as tag 4; this also migrates them.
        if self.mode == "RANGE":
            self.energy_tag = 0
        elif self.energy_tag == 0:
            raise ValueError("energy_tag 0 is reserved for RANGE (breather) clips")
        return self


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
    # Beat-locked looks; formulas live in timing.py (per cell) and compiler._post_fx (per slot).
    push: Literal["NONE", "IN", "OUT"] = "NONE"  # slow zoom across each cell
    shake: bool = False  # decaying camera shake from each cell's first frame
    invert: bool = False  # negative flash on the slot's first frames
    strobe: bool = False  # black-frame strobe at the start of the slot
    mirror: bool = False  # left half mirrored onto the right
    echo: bool = False  # motion trails
    dim: bool = False  # darkened, e.g. under end-card text


class LayoutParams(_Model):
    matrix: Literal["3x3", "3x4", "2x5"] = "3x3"
    pip_aspect: Literal["1:1", "4:3"] = "1:1"
    pip_background: Literal["FULLSCREEN", "STACK"] = "FULLSCREEN"
    split: Literal["ROWS", "COLS"] = "ROWS"


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


class Logo(_Model):
    """A logo/artwork image drawn by the browser graphics layer (same in preview and export)."""

    path: str
    placement: Literal["TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "CENTER", "LOWER_THIRD", "CUSTOM"] = "TOP_LEFT"
    # Logo centre as canvas fractions, set by dragging it in the preview (placement CUSTOM).
    x: Optional[float] = Field(None, ge=0.0, le=1.0)
    y: Optional[float] = Field(None, ge=0.0, le=1.0)
    width_frac: float = Field(0.28, ge=0.05, le=1.0)  # of canvas width
    when: Literal["ALWAYS", "INTRO", "DROP", "OUTRO"] = "ALWAYS"
    motion: Literal["STATIC", "PULSE", "JITTER", "FADE"] = "STATIC"

    @model_validator(mode="after")
    def _custom_needs_position(self) -> "Logo":
        if self.placement == "CUSTOM" and (self.x is None or self.y is None):
            raise ValueError("a CUSTOM logo placement needs x and y")
        return self


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
            "SPLIT_2": 0.1,
        }
    )
    logos: list[Logo] = Field(default_factory=list)
    # The solver keeps clips from one source file at least this many cards apart.
    source_cooldown: int = Field(4, ge=0, le=16)
    # Scales how often the solver uses the optional effects (0 = none, 1 = default, 2 = wild).
    fx_intensity: float = Field(1.0, ge=0.0, le=2.0)

    @model_validator(mode="before")
    @classmethod
    def _migrate(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        # Sessions before multi-logo support had a single centred `overlay`.
        if "overlay" in data and "logos" not in data:
            old = data.pop("overlay") or {}
            if old.get("path"):
                data["logos"] = [{"path": old["path"], "placement": "CENTER", "width_frac": old.get("width_frac", 0.8),
                                  "motion": "JITTER" if old.get("motion") == "JITTER" else "STATIC"}]
        # Layouts added later start at weight 0 in older sessions (no surprise grids).
        if isinstance(data.get("layout_weights"), dict):
            data["layout_weights"] = {**{layout: 0.0 for layout in LAYOUT_NAMES}, **data["layout_weights"]}
        return data


class InfoRow(_Model):
    left: str = ""
    right: str = ""


class TextConfig(_Model):
    # AUTO picks a style (and accent) per roll, like the animations.
    style_preset: Literal["AUTO", "RAVE_MONO", "CHROME_Y2K", "CLEAN_BOLD", "OUTLINE_STACK", "TAPE_LABEL", "NEON",
                          "GRADIENT_POP", "MINIMAL"] = "CLEAN_BOLD"
    accent: str = Field("AUTO", pattern=r"^(AUTO|#[0-9a-fA-F]{6})$")  # colour for tape, neon, gradient
    intro_title: str = ""
    hook_words: list[str] = Field(default_factory=list)
    info_rows: list[InfoRow] = Field(default_factory=list)
    cta: str = ""  # end-card call to action, e.g. "TICKETS · LINK IN BIO"
    # Animation per element; AUTO picks a different one per roll (seeded).
    title_anim: TextAnim = "AUTO"
    hook_anim: TextAnim = "AUTO"
    rows_anim: TextAnim = "AUTO"


class Sequence(_Model):
    audio_path: Optional[str] = None
    bpm: float = 128.0
    beat_1_offset_sec: float = 0.0
    drop_beat_index: int = 16
    zones: list[Zone] = Field(default_factory=list)
    slots: list[Slot] = Field(default_factory=list)
    seed: int = 1
    style: Style = Field(default_factory=Style)
    text_config: TextConfig = Field(default_factory=TextConfig)


class TextSpan(BaseModel):
    file: str = Field(pattern=r"^t_\d{4,6}\.png$")
    start: int = Field(ge=0)  # first frame (inclusive)
    end: int  # last frame (exclusive)


class TextTrack(BaseModel):
    """Text layer rendered by the browser: one PNG per run of identical frames."""

    fps: int
    width: int
    height: int
    total_frames: int = Field(ge=1)
    spans: list[TextSpan]

    @field_validator("spans")
    @classmethod
    def _ordered(cls, spans: list[TextSpan]) -> list[TextSpan]:
        prev_end = 0
        for s in spans:
            if s.end <= s.start or s.start < prev_end:
                raise ValueError("spans must be non-empty, sorted and non-overlapping")
            prev_end = s.end
        return spans

    @model_validator(mode="after")
    def _within_total(self) -> "TextTrack":
        if self.spans and self.spans[-1].end > self.total_frames:
            raise ValueError("spans run past total_frames")
        return self


class Session(_Model):
    project_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    target_aspect: str = "9:16"
    resolution: tuple[int, int] = (1080, 1920)
    fps: int = 60
    clips: list[Clip] = Field(default_factory=list)
    sequence: Sequence = Field(default_factory=Sequence)
    # Folders the user has opened in the logger, in playlist order.
    source_folders: list[str] = Field(default_factory=list)
    # Highest clip number ever issued; ids are never reused, even after a delete, so a
    # new clip can't overwrite the cached slices of one that undo might bring back.
    clip_seq: int = Field(0, ge=0)
