import { useEffect, useRef, useState } from 'react';
import { graphicsSchedule, loadLogoImages, logoRect } from '../lib/graphicsLayer';
import { useStore } from '../lib/store';
import type { Session } from '../types/session';

/** Areas Reels/TikTok cover: bottom quarter (captions, handle) and the right-edge button column. */
const UNSAFE_BOTTOM = 0.25;
const UNSAFE_RIGHT = 0.1;
const SNAP = 0.015;

interface Props {
  session: Session;
  timeRef: React.MutableRefObject<number>;
  children: React.ReactNode; // the preview canvas
}

/**
 * Wraps the preview canvas: logos visible at the current frame can be grabbed and dragged
 * anywhere. Hold Shift to snap to the centre lines. While dragging, the zones the app UI
 * covers are shaded.
 */
export default function LogoDrag({ session, timeRef, children }: Props) {
  const update = useStore((s) => s.update);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [dragging, setDragging] = useState(false);
  const logos = session.sequence.style.logos;

  useEffect(() => {
    void loadLogoImages(logos, images.current).catch(() => undefined); // the preview reports load errors
  }, [logos]);

  /** Index of the topmost logo visible now under the point (canvas fractions), or -1. */
  const hit = (fx: number, fy: number): number => {
    const [W, H] = session.resolution;
    const frame = Math.floor(timeRef.current * session.fps);
    const shown = new Set(
      graphicsSchedule(session)
        .filter((e) => e.kind === 'logo' && frame >= e.start && frame < e.end)
        .map((e) => (e.kind === 'logo' ? e.index : -1)),
    );
    for (let i = logos.length - 1; i >= 0; i--) {
      const img = images.current.get(logos[i].path);
      if (!img || !shown.has(i)) continue;
      const [x, y, w, h] = logoRect(logos[i], img.naturalWidth / Math.max(img.naturalHeight, 1), W, H);
      if (fx * W >= x && fx * W <= x + w && fy * H >= y && fy * H <= y + h) return i;
    }
    return -1;
  };

  const toFrac = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const [fx, fy] = toFrac(e);
    const index = hit(fx, fy);
    if (index < 0) return;
    e.preventDefault();
    const box = e.currentTarget;
    box.setPointerCapture(e.pointerId);
    const [W, H] = session.resolution;
    const img = images.current.get(logos[index].path);
    if (!img) return;
    const [x, y, w, h] = logoRect(logos[index], img.naturalWidth / Math.max(img.naturalHeight, 1), W, H);
    // Keep the grab point under the pointer.
    const offX = (x + w / 2) / W - fx;
    const offY = (y + h / 2) / H - fy;
    let first = true;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect();
      let cx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width + offX));
      let cy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height + offY));
      if (ev.shiftKey) {
        if (Math.abs(cx - 0.5) < SNAP * 3) cx = 0.5;
        if (Math.abs(cy - 0.5) < SNAP * 3) cy = 0.5;
      }
      update(
        (s) => ({
          ...s,
          sequence: {
            ...s.sequence,
            style: {
              ...s.sequence.style,
              logos: s.sequence.style.logos.map((l, j) => (j === index ? { ...l, placement: 'CUSTOM', x: round(cx), y: round(cy) } : l)),
            },
          },
        }),
        first, // one undo step per drag
      );
      first = false;
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      setDragging(false);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  };

  return (
    <div

      className="relative aspect-[9/16] h-full max-h-full"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (dragging) return;
        const [fx, fy] = toFrac(e);
        e.currentTarget.style.cursor = hit(fx, fy) >= 0 ? 'move' : 'default';
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 bottom-0 bg-red-500/25" style={{ height: `${UNSAFE_BOTTOM * 100}%` }} />
          <div className="absolute right-0 top-0 bg-red-500/25" style={{ width: `${UNSAFE_RIGHT * 100}%`, bottom: `${UNSAFE_BOTTOM * 100}%` }} />
          <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-white/40" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-white/40" />
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] text-red-200">covered by app UI · Shift = snap to centre</span>
        </div>
      )}
    </div>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
