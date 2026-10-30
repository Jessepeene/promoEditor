// Beat-grid math, layout regions and anchor-locked time remapping.
// Line-for-line port of backend/promo_server/timing.py: the canvas preview and the
// ffmpeg export must agree, which timing.test.ts checks against the shared fixture.

import type { Cell, Clip, LayoutParams, LayoutType, Session, Slot } from '../types/session';

export const RAMP_HEAD_SPEED = 2.2;
export const RAMP_MID_SPEED = 0.7;
export const RAMP_TAIL_SPEED = 2.5;
export const RAMP_HEAD_FRAMES = 3;
export const RAMP_TAIL_FRAMES = 4;
export const RAMP_EASE_FRAC = 0.18;
export const RAMP_MIN_FRAMES = 16;
export const MIN_FIT_SCALE = 0.25;

export const BOUNCE_AMP = 0.14;
export const BOUNCE_DECAY = 12;

export const beatDuration = (bpm: number) => 60 / bpm;

/** Python's round-half-up via floor(x + 0.5); Math.round matches for positives. */
const roundHalfUp = (x: number) => Math.floor(x + 0.5);

export function beatToFrame(beat: number, bpm: number, fps: number): number {
  return roundHalfUp(beat * beatDuration(bpm) * fps);
}

export function audioTimeOfBeat(beat: number, bpm: number, beat1OffsetSec: number): number {
  return beat1OffsetSec + beat * beatDuration(bpm);
}

export function bounceScale(t: number): number {
  return 1 + BOUNCE_AMP * Math.exp(-BOUNCE_DECAY * Math.max(t, 0));
}

// --- per-cell motion: push (slow zoom) and impact shake ---------------------------
export const PUSH_AMP = 0.1;
/** Shake needs headroom: at this zoom the window can move ±1.9% before showing an edge. */
export const SHAKE_BASE_ZOOM = 1.04;
export const SHAKE_AMP_X = 0.012;
export const SHAKE_AMP_Y = 0.01;
export const SHAKE_DECAY = 9;
export const SHAKE_FREQ_X = 13;
export const SHAKE_FREQ_Y = 17;

// --- slot-level looks (shared with the export's post chain) -----------------------
export const DIM_LEVEL = 0.55;
export const INVERT_FRAMES = 2;
export const STROBE_FRAMES = 16;
export const ECHO_DECAY = 0.82;

/** Black on frames 2-3, 6-7, ... of the slot's first STROBE_FRAMES (export: drawbox enable). */
export const strobeBlack = (localFrame: number) =>
  localFrame < STROBE_FRAMES && Math.floor(localFrame / 2) % 2 === 1;

/** Zoom of a cell `t` seconds after it appears (`dur` = its nominal length). */
export function cellZoom(t: number, dur: number, bounce: boolean, push: 'NONE' | 'IN' | 'OUT', shake: boolean): number {
  let z = bounce ? bounceScale(t) : 1;
  if (push !== 'NONE' && dur > 0) {
    const x = Math.min(Math.max(t / dur, 0), 1);
    z *= 1 + PUSH_AMP * (push === 'IN' ? x : 1 - x);
  }
  if (shake) z *= SHAKE_BASE_ZOOM;
  return z;
}

/** Shake displacement as fractions of the cell size. */
export function shakeOffset(t: number): [number, number] {
  const env = Math.exp(-SHAKE_DECAY * Math.max(t, 0));
  return [
    SHAKE_AMP_X * env * Math.sin(2 * Math.PI * SHAKE_FREQ_X * t),
    SHAKE_AMP_Y * env * Math.sin(2 * Math.PI * SHAKE_FREQ_Y * t),
  ];
}

// ---------------------------------------------------------------------------
// Layout regions
// ---------------------------------------------------------------------------

export type Rect = [x: number, y: number, w: number, h: number];

function evenSplit(total: number, parts: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < parts; i++) out.push(2 * roundHalfUp((i * total) / parts / 2));
  out.push(total);
  return out;
}

export function matrixDims(kind: string): [cols: number, rows: number] {
  const [c, r] = kind.split('x').map(Number);
  return [c, r];
}

export function layoutRegions(layout: LayoutType, params: LayoutParams, width: number, height: number): Record<string, Rect> {
  switch (layout) {
    case 'FULLSCREEN_VELOCITY':
      return { full: [0, 0, width, height] };
    case 'STACK_3_ROW': {
      const ys = evenSplit(height, 3);
      const out: Record<string, Rect> = {};
      for (let i = 0; i < 3; i++) out[`row${i}`] = [0, ys[i], width, ys[i + 1] - ys[i]];
      return out;
    }
    case 'CENTER_PIP_PUNCH': {
      const bg = params.pip_background === 'STACK' ? 'STACK_3_ROW' : 'FULLSCREEN_VELOCITY';
      const regions = layoutRegions(bg, params, width, height);
      const pw = 2 * roundHalfUp((width * 0.6) / 2);
      const ph = params.pip_aspect === '1:1' ? pw : 2 * roundHalfUp((pw * 0.75) / 2);
      const x = Math.floor(Math.floor((width - pw) / 2) / 2) * 2;
      const y = Math.floor(Math.floor((height - ph) / 2) / 2) * 2;
      regions.pip = [x, y, pw, ph];
      return regions;
    }
    case 'SPLIT_2': {
      const out: Record<string, Rect> = {};
      if (params.split === 'COLS') {
        const xs = evenSplit(width, 2);
        for (let i = 0; i < 2; i++) out[`half${i}`] = [xs[i], 0, xs[i + 1] - xs[i], height];
      } else {
        const ys = evenSplit(height, 2);
        for (let i = 0; i < 2; i++) out[`half${i}`] = [0, ys[i], width, ys[i + 1] - ys[i]];
      }
      return out;
    }
    case 'STROBE_MATRIX': {
      const [cols, rows] = matrixDims(params.matrix);
      const xs = evenSplit(width, cols);
      const ys = evenSplit(height, rows);
      const out: Record<string, Rect> = {};
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) out[`m${r * cols + c}`] = [xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]];
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Speed ramp
// ---------------------------------------------------------------------------

const smoothstepIntegral = (x: number) => x ** 3 - 0.5 * x ** 4;

export interface RampShape {
  n: number;
  head: number;
  ease: number;
  midEnd: number;
  tailStart: number;
}

export function rampShape(nFrames: number): RampShape {
  const head = RAMP_HEAD_FRAMES;
  const tail = RAMP_TAIL_FRAMES;
  let ease = Math.max(2, RAMP_EASE_FRAC * nFrames);
  const tailStart = nFrames - tail;
  const room = tailStart - head;
  if (2 * ease > room) ease = Math.max(room / 2, 0);
  return { n: nFrames, head, ease, midEnd: tailStart - ease, tailStart };
}

export function rampSpeed(f: number, s: RampShape): number {
  if (f < s.head) return RAMP_HEAD_SPEED;
  if (f < s.head + s.ease) {
    const u = (f - s.head) / s.ease;
    return RAMP_HEAD_SPEED + (RAMP_MID_SPEED - RAMP_HEAD_SPEED) * (3 * u * u - 2 * u ** 3);
  }
  if (f < s.midEnd) return RAMP_MID_SPEED;
  if (f < s.tailStart) {
    const u = (f - s.midEnd) / s.ease;
    return RAMP_MID_SPEED + (RAMP_TAIL_SPEED - RAMP_MID_SPEED) * (3 * u * u - 2 * u ** 3);
  }
  return RAMP_TAIL_SPEED;
}

export function rampPosition(fIn: number, s: RampShape): number {
  const f = Math.max(0, fIn);
  let pos = RAMP_HEAD_SPEED * Math.min(f, s.head);
  if (f <= s.head) return pos;
  if (s.ease > 0) {
    const x = Math.min(f - s.head, s.ease) / s.ease;
    pos += s.ease * (RAMP_HEAD_SPEED * x + (RAMP_MID_SPEED - RAMP_HEAD_SPEED) * smoothstepIntegral(x));
  }
  if (f <= s.head + s.ease) return pos;
  pos += RAMP_MID_SPEED * (Math.min(f, s.midEnd) - (s.head + s.ease));
  if (f <= s.midEnd) return pos;
  if (s.ease > 0) {
    const x = Math.min(f - s.midEnd, s.ease) / s.ease;
    pos += s.ease * (RAMP_MID_SPEED * x + (RAMP_TAIL_SPEED - RAMP_MID_SPEED) * smoothstepIntegral(x));
  }
  if (f <= s.tailStart) return pos;
  pos += RAMP_TAIL_SPEED * (f - s.tailStart);
  return pos;
}

// ---------------------------------------------------------------------------
// Cell -> source time mapping
// ---------------------------------------------------------------------------

export interface CellTiming {
  startFrame: number;
  endFrame: number;
  anchor: number;
  lockFrame: number;
  ramp: RampShape | null;
  speed: number;
  scale: number;
  lo: number;
  hi: number;
}

const profilePos = (f: number, ramp: RampShape | null, speed: number) =>
  ramp ? rampPosition(f, ramp) : speed * Math.max(f, 0);

export function cellEndBeat(slot: Slot, cell: Cell): number {
  return cell.end == null ? slot.duration_beats : Math.min(cell.end, slot.duration_beats);
}

export function cellTiming(session: Session, slot: Slot, cell: Cell, clip: Clip): CellTiming {
  const { bpm } = session.sequence;
  const fps = session.fps;
  const startFrame = beatToFrame(slot.start_beat + cell.start, bpm, fps);
  const endFrame = Math.max(startFrame + 1, beatToFrame(slot.start_beat + cellEndBeat(slot, cell), bpm, fps));
  const n = endFrame - startFrame;

  const slip = cell.slip_frames / fps;
  const lo = clip.in_sec;
  const hi = clip.out_sec;
  let anchor: number;
  let lockFrame: number;
  if (clip.mode === 'RANGE' || clip.anchor_sec == null) {
    anchor = clip.in_sec + slip;
    lockFrame = 0;
  } else {
    anchor = clip.anchor_sec + slip;
    lockFrame = cell.anchor_lock === 'DOWNBEAT' ? 0 : n / 2;
  }

  const useRamp = slot.fx.speed_ramp && clip.mode === 'ANCHOR' && cell.region === 'full' && n >= RAMP_MIN_FRAMES;
  const ramp = useRamp ? rampShape(n) : null;
  const speed = useRamp ? 1 : slot.fx.speed;

  const needPre = (profilePos(lockFrame, ramp, speed) - profilePos(0, ramp, speed)) / fps;
  const needPost = (profilePos(n, ramp, speed) - profilePos(lockFrame, ramp, speed)) / fps;
  let scale = 1;
  if (needPre > 1e-9) scale = Math.min(scale, Math.max(anchor - lo, 0) / needPre);
  if (needPost > 1e-9) scale = Math.min(scale, Math.max(hi - anchor, 0) / needPost);
  scale = Math.max(scale, MIN_FIT_SCALE);
  return { startFrame, endFrame, anchor, lockFrame, ramp, speed, scale, lo, hi };
}

export function sourceTime(t: CellTiming, localFrame: number, fps: number): number {
  const pos = profilePos(localFrame, t.ramp, t.speed) - profilePos(t.lockFrame, t.ramp, t.speed);
  const s = t.anchor + (t.scale * pos) / fps;
  return Math.min(Math.max(s, t.lo), t.hi);
}

/** Instantaneous playback rate (source seconds per output second) — drives <video>.playbackRate. */
export function sourceRate(t: CellTiming, localFrame: number): number {
  return (t.ramp ? rampSpeed(localFrame, t.ramp) : t.speed) * t.scale;
}

export function promoEndBeat(session: Session): number {
  let end = 0;
  for (const z of session.sequence.zones) end = Math.max(end, z.end_beat);
  for (const s of session.sequence.slots) end = Math.max(end, s.start_beat + s.duration_beats);
  return end;
}

export function promoFrameCount(session: Session): number {
  return beatToFrame(promoEndBeat(session), session.sequence.bpm, session.fps);
}
