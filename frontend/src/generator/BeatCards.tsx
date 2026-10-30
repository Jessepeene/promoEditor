import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { mediaUrl } from '../lib/api';
import { TAG_COLORS } from '../lib/dom';
import { useStore } from '../lib/store';
import { layoutRegions } from '../lib/timing';
import type { Clip, Slot } from '../types/session';
import { ZONE_COLORS } from './Timeline';

const SLIP_STEP = 2; // frames per wheel notch (±33 ms at 60 fps)
const MAX_THUMBS = 4;

export function durationLabel(slot: Slot): string {
  const d = slot.duration_beats;
  const frac: Record<number, string> = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' };
  const base = frac[d] ?? (Number.isInteger(d) ? String(d) : d.toFixed(2));
  if (slot.zone_type === 'VOCAL_BREATHER') return `${base}-Beat Breather`;
  return `${base} Beat${d > 1 ? 's' : ''}`;
}

const LAYOUT_NAME: Record<Slot['layout'], string> = {
  FULLSCREEN_VELOCITY: 'Full',
  STACK_3_ROW: '3-Stack',
  CENTER_PIP_PUNCH: 'PiP',
  STROBE_MATRIX: 'Matrix',
  SPLIT_2: 'Split',
};

export function LayoutIcon({ slot, size = 30 }: { slot: Slot; size?: number }) {
  const regions = layoutRegions(slot.layout, slot.layout_params, 1080, 1920);
  return (
    <svg width={(size * 9) / 16} height={size} viewBox="0 0 1080 1920" className="shrink-0">
      {Object.entries(regions).map(([name, [x, y, w, h]]) => (
        <rect
          key={name}
          x={x + 30}
          y={y + 30}
          width={w - 60}
          height={h - 60}
          rx={40}
          fill={name === 'pip' ? '#fbbf24' : '#3f3f56'}
          stroke="#a1a1aa"
          strokeWidth={30}
        />
      ))}
    </svg>
  );
}

interface CardProps {
  slot: Slot;
  clips: Map<string, Clip>;
  active: boolean;
  selected: boolean;
  onSelect: (slot: Slot) => void;
  onHover: (slotId: string | null) => void;
  onToggleLock: (slotId: string) => void;
}

const Card = memo(function Card({ slot, clips, active, selected, onSelect, onHover, onToggleLock }: CardProps) {
  const shown = slot.cells.slice(0, MAX_THUMBS);
  return (
    <div
      data-slot={slot.slot_id}
      className={`relative flex shrink-0 cursor-pointer flex-col gap-1 rounded-md border bg-ink-850 p-1.5 ${
        selected ? 'border-white' : active ? 'border-rose-500' : 'border-ink-700 hover:border-ink-600'
      }`}
      style={{ width: Math.max(104, Math.min(240, slot.duration_beats * 60)) }}
      onClick={() => onSelect(slot)}
      onMouseEnter={() => onHover(slot.slot_id)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="absolute left-0 right-0 top-0 h-1 rounded-t-md" style={{ background: ZONE_COLORS[slot.zone_type] }} />
      <div className="flex items-center gap-1.5 pt-0.5 text-[10px]">
        <LayoutIcon slot={slot} size={22} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-mono font-semibold text-zinc-200">B{slot.start_beat}</div>
          <div className="truncate text-zinc-400">{durationLabel(slot)}</div>
          <div className="text-zinc-500">{LAYOUT_NAME[slot.layout]}</div>
        </div>
        <button
          className={`self-start rounded px-1 text-sm ${slot.locked ? 'bg-amber-500/20' : 'opacity-40 hover:opacity-100'}`}
          title={slot.locked ? 'Locked: kept on reroll' : 'Lock this card'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleLock(slot.slot_id);
          }}
        >
          {slot.locked ? '🔒' : '🔓'}
        </button>
      </div>
      <div className="flex gap-0.5">
        {shown.map((cell, i) => {
          const clip = clips.get(cell.clip_id);
          return (
            <div
              key={i}
              data-cell={i}
              data-clip-id={cell.clip_id}
              title={`${cell.clip_id} · ${cell.region} · scroll to slip (${cell.slip_frames >= 0 ? '+' : ''}${cell.slip_frames}f)`}
              className="relative h-[34px] flex-1 overflow-hidden rounded-sm bg-ink-700"
            >
              {clip?.thumb_path && (
                <img src={mediaUrl(clip.thumb_path, clip.in_sec)} className="h-full w-full object-cover" alt="" draggable={false} />
              )}
              {clip && <span className="absolute bottom-0 left-0 h-0.5 w-full" style={{ background: TAG_COLORS[clip.energy_tag] }} />}
              {cell.slip_frames !== 0 && (
                <span className="absolute right-0 top-0 bg-black/70 px-0.5 font-mono text-[8px] text-amber-300">
                  {cell.slip_frames > 0 ? '+' : ''}
                  {cell.slip_frames}
                </span>
              )}
            </div>
          );
        })}
        {slot.cells.length > MAX_THUMBS && (
          <div className="flex w-5 items-center justify-center text-[9px] text-zinc-500">+{slot.cells.length - MAX_THUMBS}</div>
        )}
        {slot.cells.length === 0 && <div className="h-[34px] flex-1 rounded-sm border border-dashed border-ink-600" />}
      </div>
    </div>
  );
});

interface Props {
  slots: Slot[];
  clips: Clip[];
  activeSlotId: string | null;
  selectedSlotId: string | null;
  onSelect: (slot: Slot) => void;
  onHover: (slotId: string | null) => void;
}

export default function BeatCards({ slots, clips, activeSlotId, selectedSlotId, onSelect, onHover }: Props) {
  const update = useStore((s) => s.update);
  const ribbonRef = useRef<HTMLDivElement>(null);
  const clipMap = useMemo(() => new Map(clips.map((c) => [c.clip_id, c])), [clips]);

  const toggleLock = useCallback(
    (slotId: string) =>
      update(
        (s) => ({
          ...s,
          sequence: {
            ...s.sequence,
            slots: s.sequence.slots.map((sl) => (sl.slot_id === slotId ? { ...sl, locked: !sl.locked } : sl)),
          },
        }),
        true,
      ),
    [update],
  );

  // Wheel over a thumbnail slips that cell's anchor; elsewhere it scrolls the ribbon.
  // Native listener because React's wheel handler is passive and can't preventDefault.
  useEffect(() => {
    const el = ribbonRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.target instanceof Element)) return;
      const cellEl = e.target.closest<HTMLElement>('[data-cell]');
      const slotEl = e.target.closest<HTMLElement>('[data-slot]');
      e.preventDefault();
      if (!cellEl || !slotEl) {
        el.scrollLeft += e.deltaY + e.deltaX;
        return;
      }
      const slotId = slotEl.dataset.slot;
      const index = Number(cellEl.dataset.cell);
      const delta = e.deltaY < 0 ? SLIP_STEP : -SLIP_STEP;
      update((s) => ({
        ...s,
        sequence: {
          ...s.sequence,
          slots: s.sequence.slots.map((sl) =>
            sl.slot_id === slotId
              ? { ...sl, cells: sl.cells.map((c, i) => (i === index ? { ...c, slip_frames: c.slip_frames + delta } : c)) }
              : sl,
          ),
        },
      }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update]);

  // Keep the playing card in view.
  useEffect(() => {
    if (!activeSlotId) return;
    const card = ribbonRef.current?.querySelector<HTMLElement>(`[data-slot="${activeSlotId}"]`);
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSlotId]);

  return (
    <div ref={ribbonRef} className="flex gap-1.5 overflow-x-auto bg-ink-900 p-2">
      {slots.length === 0 && (
        <div className="p-4 text-xs text-zinc-500">
          No Beat Cards yet. Set up zones, then press <span className="kbd">R</span> to roll.
        </div>
      )}
      {slots.map((slot) => (
        <Card
          key={slot.slot_id}
          slot={slot}
          clips={clipMap}
          active={slot.slot_id === activeSlotId}
          selected={slot.slot_id === selectedSlotId}
          onSelect={onSelect}
          onHover={onHover}
          onToggleLock={toggleLock}
        />
      ))}
    </div>
  );
}
