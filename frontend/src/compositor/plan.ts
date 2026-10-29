// Precomputed render plan: per slot frame ranges and per cell timing/rects.
// Rebuilt whenever the session object changes.

import type { Cell, Clip, Session, Slot } from '../types/session';
import { beatToFrame, cellTiming, layoutRegions, promoFrameCount, type CellTiming, type Rect } from '../lib/timing';

/** Matches compiler.XFADE_FRAMES. */
export const XFADE_FRAMES = 8;

export interface PlannedCell {
  key: string;
  cell: Cell;
  clip: Clip;
  timing: CellTiming;
  rect: Rect;
  /** Paint order: background regions first, PiP last. */
  layer: number;
  /** Last cell in its region, so it may run on into a crossfade tail. */
  reachesSlotEnd: boolean;
}

export interface PlannedSlot {
  slot: Slot;
  index: number;
  startFrame: number;
  endFrame: number;
  cells: PlannedCell[];
}

export interface Plan {
  slots: PlannedSlot[];
  totalFrames: number;
}

export function buildPlan(session: Session): Plan {
  const { bpm } = session.sequence;
  const fps = session.fps;
  const [W, H] = session.resolution;
  const clips = new Map(session.clips.map((c) => [c.clip_id, c]));
  const slots = [...session.sequence.slots].sort((a, b) => a.start_beat - b.start_beat);
  const out: PlannedSlot[] = slots.map((slot, index) => {
    const regions = layoutRegions(slot.layout, slot.layout_params, W, H);
    const startFrame = beatToFrame(slot.start_beat, bpm, fps);
    const endFrame = beatToFrame(slot.start_beat + slot.duration_beats, bpm, fps);
    const cells: PlannedCell[] = [];
    slot.cells.forEach((cell, i) => {
      const clip = clips.get(cell.clip_id);
      const rect = regions[cell.region];
      if (!clip || !rect) return;
      const timing = cellTiming(session, slot, cell, clip);
      cells.push({
        key: `${slot.slot_id}#${i}`,
        cell,
        clip,
        timing,
        rect,
        layer: cell.region === 'pip' ? 1 : 0,
        // Same rule as the export: background cells run on into a crossfade tail, PiP doesn't.
        reachesSlotEnd: cell.region !== 'pip' && timing.endFrame >= endFrame,
      });
    });
    cells.sort((a, b) => a.layer - b.layer);
    return { slot, index, startFrame, endFrame, cells };
  });
  return { slots: out, totalFrames: promoFrameCount(session) };
}

/** Slot showing at `frame` (binary search), or null in a gap. */
export function slotAt(plan: Plan, frame: number): PlannedSlot | null {
  let lo = 0;
  let hi = plan.slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = plan.slots[mid];
    if (frame < s.startFrame) hi = mid - 1;
    else if (frame >= s.endFrame) lo = mid + 1;
    else return s;
  }
  return null;
}

/** Cells visible at `frame`. With `extended`, cells that reach the slot end keep running (crossfade tail). */
export function activeCells(ps: PlannedSlot, frame: number, extended = false): PlannedCell[] {
  return ps.cells.filter(
    (c) => frame >= c.timing.startFrame && (frame < c.timing.endFrame || (extended && c.reachesSlotEnd)),
  );
}
