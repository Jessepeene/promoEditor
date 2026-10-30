import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WaveformData } from '../lib/api';
import { useStore } from '../lib/store';
import { beatDuration, promoEndBeat } from '../lib/timing';
import type { Session, Zone, ZoneType } from '../types/session';

export const ZONE_COLORS: Record<ZoneType, string> = {
  INTRO_STORY: '#0ea5e9',
  STUTTER_BUILD: '#f59e0b',
  VOCAL_BREATHER: '#a855f7',
  HYBRID_DROP: '#f43f5e',
  OUTRO: '#22c55e',
};

export const ZONE_LABELS: Record<ZoneType, string> = {
  INTRO_STORY: 'Intro story',
  STUTTER_BUILD: 'Stutter build',
  VOCAL_BREATHER: 'Vocal breather',
  HYBRID_DROP: 'Hybrid drop',
  OUTRO: 'End card',
};

const LAYOUT_COLORS: Record<string, string> = {
  FULLSCREEN_VELOCITY: '#e4e4e7',
  STACK_3_ROW: '#38bdf8',
  CENTER_PIP_PUNCH: '#fbbf24',
  STROBE_MATRIX: '#e879f9',
  SPLIT_2: '#34d399',
};

const RULER_H = 18;
const WAVE_H = 84;
const ZONE_H = 26;
const STRIP_H = 10;

interface Props {
  session: Session;
  waveform: WaveformData | null;
  timeRef: React.MutableRefObject<number>;
  onSeek: (promoSec: number) => void;
  selectedZone: number | null;
  onSelectZone: (i: number | null) => void;
}

type ZoneDrag = { index: number; mode: 'move' | 'start' | 'end'; x0: number; zone: Zone; snapshotted: boolean };

export default function Timeline({ session, waveform, timeRef, onSeek, selectedZone, onSelectZone }: Props) {
  const update = useStore((s) => s.update);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [ppb, setPpb] = useState(22); // pixels per beat
  const [viewStart, setViewStart] = useState(-2);

  const seq = session.sequence;
  const bd = beatDuration(seq.bpm);
  const audioStartBeat = -seq.beat_1_offset_sec / bd;
  const audioEndBeat = waveform ? (waveform.duration - seq.beat_1_offset_sec) / bd : 0;
  const maxBeat = Math.max(promoEndBeat(session) + 8, audioEndBeat, 32);
  const minBeat = Math.min(-2, audioStartBeat);
  const xOf = (beat: number) => (beat - viewStart) * ppb;
  const beatOf = (x: number) => viewStart + x / ppb;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel: scroll in time; Ctrl/⌘+wheel zooms around the cursor. Needs a non-passive listener.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) {
        setPpb((p) => {
          const next = Math.min(160, Math.max(4, p * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          setViewStart((v) => v + x / p - x / next);
          return next;
        });
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setViewStart((v) => Math.min(Math.max(v + delta / ppb, minBeat), maxBeat));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ppb, minBeat, maxBeat]);

  // Waveform + grid.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const h = RULER_H + WAVE_H;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    for (const z of seq.zones) {
      ctx.fillStyle = `${ZONE_COLORS[z.type]}18`;
      ctx.fillRect(xOf(z.start_beat), RULER_H, (z.end_beat - z.start_beat) * ppb, WAVE_H);
    }
    if (waveform) {
      const mid = RULER_H + WAVE_H / 2;
      ctx.fillStyle = '#71717a';
      const secPerPx = bd / ppb;
      for (let x = 0; x < width; x++) {
        const t0 = seq.beat_1_offset_sec + beatOf(x) * bd;
        const i0 = Math.floor(t0 * waveform.peaks_per_sec);
        const i1 = Math.max(i0 + 1, Math.floor((t0 + secPerPx) * waveform.peaks_per_sec));
        if (i1 <= 0 || i0 >= waveform.peaks.length) continue;
        let peak = 0;
        for (let i = Math.max(0, i0); i < Math.min(i1, waveform.peaks.length); i++) peak = Math.max(peak, waveform.peaks[i]);
        const hh = peak * (WAVE_H / 2 - 2);
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
    // Beat / bar grid and bar numbers (bar 1 starts at beat 0).
    const first = Math.floor(viewStart);
    ctx.font = '10px Inter, sans-serif';
    for (let b = first; b <= beatOf(width); b++) {
      const x = Math.round(xOf(b)) + 0.5;
      const bar = b % 4 === 0;
      if (!bar && ppb < 8) continue;
      ctx.strokeStyle = bar ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(x, bar ? 0 : RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (bar && (ppb >= 10 || (b / 4) % 4 === 0)) {
        ctx.fillStyle = '#a1a1aa';
        ctx.fillText(String(b / 4 + 1), x + 3, 12);
      }
    }
    const dx = Math.round(xOf(seq.drop_beat_index)) + 0.5;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx, 0);
    ctx.lineTo(dx, h);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(dx, 0, 74, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(`DROP (beat ${seq.drop_beat_index})`, dx + 3, 11);
  }, [width, ppb, viewStart, waveform, seq.zones, seq.beat_1_offset_sec, seq.bpm, seq.drop_beat_index]);

  // Playhead follows the clock without re-rendering React.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = playheadRef.current;
      if (el) el.style.transform = `translateX(${xOf(timeRef.current / bd)}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewStart, ppb, bd]);

  // --- waveform drag (aligns the song to the grid) / click to seek ----------
  const onWavePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const x0 = e.clientX;
    const offset0 = seq.beat_1_offset_sec;
    const rectLeft = e.currentTarget.getBoundingClientRect().left;
    let dragging = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!dragging && Math.abs(dx) < 3) return;
      // Dragging the audio right by Δ beats moves its beat-0 earlier in the track.
      const offset = Math.round((offset0 - (dx / ppb) * bd) * 1000) / 1000;
      update((s) => ({ ...s, sequence: { ...s.sequence, beat_1_offset_sec: offset } }), !dragging);
      dragging = true;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragging) onSeek(Math.max(0, beatOf(ev.clientX - rectLeft)) * bd);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- zones ----------------------------------------------------------------
  const zones = [...seq.zones].sort((a, b) => a.start_beat - b.start_beat);
  const onZonePointerDown = (e: React.PointerEvent, index: number, mode: ZoneDrag['mode']) => {
    e.stopPropagation();
    onSelectZone(index);
    const drag: ZoneDrag = { index, mode, x0: e.clientX, zone: zones[index], snapshotted: false };
    const prevEnd = index > 0 ? zones[index - 1].end_beat : 0;
    const nextStart = index < zones.length - 1 ? zones[index + 1].start_beat : Infinity;
    const move = (ev: PointerEvent) => {
      const step = ev.altKey ? 0.25 : 1;
      const d = Math.round((ev.clientX - drag.x0) / ppb / step) * step;
      if (d === 0 && !drag.snapshotted) return;
      const { start_beat: s0, end_beat: e0 } = drag.zone;
      let start = s0;
      let end = e0;
      if (drag.mode === 'move') {
        const len = e0 - s0;
        start = Math.min(Math.max(s0 + d, prevEnd), nextStart - len);
        end = start + len;
      } else if (drag.mode === 'start') {
        start = Math.min(Math.max(s0 + d, prevEnd), e0 - step);
      } else {
        end = Math.max(Math.min(e0 + d, nextStart), s0 + step);
      }
      const next = zones.map((z, i) => (i === index ? { ...z, start_beat: start, end_beat: end } : z));
      update((s) => ({ ...s, sequence: { ...s.sequence, zones: next } }), !drag.snapshotted);
      drag.snapshotted = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={wrapRef} className="relative select-none overflow-hidden border-y border-ink-700 bg-ink-950">
      <canvas
        ref={canvasRef}
        className="block"
        onPointerDown={(e) => {
          const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
          if (y < RULER_H) onSeek(Math.max(0, beatOf(e.clientX - e.currentTarget.getBoundingClientRect().left)) * bd);
        }}
      />
      {/* Waveform drag surface sits over the wave area only, so the ruler stays a seek bar. */}
      <div
        className="absolute left-0 right-0 cursor-grab active:cursor-grabbing"
        style={{ top: RULER_H, height: WAVE_H }}
        title="Drag to line the drop kick up with the red DROP marker · click to seek"
        onPointerDown={onWavePointerDown}
      />
      {!waveform && (
        <div className="pointer-events-none absolute left-3 text-xs text-zinc-500" style={{ top: RULER_H + 30 }}>
          No audio loaded — choose a track above.
        </div>
      )}
      <div className="relative" style={{ height: ZONE_H }}>
        {zones.map((z, i) => (
          <div
            key={`${i}-${z.start_beat}`}
            className={`absolute top-0.5 flex h-[22px] cursor-move items-center overflow-hidden rounded text-[10px] font-semibold text-white ${
              selectedZone === i ? 'ring-2 ring-white' : ''
            }`}
            style={{ left: xOf(z.start_beat), width: (z.end_beat - z.start_beat) * ppb, background: `${ZONE_COLORS[z.type]}cc` }}
            onPointerDown={(e) => onZonePointerDown(e, i, 'move')}
          >
            <span
              className="h-full w-1.5 shrink-0 cursor-ew-resize bg-black/30"
              onPointerDown={(e) => onZonePointerDown(e, i, 'start')}
            />
            <span className="flex-1 truncate px-1">{ZONE_LABELS[z.type]}</span>
            <span
              className="h-full w-1.5 shrink-0 cursor-ew-resize bg-black/30"
              onPointerDown={(e) => onZonePointerDown(e, i, 'end')}
            />
          </div>
        ))}
      </div>
      <div className="relative" style={{ height: STRIP_H }}>
        {seq.slots.map((s) => (
          <div
            key={s.slot_id}
            className="absolute top-0 h-[7px] border-r border-ink-950"
            style={{
              left: xOf(s.start_beat),
              width: Math.max(1, s.duration_beats * ppb),
              background: LAYOUT_COLORS[s.layout],
              opacity: s.locked ? 1 : 0.55,
            }}
          />
        ))}
      </div>
      <div ref={playheadRef} className="pointer-events-none absolute left-0 top-0 h-full w-px bg-white" />
    </div>
  );
}
