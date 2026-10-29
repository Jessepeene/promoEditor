"""Compile a session's `sequence` into ffmpeg commands (spec §5).

Each slot renders to its own intermediate segment with an exact frame count,
so beat timing never drifts no matter how many cuts there are. A final pass
joins the segments (concat / xfade), adds the global VHS layer, the pinned
typography overlay and the trimmed music track, and encodes the delivery MP4.

Per-cell chain inside a segment:
    proxy -> setpts(PTS-STARTPTS) -> setpts(inverse speed curve) -> fps -> pad/trim
          -> cover-scale + crop around focus_xy -> zoompan bounce
Regions are combined with xstack (rows, matrix) and overlay (PiP).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import ffmpeg_bin
from .models import Cell, Clip, Session, Slot
from .timing import (
    BOUNCE_AMP,
    BOUNCE_DECAY,
    beat_to_frame,
    cell_timing,
    layout_regions,
    promo_frame_count,
    source_time,
)
from .workspace import Workspace

XFADE_FRAMES = 8
REMAP_SAMPLES = 32


@dataclass
class Segment:
    index: int
    start_frame: int
    n_frames: int
    tail_frames: int
    transition: str
    out: Path
    args: list[str] = field(default_factory=list)

    @property
    def total_frames(self) -> int:
        return self.n_frames + self.tail_frames


@dataclass
class ExportPlan:
    segments: list[Segment]
    final_args: list[str]
    output: Path
    total_frames: int


def _num(x: float) -> str:
    return f"{x:.6f}".rstrip("0").rstrip(".") if x != int(x) else str(int(x))


def _remap_expr(points: list[tuple[float, float]], base: float) -> str:
    """setpts expression mapping input time T (seconds since proxy frame 0) to output seconds.

    `points` are (source_sec, output_sec) samples of the forward map, increasing in
    source time. Frames past the last sample are pushed far out and trimmed later;
    frames before the first get negative times and are dropped by `fps`.
    """
    s = f"(T+{_num(base)})"
    expr = f"({_num(points[-1][1])}+({s}-{_num(points[-1][0])})*1000)"
    for i in range(len(points) - 2, -1, -1):
        (s0, t0), (s1, t1) = points[i], points[i + 1]
        slope = (t1 - t0) / (s1 - s0)
        expr = f"if(lt({s},{_num(s1)}),{_num(t0)}+({s}-{_num(s0)})*{_num(slope)},{expr})"
    return f"({expr})/TB"


def _remap_points(timing, n_frames: int, fps: int) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for k in range(REMAP_SAMPLES + 1):
        f = n_frames * k / REMAP_SAMPLES
        src = source_time(timing, f, fps)
        if pts and src <= pts[-1][0] + 1e-6:
            continue  # clamped (freeze) section: the frame shows from its first output time
        pts.append((src, f / fps))
    if len(pts) == 1:
        pts.append((pts[0][0] + 1.0, pts[0][1] + 1000.0))
    return pts


class SegmentBuilder:
    def __init__(self, session: Session, ws: Workspace, slot: Slot, start_frame: int, n: int, tail: int):
        self.session, self.ws, self.slot = session, ws, slot
        self.fps = session.fps
        self.W, self.H = session.resolution
        self.start_frame, self.n, self.tail = start_frame, n, tail
        self.inputs: list[str] = []
        self.filters: list[str] = []
        self._label = 0
        self.clips = {c.clip_id: c for c in session.clips}

    def label(self, prefix: str = "v") -> str:
        self._label += 1
        return f"{prefix}{self._label}"

    def add_input(self, clip: Clip) -> tuple[int, float]:
        """Returns (input index, source time of the input's first frame)."""
        idx = sum(1 for a in self.inputs if a == "-i")
        if clip.proxy_status == "ready" and clip.proxy_path and clip.proxy_start_sec is not None:
            self.inputs += ["-i", str(self.ws.resolve(clip.proxy_path))]
            return idx, clip.proxy_start_sec
        seek = max(clip.in_sec - 1.0, 0.0)
        self.inputs += ["-ss", _num(seek), "-t", _num(clip.out_sec - seek + 1.0), "-i",
                        str(self.ws.resolve(clip.source_path))]
        return idx, seek

    def black(self, w: int, h: int, frames: int) -> str:
        out = self.label("k")
        self.filters.append(f"color=c=black:s={w}x{h}:r={self.fps},trim=end_frame={frames}[{out}]")
        return out

    def cell_stream(self, cell: Cell, rect, frames: int, extend: int) -> Optional[str]:
        clip = self.clips.get(cell.clip_id)
        if clip is None:
            return None
        timing = cell_timing(self.session, self.slot, cell, clip)
        idx, base = self.add_input(clip)
        total = frames + extend
        pts = _remap_points(timing, total, self.fps)
        _, _, rw, rh = rect
        fx, fy = clip.focus_xy
        out = self.label()
        chain = [
            "setpts=PTS-STARTPTS",
            f"setpts='{_remap_expr(pts, base)}'",
            f"fps=fps={self.fps}:start_time=0:round=near",
            "tpad=stop_mode=clone:stop_duration=30:start_mode=clone:start_duration=0",
            f"trim=end_frame={total}",
            "setpts=PTS-STARTPTS",
            f"scale=w={rw}:h={rh}:force_original_aspect_ratio=increase",
            f"crop=w={rw}:h={rh}:x='min(max({_num(fx)}*iw-ow/2,0),iw-ow)':y='min(max({_num(fy)}*ih-oh/2,0),ih-oh)'",
            "setsar=1",
        ]
        if self.session.sequence.style.bounce and self.slot.fx.bounce:
            chain.append(
                f"zoompan=z='1+{BOUNCE_AMP}*exp(-{BOUNCE_DECAY}*it)':d=1"
                f":x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':s={rw}x{rh}:fps={self.fps}"
            )
        chain.append("format=yuv420p")
        self.filters.append(f"[{idx}:v]" + ",".join(chain) + f"[{out}]")
        return out

    def region_stream(self, cells: list[Cell], rect) -> str:
        """Concatenate the region's cells over time, filling gaps with black."""
        _, _, rw, rh = rect
        total = self.n + self.tail
        pieces: list[str] = []
        cursor = 0
        for cell, a, b in self._cell_spans(cells):
            if a > cursor:
                pieces.append(self.black(rw, rh, a - cursor))
            extend = self.tail if b >= self.n else 0
            stream = self.cell_stream(cell, rect, b - a, extend)
            if stream:
                pieces.append(stream)
                cursor = b + extend
            else:
                pieces.append(self.black(rw, rh, b - a + extend))
                cursor = b + extend
        if cursor < total:
            pieces.append(self.black(rw, rh, total - cursor))
        if len(pieces) == 1:
            return pieces[0]
        out = self.label("r")
        self.filters.append("".join(f"[{p}]" for p in pieces) + f"concat=n={len(pieces)}:v=1:a=0[{out}]")
        return out

    def _cell_spans(self, cells: list[Cell]):
        """(cell, local_start, local_end) frames, sorted and non-overlapping."""
        spans = []
        bpm = self.session.sequence.bpm
        for c in cells:
            end = self.slot.duration_beats if c.end is None else min(c.end, self.slot.duration_beats)
            a = beat_to_frame(self.slot.start_beat + c.start, bpm, self.fps) - self.start_frame
            b = beat_to_frame(self.slot.start_beat + end, bpm, self.fps) - self.start_frame
            a, b = max(a, 0), min(b, self.n)
            if b > a:
                spans.append((c, a, b))
        spans.sort(key=lambda s: s[1])
        cleaned = []
        for c, a, b in spans:
            if cleaned and a < cleaned[-1][2]:
                pc, pa, _ = cleaned[-1]
                cleaned[-1] = (pc, pa, a)  # a later cell cuts the earlier one short
                if a <= pa:
                    cleaned.pop()
            cleaned.append((c, a, b))
        return cleaned

    def build(self, out_path: Path, encoder_args: list[str]) -> list[str]:
        slot, W, H = self.slot, self.W, self.H
        regions = layout_regions(slot.layout, slot.layout_params, W, H)
        by_region: dict[str, list[Cell]] = {k: [] for k in regions}
        for c in slot.cells:
            if c.region in by_region:
                by_region[c.region].append(c)

        bg_names = [k for k in regions if k != "pip"]
        streams = [self.region_stream(by_region[k], regions[k]) for k in bg_names]
        if len(streams) == 1:
            base = streams[0]
        else:
            layout = "|".join(f"{regions[k][0]}_{regions[k][1]}" for k in bg_names)
            base = self.label("x")
            self.filters.append("".join(f"[{s}]" for s in streams)
                                + f"xstack=inputs={len(streams)}:layout={layout}:fill=black[{base}]")

        if "pip" in regions:
            px, py, _, _ = regions["pip"]
            for cell, a, b in self._cell_spans(by_region["pip"]):
                stream = self.cell_stream(cell, regions["pip"], b - a, 0)
                if not stream:
                    continue
                shifted = self.label("p")
                self.filters.append(f"[{stream}]setpts=PTS+{a}/({self.fps}*TB)[{shifted}]")
                out = self.label("o")
                self.filters.append(f"[{base}][{shifted}]overlay=x={px}:y={py}:eof_action=pass"
                                    f":enable='between(n,{a},{b - 1})'[{out}]")
                base = out

        if self.session.sequence.style.vhs_glitch and slot.fx.glitch:
            base = self._block_glitch(base)
        post = self._post_fx()
        final = self.label("f")
        self.filters.append(f"[{base}]" + ",".join(post + ["format=yuv420p"]) + f"[{final}]")
        return [ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", *self.inputs,
                "-filter_complex", ";".join(self.filters), "-map", f"[{final}]",
                "-frames:v", str(self.n + self.tail), "-r", str(self.fps), *encoder_args, str(out_path)]

    def _post_fx(self) -> list[str]:
        slot, style = self.slot, self.session.sequence.style
        px = max(1, round(12 * self.W / 1080))
        post: list[str] = ["setsar=1"]
        if style.bounce and slot.fx.bounce:
            # Vertical motion blur riding the first frames of the bounce.
            post.append("gblur=sigma=0.01:sigmaV=9:steps=2:enable='lt(n,2)'")
            post.append("gblur=sigma=0.01:sigmaV=4:steps=1:enable='between(n,2,3)'")
        if style.rgb_split and slot.fx.rgb_split:
            post.append(f"rgbashift=rh=-{px}:bh={px}:edge=smear:enable='lt(n,4)'")
            post.append(f"rgbashift=rh=-{px // 2}:bh={px // 2}:edge=smear:enable='between(n,4,7)'")
        if slot.fx.transition == "FLASH":
            post.append(f"fade=t=in:st=0:d={_num(min(0.12, self.n / self.fps / 2))}:color=white")
        return post

    def _block_glitch(self, base: str) -> str:
        """Displace a few horizontal bands sideways for the first frames of a bar.

        Seeded per slot so re-exports are identical; it is not pixel-matched to
        the WebGL preview's glitch, which is fine for a 5-frame effect.
        """
        rng = random.Random(f"{self.session.sequence.seed}:{self.slot.slot_id}")
        last = min(5, self.n) - 1
        bands = 3
        split = [self.label("g") for _ in range(bands + 1)]
        self.filters.append(f"[{base}]split={bands + 1}" + "".join(f"[{s}]" for s in split))
        cur = split[0]
        for i in range(bands):
            bh = rng.randint(self.H // 40, self.H // 10) // 2 * 2
            y = rng.randint(0, self.H - bh) // 2 * 2
            dx = rng.choice([-1, 1]) * rng.randint(self.W // 30, self.W // 8)
            band, out = self.label("b"), self.label("g")
            self.filters.append(f"[{split[i + 1]}]crop=iw:{bh}:0:{y}[{band}]")
            self.filters.append(f"[{cur}][{band}]overlay=x={dx}:y={y}:enable='between(n,0,{last})'[{out}]")
            cur = out
        return cur


def _encoder_final() -> list[str]:
    if ffmpeg_bin.best_h264_encoder() == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "18M", "-maxrate", "24M", "-bufsize", "36M"]
    return ["-c:v", "libx264", "-preset", "medium", "-b:v", "18M", "-maxrate", "24M", "-bufsize", "36M"]


INTERMEDIATE = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "-an"]


def plan_export(session: Session, ws: Workspace, work_dir: Path, output: Path) -> ExportPlan:
    seq, fps = session.sequence, session.fps
    W, H = session.resolution
    total_frames = promo_frame_count(session)
    if total_frames <= 0:
        raise ValueError("Sequence is empty: add zones and roll the slot machine first.")

    # Timeline of (start_frame, end_frame, slot|None) covering [0, total_frames).
    slots = sorted(seq.slots, key=lambda s: s.start_beat)
    spans: list[tuple[int, int, Optional[Slot]]] = []
    cursor = 0
    for s in slots:
        a = beat_to_frame(s.start_beat, seq.bpm, fps)
        b = beat_to_frame(s.start_beat + s.duration_beats, seq.bpm, fps)
        a = max(a, cursor)
        if b <= a:
            continue
        if a > cursor:
            spans.append((cursor, a, None))
        spans.append((a, b, s))
        cursor = b
    if cursor < total_frames:
        spans.append((cursor, total_frames, None))

    segments: list[Segment] = []
    for i, (a, b, slot) in enumerate(spans):
        nxt = spans[i + 1][2] if i + 1 < len(spans) else None
        n = b - a
        tail = XFADE_FRAMES if (nxt is not None and nxt.fx.transition == "CROSSFADE"
                                and slot is not None and n > XFADE_FRAMES) else 0
        seg = Segment(i, a, n, tail, slot.fx.transition if slot else "CUT", work_dir / f"seg_{i:04d}.mp4")
        if slot is None:
            seg.args = [ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-i",
                        f"color=c=black:s={W}x{H}:r={fps}", "-frames:v", str(n), *INTERMEDIATE, str(seg.out)]
        else:
            seg.args = SegmentBuilder(session, ws, slot, a, n, tail).build(seg.out, INTERMEDIATE)
        segments.append(seg)

    final_args = _final_pass(session, ws, segments, output, total_frames)
    return ExportPlan(segments, final_args, output, total_frames)


def _final_pass(session: Session, ws: Workspace, segments: list[Segment], output: Path, total: int) -> list[str]:
    seq, fps = session.sequence, session.fps
    W, H = session.resolution
    args = [ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error"]
    for seg in segments:
        args += ["-i", str(seg.out)]
    filters: list[str] = []

    # Runs of hard cuts are concatenated; a CROSSFADE starts a new run joined with xfade.
    runs: list[list[Segment]] = [[segments[0]]]
    for seg in segments[1:]:
        prev = runs[-1][-1]
        if seg.transition == "CROSSFADE" and prev.tail_frames > 0:
            runs.append([seg])
        else:
            runs[-1].append(seg)
    run_labels = []
    for r, run in enumerate(runs):
        lbl = f"run{r}"
        ins = "".join(f"[{s.index}:v]" for s in run)
        # Segments are already exact-frame-count at `fps`; retime by frame index rather
        # than resampling with `fps`, which can merge two frames at a segment boundary.
        # The trailing `fps` is then a no-op that just declares the constant rate xfade needs.
        filters.append(f"{ins}concat=n={len(run)}:v=1:a=0,settb=1/{fps},setpts=N,fps={fps}[{lbl}]")
        run_labels.append(lbl)
    acc = run_labels[0]
    acc_frames = sum(s.n_frames for s in runs[0])
    for r in range(1, len(runs)):
        tail = runs[r - 1][-1].tail_frames
        out = f"xf{r}"
        filters.append(f"[{acc}][{run_labels[r]}]xfade=transition=fade:duration={_num(tail / fps)}"
                       f":offset={_num(acc_frames / fps)}[{out}]")
        acc = out
        acc_frames += sum(s.n_frames for s in runs[r])

    v = acc
    if seq.style.vhs_glitch:
        filters.append(f"[{v}]drawgrid=w=iw:h=4:t=1:c=black@0.22,noise=alls=7:allf=t,"
                       f"eq=saturation=1.12:contrast=1.04[vhs]")
        v = "vhs"

    n_inputs = len(segments)
    ov = seq.style.overlay
    if ov.path and ws.resolve(ov.path).exists():
        args += ["-loop", "1", "-framerate", str(fps), "-i", str(ws.resolve(ov.path))]
        ow = max(2, int(W * ov.width_frac) // 2 * 2)
        filters.append(f"[{n_inputs}:v]scale={ow}:-1,format=rgba[ovs]")
        if ov.motion == "JITTER":
            x = "(W-w)/2+3*sin(2*PI*t*7.3)+2*sin(2*PI*t*13.1)"
            y = "(H-h)/2+2*sin(2*PI*t*5.9)+2*sin(2*PI*t*11.7)"
        else:
            x, y = "(W-w)/2", "(H-h)/2"
        filters.append(f"[{v}][ovs]overlay=x='{x}':y='{y}':shortest=1:format=auto[ovl]")
        v = "ovl"
        n_inputs += 1

    filters.append(f"[{v}]format=yuv420p[vout]")
    total_sec = total / fps
    audio_map: list[str] = []
    if seq.audio_path and ws.resolve(seq.audio_path).exists():
        start = seq.beat_1_offset_sec
        if start >= 0:
            args += ["-ss", _num(start), "-i", str(ws.resolve(seq.audio_path))]
            filters.append(f"[{n_inputs}:a]atrim=end={_num(total_sec)},asetpts=PTS-STARTPTS[aout]")
        else:
            args += ["-i", str(ws.resolve(seq.audio_path))]
            ms = int(round(-start * 1000))
            filters.append(f"[{n_inputs}:a]adelay={ms}:all=1,atrim=end={_num(total_sec)},asetpts=PTS-STARTPTS[aout]")
        audio_map = ["-map", "[aout]", "-c:a", "aac", "-b:a", "320k"]

    args += ["-filter_complex", ";".join(filters), "-map", "[vout]", *audio_map,
             "-frames:v", str(total), "-r", str(fps), *_encoder_final(), "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", str(output)]
    return args


def describe(plan: ExportPlan) -> str:
    """Human-readable dump of every command (written next to the export for debugging)."""

    def q(a: str) -> str:
        return f'"{a}"' if any(ch in a for ch in " ;'[]|()") else a

    lines = [f"# {len(plan.segments)} segments, {plan.total_frames} frames"]
    for seg in plan.segments:
        lines.append(f"\n# segment {seg.index}: frames {seg.start_frame}+{seg.n_frames} (tail {seg.tail_frames})")
        lines.append(" ".join(q(a) for a in seg.args))
    lines.append("\n# final pass")
    lines.append(" ".join(q(a) for a in plan.final_args))
    return "\n".join(lines)

