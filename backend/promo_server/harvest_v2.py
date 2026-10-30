"""Auto-harvest v2: refine the keyframe scan (harvest.analyse) by decoding short windows.

Pass 1 (shared with v1) scores keyframes cheaply. The most promising ones are then
decoded around the keyframe at full frame rate, small and grey, and per frame:
  - each frame is normalised (mean/std), so light flicker and strobes don't count as motion;
  - the camera's own shift is estimated (phase correlation) and removed, so shake and pans
    don't count as action; what is left is subject motion;
  - hard cuts (sources that are already edited) split the window, and a clip never crosses one.
The anchor lands on the frame of peak subject motion and the focus point where that motion is.
That frame is then rendered once as the full-screen 9:16 crop: blur, missed focus and
low-resolution sources all lose fine detail there, which gives the clip's `quality`.

Picks per file scale with the file's length, and the final set is chosen greedily so it
spreads over files and looks (a coarse colour layout of the anchor frame).
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from . import ffmpeg_bin
from .harvest import BREATHER_LEN, Moment, motion_tag

log = logging.getLogger(__name__)

W, H = 160, 90  # analysis size (aspect is squashed; positions are kept as fractions)
WINDOW_PAD = 2.5  # decode keyframe ± this many seconds
PEAK_SEARCH = 1.0  # the anchor stays within ± this of the keyframe
ANCHOR_PAD = 2.0
CUT_MARGIN = 0.5  # an anchor keeps at least this far from a cut
MIN_SPAN = 1.5  # shortest usable cut-free stretch around an anchor
MAX_SHIFT = 16  # px per frame at analysis size (10% of the width); larger "shifts" are false matches
CUT_CORR = 0.35
LOCAL_SIZE, LOCAL_EPS = 9, 0.05  # neighbourhood (px) and floor for local brightness normalisation  # correlation of aligned consecutive frames below this (and staying low) = hard cut
DARK_LEVEL, FLAT_STD = 0.03, 0.03  # frames this dark / flat carry no usable motion
SECONDS_PER_PICK = 20.0
MAX_PICKS_PER_FILE = 4
CANDIDATE_GAP = 4.0
FILE_REPEAT = 0.35  # score factor per earlier pick from the same file
LOOK_SCALE = 0.03  # mean squared colour-layout difference at which looks count as distinct
LOOK_WEIGHT = 0.6
SHAKE_REF = 1.5  # px/frame of jerk at analysis size that halves a score
PAN_REF = 30.0  # px/s of steady camera move that earns a breather its full bonus
# Blur of the full-screen 540x960 crop (see `blur`) mapped to quality 1 (crisp) .. 0 (soft).
# Calibrated on test patterns only: sharp 1080p ~0.28, 360p blown up ~0.41-0.47, a 3 px blur ~0.73.
SHARP_W, SHARP_H = 540, 960
BLUR_CRISP, BLUR_SOFT = 0.30, 0.50

_PTS_RE = re.compile(r"pts_time:\s*(-?[\d.]+)")
_HANN = np.outer(np.hanning(H), np.hanning(W)).astype(np.float32)

Progress = Callable[[str, int, int], None]


@dataclass(eq=False)  # identity: shots are picked from lists, and `look` is an array
class Shot:
    path: str
    anchor: Optional[float]  # None for breathers
    in_sec: float
    out_sec: float
    action: float  # subject motion (normalised difference per second)
    shake: float
    pan: float
    contrast: float
    quality: float
    focus: tuple[float, float]
    look: np.ndarray
    duration: float  # of the source file

    @property
    def score(self) -> float:
        return self.action * (0.5 + self.contrast) * (0.4 + 0.6 * self.quality) / (1 + self.shake / SHAKE_REF)

    @property
    def calm_score(self) -> float:
        steady_move = 1 + 0.5 * min(self.pan / PAN_REF, 1.0)
        return (0.3 + self.quality) * (0.5 + self.contrast) * steady_move / (1 + self.action + self.shake / SHAKE_REF)


@dataclass
class Window:
    """Per-frame analysis of a decoded stretch. Arrays are indexed by frame; index 0 has no motion."""

    times: np.ndarray
    motion: np.ndarray  # subject motion per second (0 where unknown)
    shift: np.ndarray  # (n, 2) camera shift from the previous frame, px
    diff: list[Optional[np.ndarray]]  # aligned difference maps, for the focus point
    contrast: np.ndarray
    segments: list[tuple[int, int]]  # cut-free frame ranges [start, end)

    def span(self, seg: tuple[int, int]) -> tuple[float, float]:
        a, b = seg
        dt = float(np.median(np.diff(self.times))) if len(self.times) > 1 else 0.0
        return float(self.times[a]), float(self.times[b - 1]) + dt


def _decode(path: str, start: float, length: float) -> tuple[np.ndarray, np.ndarray]:
    res = ffmpeg_bin.run_bytes(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "info", "-hide_banner", "-ss", f"{start:.3f}", "-i", path,
         "-t", f"{length:.3f}", "-an", "-vf", f"scale={W}:{H},format=gray,showinfo",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        timeout=120,
    )
    raw = np.frombuffer(res.stdout, dtype=np.uint8)
    n = len(raw) // (W * H)
    # With an input seek the frame timestamps start at 0 at the seek point.
    times = [start + float(t) for t in _PTS_RE.findall(res.stderr.decode(errors="replace"))][:n]
    if len(times) < n:
        n = len(times)
    return raw[: n * W * H].reshape(n, H, W).astype(np.float32) / 255.0, np.array(times)


def _shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Sub-pixel (dy, dx) such that a[y, x] ≈ b[y - dy, x - dx] (phase correlation)."""
    cross = np.fft.rfft2(a * _HANN) * np.conj(np.fft.rfft2(b * _HANN))
    r = np.fft.irfft2(cross / (np.abs(cross) + 1e-9), s=a.shape)
    iy, ix = (int(v) for v in np.unravel_index(int(np.argmax(r)), r.shape))

    def vertex(lo: float, mid: float, hi: float) -> float:
        denom = lo - 2 * mid + hi
        return min(max(0.5 * (lo - hi) / denom, -0.5), 0.5) if denom else 0.0

    dy = iy + vertex(r[iy - 1, ix], r[iy, ix], r[(iy + 1) % H, ix])
    dx = ix + vertex(r[iy, ix - 1], r[iy, ix], r[iy, (ix + 1) % W])
    dy = dy - H if dy > H / 2 else dy
    dx = dx - W if dx > W / 2 else dx
    if abs(dy) > MAX_SHIFT or abs(dx) > MAX_SHIFT:
        return 0.0, 0.0
    return dy, dx


_FY = np.fft.fftfreq(H)[:, None]
_FX = np.fft.rfftfreq(W)[None, :]


def _aligned(a: np.ndarray, b: np.ndarray, dy: float, dx: float) -> tuple[np.ndarray, np.ndarray, tuple[slice, slice]]:
    """`b` moved by (dy, dx) onto `a`, both cropped to the area they share."""
    moved = np.fft.irfft2(np.fft.rfft2(b) * np.exp(-2j * np.pi * (_FY * dy + _FX * dx)), s=b.shape)
    my, mx = int(np.ceil(abs(dy))) + 1, int(np.ceil(abs(dx))) + 1
    region = (slice(my, H - my), slice(mx, W - mx))
    return a[region], moved[region], region


def _box(x: np.ndarray, k: int) -> np.ndarray:
    """k x k mean filter, edges repeated."""
    h, w = x.shape
    c = np.pad(np.pad(x, k // 2, mode="edge").cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[k:k + h, k:k + w] - c[:h, k:k + w] - c[k:k + h, :w] + c[:h, :w]) / (k * k)


def _local_norm(x: np.ndarray) -> np.ndarray:
    """Normalise brightness and contrast per neighbourhood: light changes don't read as motion."""
    m = _box(x, LOCAL_SIZE)
    var = _box(x * x, LOCAL_SIZE) - m * m
    return (x - m) / np.sqrt(np.maximum(var, 0) + LOCAL_EPS)


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a - a.mean(), b - b.mean()
    return float((a * b).mean() / (a.std() * b.std() + 1e-6))


def _top_mean(d: np.ndarray) -> float:
    """Mean of the strongest 10%: a small subject moving isn't averaged away by a still background."""
    return float(d[d >= np.quantile(d, 0.9)].mean())


def analyse_window(frames: np.ndarray, times: np.ndarray) -> Window:
    n = len(frames)
    level = frames.mean(axis=(1, 2))
    std = frames.std(axis=(1, 2))
    usable = (level >= DARK_LEVEL) & (std >= FLAT_STD)
    norm = (frames - level[:, None, None]) / (std[:, None, None] + 1e-6)
    motion = np.zeros(n)
    shift = np.zeros((n, 2))
    diff: list[Optional[np.ndarray]] = [None] * n
    cuts: list[int] = []
    for i in range(1, n):
        if not (usable[i] and usable[i - 1]):
            continue
        dy, dx = _shift(norm[i], norm[i - 1])
        pa, pb, region = _aligned(norm[i], norm[i - 1], dy, dx)
        if _corr(pa, pb) < CUT_CORR:
            # A flash or a strobe frame comes back on the next frame; a cut doesn't.
            if i + 1 >= n or not usable[i + 1] or _corr(*_aligned(norm[i + 1], norm[i - 1], *_shift(norm[i + 1], norm[i - 1]))[:2]) < CUT_CORR:
                cuts.append(i)
                continue
        d = np.abs(_local_norm(pa) - _local_norm(pb))
        dt = max(float(times[i] - times[i - 1]), 1e-3)
        motion[i] = _top_mean(d) / dt
        shift[i] = (dy, dx)
        full = np.zeros((H, W), np.float32)
        full[region] = d
        diff[i] = full
    bounds = [0, *cuts, n]
    segments = [(a, b) for a, b in zip(bounds, bounds[1:]) if b > a]
    return Window(times, motion, shift, diff, np.where(usable, std, 0.0), segments)


def _smooth(x: np.ndarray, times: np.ndarray, seconds: float = 0.2) -> np.ndarray:
    fps = (len(times) - 1) / max(float(times[-1] - times[0]), 1e-3) if len(times) > 1 else 30.0
    k = max(1, int(round(seconds * fps)))
    return np.convolve(x, np.ones(k) / k, mode="same")


def _focus(win: Window, peak: int, seg: tuple[int, int]) -> tuple[float, float]:
    """Centroid of strong subject motion around the peak, kept away from the very edge."""
    near = [win.diff[i] for i in range(max(seg[0], peak - 6), min(seg[1], peak + 7)) if win.diff[i] is not None]
    if not near:
        return 0.5, 0.5
    weight = np.sum(near, axis=0) ** 2
    total = float(weight.sum())
    if total <= 1e-9:
        return 0.5, 0.5
    ys, xs = np.mgrid[0:H, 0:W]
    fx = float((weight * (xs + 0.5)).sum() / total / W)
    fy = float((weight * (ys + 0.5)).sum() / total / H)
    return round(min(max(fx, 0.2), 0.8), 3), round(min(max(fy, 0.2), 0.8), 3)


def _jerk(win: Window, a: int, b: int) -> float:
    s = win.shift[a + 1:b]
    return float(np.abs(np.diff(s, axis=0)).sum(axis=1).mean()) if len(s) > 2 else 0.0


def _pan(win: Window, a: int, b: int) -> float:
    s = win.shift[a + 1:b]
    seconds = max(float(win.times[b - 1] - win.times[a]), 1e-3)
    return float(np.hypot(*s.sum(axis=0)) / seconds) if len(s) else 0.0


def still(path: str, t: float, focus: tuple[float, float]) -> np.ndarray:
    """The frame at `t` as the full-screen 9:16 cover crop around `focus`, RGB 540x960."""
    fx, fy = focus
    crop = (f"crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)'"
            f":x='max(0,min(iw-ow,{fx}*iw-ow/2))':y='max(0,min(ih-oh,{fy}*ih-oh/2))'")
    res = ffmpeg_bin.run_bytes(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-an",
         "-vf", f"{crop},scale={SHARP_W}:{SHARP_H}:flags=bicubic,format=rgb24", "-f", "rawvideo", "-"],
        timeout=60,
    )
    if len(res.stdout) != SHARP_W * SHARP_H * 3:
        raise RuntimeError(f"could not render frame at {t:.2f}s of {path}")
    return np.frombuffer(res.stdout, dtype=np.uint8).reshape(SHARP_H, SHARP_W, 3).astype(np.float32) / 255.0


def blur(rgb: np.ndarray) -> float:
    """No-reference blur estimate, 0 = crisp .. 1 = mush (Crete-Roffet et al., "The Blur Effect", 2007):
    how much of the frame's local variation survives a further strong blur. Content-independent
    enough to compare a dark crowd shot with a bright stage shot."""
    g = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    k = 9
    worst = 0.0
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (k // 2, k // 2)
        c = np.cumsum(np.pad(g, pad, mode="edge"), axis=axis)
        c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
        n = g.shape[axis]
        blurred = (np.take(c, range(k, n + k), axis=axis) - np.take(c, range(0, n), axis=axis)) / k
        d_f = np.abs(np.diff(g, axis=axis))
        d_b = np.abs(np.diff(blurred, axis=axis))
        total = float(d_f.sum())
        if total > 1e-6:
            worst = max(worst, (total - float(np.maximum(d_f - d_b, 0).sum())) / total)
    return worst


def quality_of(rgb: np.ndarray) -> float:
    return round(min(max((BLUR_SOFT - blur(rgb)) / (BLUR_SOFT - BLUR_CRISP), 0.0), 1.0), 3)


def look_of(rgb: np.ndarray) -> np.ndarray:
    """Coarse colour layout: mean RGB of a 3x3 grid."""
    rows = np.array_split(rgb, 3, axis=0)
    return np.array([c.mean(axis=(0, 1)) for r in rows for c in np.array_split(r, 3, axis=1)]).ravel()


def refine_anchor(m: Moment) -> Optional[Shot]:
    start = max(0.0, m.t - WINDOW_PAD)
    frames, times = _decode(m.path, start, min(m.duration, m.t + WINDOW_PAD) - start)
    if len(frames) < 3:
        return None
    win = analyse_window(frames, times)
    smooth = _smooth(win.motion, times)
    best: Optional[tuple[int, tuple[int, int]]] = None
    for seg in win.segments:
        lo, hi = win.span(seg)
        if hi - lo < MIN_SPAN:
            continue
        # Only a real cut needs the margin; the window's own edges are not cuts.
        lo_ok = lo + (CUT_MARGIN if seg[0] > 0 else 0.0)
        hi_ok = hi - (CUT_MARGIN if seg[1] < len(times) else 0.0)
        idx = [i for i in range(*seg)
               if abs(times[i] - m.t) <= PEAK_SEARCH and lo_ok <= times[i] <= hi_ok and win.motion[i] > 0]
        if idx:
            peak = max(idx, key=lambda i: smooth[i])
            if best is None or smooth[peak] > smooth[best[0]]:
                best = (peak, seg)
    if best is None:
        return None
    peak, seg = best
    lo, hi = win.span(seg)
    anchor = float(times[peak])
    focus = _focus(win, peak, seg)
    rgb = still(m.path, anchor, focus)
    a, b = seg
    return Shot(
        path=m.path, anchor=round(anchor, 4),
        in_sec=round(max(lo, anchor - ANCHOR_PAD, 0.0), 4), out_sec=round(min(hi, anchor + ANCHOR_PAD, m.duration), 4),
        action=float(smooth[peak]), shake=_jerk(win, a, b), pan=_pan(win, a, b),
        contrast=float(win.contrast[a:b].mean()), quality=quality_of(rgb), focus=focus, look=look_of(rgb),
        duration=m.duration,
    )


def refine_calm(m: Moment) -> Optional[Shot]:
    """The steadiest cut-free BREATHER_LEN stretch near a calm keyframe."""
    pad = BREATHER_LEN / 2 + 1.0
    start = max(0.0, m.t - pad)
    frames, times = _decode(m.path, start, min(m.duration, m.t + pad) - start)
    if len(frames) < 3:
        return None
    win = analyse_window(frames, times)
    best: Optional[tuple[float, int, int]] = None
    for seg in win.segments:
        lo, hi = win.span(seg)
        if hi - lo < BREATHER_LEN - 1e-3:
            continue
        for i in range(seg[0], seg[1]):
            if times[i] + BREATHER_LEN > hi + 1e-3:
                break
            j = int(np.searchsorted(times, times[i] + BREATHER_LEN))
            cost = float(win.motion[i + 1:j].mean()) + _jerk(win, i, j) / SHAKE_REF
            if best is None or cost < best[0]:
                best = (cost, i, j)
    if best is None:
        return None
    _, i, j = best
    t0 = float(times[i])
    rgb = still(m.path, t0 + BREATHER_LEN / 2, (0.5, 0.5))
    return Shot(
        path=m.path, anchor=None, in_sec=round(t0, 4), out_sec=round(t0 + BREATHER_LEN, 4),
        action=float(win.motion[i + 1:j].mean()), shake=_jerk(win, i, j), pan=_pan(win, i, j),
        contrast=float(win.contrast[i:j].mean()), quality=quality_of(rgb), focus=(0.5, 0.5), look=look_of(rgb),
        duration=m.duration,
    )


def picks_allowed(duration: float) -> int:
    return int(min(MAX_PICKS_PER_FILE, max(1, round(duration * 0.8 / SECONDS_PER_PICK))))


def anchor_candidates(moments_per_file: list[list[Moment]], count: int) -> list[Moment]:
    """Spaced keyframes per file, every file's best first, capped at 2x count."""
    per_file = []
    for ms in moments_per_file:
        if not ms:
            continue
        spaced: list[Moment] = []
        for m in sorted(ms, key=lambda m: m.score, reverse=True):
            if all(abs(m.t - s.t) >= CANDIDATE_GAP for s in spaced):
                spaced.append(m)
                if len(spaced) == MAX_PICKS_PER_FILE:
                    break
        per_file.append(spaced)
    ordered = []
    for rank in range(MAX_PICKS_PER_FILE + 1):
        ordered += sorted((f[rank] for f in per_file if len(f) > rank), key=lambda m: m.score, reverse=True)
    return ordered[: 2 * count]


def pick_diverse(shots: list[Shot], count: int, value: Callable[[Shot], float]) -> list[Shot]:
    """Greedy: best value, discounted for files already used and for looks already in the set.

    Round 1 keeps to each file's allowance (longer files give more moments); round 2 tops up
    from the remaining moments when there aren't enough files to reach `count`.
    """
    chosen: list[Shot] = []
    per_file: Counter[str] = Counter()

    def discounted(s: Shot) -> float:
        v = value(s) * FILE_REPEAT ** per_file[s.path]
        if chosen:
            sim = max(float(np.exp(-np.mean((s.look - c.look) ** 2) / LOOK_SCALE)) for c in chosen)
            v *= 1 - LOOK_WEIGHT * sim
        return v

    for allowance in (picks_allowed, lambda _duration: MAX_PICKS_PER_FILE):
        remaining = [s for s in shots if s not in chosen]
        while remaining and len(chosen) < count:
            best = max(remaining, key=discounted)
            remaining.remove(best)
            same_file = [c for c in chosen if c.path == best.path]
            if len(same_file) >= allowance(best.duration):
                continue
            if any(c.out_sec > best.in_sec and best.out_sec > c.in_sec for c in same_file):
                continue  # overlapping moments of one file
            chosen.append(best)
            per_file[best.path] += 1
    return chosen


def _refine_all(fn: Callable[[Moment], Optional[Shot]], moments: list[Moment], phase: str, progress: Progress) -> list[Shot]:
    out: list[Shot] = []
    progress(phase, 0, len(moments))
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="harvest2") as pool:
        for k, shot in enumerate(pool.map(lambda m: _safe(fn, m), moments), 1):
            if shot:
                out.append(shot)
            progress(phase, k, len(moments))
    return out


def _safe(fn: Callable[[Moment], Optional[Shot]], m: Moment) -> Optional[Shot]:
    """One unreadable stretch shouldn't sink the harvest; that candidate is dropped."""
    try:
        return fn(m)
    except Exception as exc:  # noqa: BLE001
        log.warning("harvest v2: skipping %s @ %.2fs: %s", m.path, m.t, exc)
        return None


def select(moments_per_file: list[list[Moment]], count: int, breathers: int, progress: Progress) -> list[dict]:
    """Refine pass-1 candidates and pick `count` anchors plus `breathers` calm RANGE clips."""
    shots = _refine_all(refine_anchor, anchor_candidates(moments_per_file, count), "refining", progress) if count else []
    picks = pick_diverse(shots, count, lambda s: s.score)
    clips = []
    for rank, s in enumerate(sorted(picks, key=lambda s: s.action, reverse=True)):
        clips.append({"source_path": s.path, "mode": "ANCHOR", "energy_tag": motion_tag(rank, len(picks)),
                      "anchor_sec": s.anchor, "in_sec": s.in_sec, "out_sec": s.out_sec,
                      "focus_xy": list(s.focus), "quality": s.quality})

    # Breathers from files not already used: their calmest keyframe, best-looking first.
    used = {s.path for s in picks}
    calm = [min(ms, key=lambda m: m.motion) for ms in moments_per_file
            if ms and ms[0].path not in used and ms[0].duration >= BREATHER_LEN]
    calm.sort(key=lambda m: (m.motion, -m.contrast))
    calm_shots = _refine_all(refine_calm, calm[: 2 * breathers], "breathers", progress) if breathers else []
    for s in pick_diverse(calm_shots, breathers, lambda s: s.calm_score):
        clips.append({"source_path": s.path, "mode": "RANGE", "energy_tag": 0, "anchor_sec": None,
                      "in_sec": s.in_sec, "out_sec": s.out_sec, "focus_xy": list(s.focus), "quality": s.quality})
    return clips
