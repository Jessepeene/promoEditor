import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compositor } from '../compositor/Compositor';
import { api, mediaUrl, type WaveformData } from '../lib/api';
import { mixToMono, onsetEnvelope } from '../lib/bpm';
import { isTypingTarget, TAG_NAMES } from '../lib/dom';
import { cycleLayout, solve } from '../lib/solver';
import { flushSave, useStore } from '../lib/store';
import { beatDuration, beatToFrame, promoFrameCount } from '../lib/timing';
import { bumpTier } from '../lib/tiers';
import { Transport } from '../lib/transport';
import type { Sequence, Session, Slot } from '../types/session';
import BeatCards from './BeatCards';
import ClipLibrary from './ClipLibrary';
import LogoDrag from './LogoDrag';
import SidePanel, { type Tab } from './SidePanel';
import Timeline from './Timeline';
import TransportBar from './TransportBar';

const EPS = 1e-6;

/** True when the Beat Cards exactly tile every zone (i.e. no zone edits since the last roll). */
function slotsMatchZones(seq: Sequence): boolean {
  for (const z of seq.zones) {
    const inZone = seq.slots
      .filter((s) => s.start_beat >= z.start_beat - EPS && s.start_beat < z.end_beat - EPS)
      .sort((a, b) => a.start_beat - b.start_beat);
    let t = z.start_beat;
    for (const s of inZone) {
      if (Math.abs(s.start_beat - t) > EPS || s.zone_type !== z.type) return false;
      t = s.start_beat + s.duration_beats;
    }
    if (Math.abs(t - z.end_beat) > EPS) return false;
  }
  return true;
}

export default function GeneratorView() {
  const session = useStore((s) => s.session);
  const update = useStore((s) => s.update);
  const setError = useStore((s) => s.setError);

  const transport = useMemo(() => new Transport(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [hq, setHq] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('style');
  const hoveredSlot = useRef<string | null>(null);

  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [audio, setAudio] = useState<AudioBuffer | null>(null);
  const [onsetEnv, setOnsetEnv] = useState<Float32Array | null>(null);
  const [audioStatus, setAudioStatus] = useState<string | null>(null);

  const audioPath = session?.sequence.audio_path ?? null;
  const offset = session?.sequence.beat_1_offset_sec ?? 0;

  useEffect(() => () => transport.dispose(), [transport]);
  useEffect(() => transport.setOffset(offset), [transport, offset]);

  // --- audio track ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    setAudio(null);
    setOnsetEnv(null);
    if (!audioPath) {
      transport.clearAudio();
      return;
    }
    setAudioStatus('Loading track…');
    (async () => {
      try {
        // The server only serves files the saved manifest references.
        await flushSave();
        const [wave, buffer] = await Promise.all([api.waveform(audioPath), transport.loadAudio(mediaUrl(audioPath))]);
        if (cancelled) return;
        setWaveform(wave);
        setAudio(buffer);
        setOnsetEnv(onsetEnvelope(mixToMono(buffer), buffer.sampleRate));
        setAudioStatus(null);
      } catch (e) {
        if (cancelled) return;
        setAudioStatus('Track failed to load');
        setError(`Could not load ${audioPath}: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioPath, transport, setError]);

  // --- compositor + clock loop -------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let comp: Compositor;
    try {
      comp = new Compositor(canvas);
    } catch (e) {
      setError(`Preview unavailable: ${(e as Error).message}`);
      return;
    }
    let raf = 0;
    let lastActive: string | null = null;
    let lastBuffering = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = useStore.getState().session;
      if (!s) return;
      const [W, H] = s.resolution;
      const scale = hq ? 1 : 0.5;
      comp.resize(Math.round(W * scale), Math.round(H * scale));
      const total = promoFrameCount(s) / s.fps;
      let t = transport.time();
      if (transport.isPlaying && total > 0 && t >= total) {
        if (loop) transport.play(0);
        else {
          transport.pause();
          transport.seek(total);
          setPlaying(false);
        }
        t = transport.time();
      }
      timeRef.current = t;
      const stats = comp.render(s, t * s.fps, transport.isPlaying);
      const active = stats.slotId;
      if (active !== lastActive) {
        lastActive = active;
        setActiveSlotId(active);
      }
      const isBuffering = stats.waiting > 0;
      if (isBuffering !== lastBuffering) {
        lastBuffering = isBuffering;
        setBuffering(isBuffering);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      comp.dispose();
    };
  }, [transport, hq, loop, setError]);

  // --- actions -----------------------------------------------------------------
  const togglePlay = useCallback(() => {
    if (transport.isPlaying) transport.pause();
    else transport.play();
    setPlaying(transport.isPlaying);
  }, [transport]);

  const seek = useCallback((sec: number) => transport.seek(sec), [transport]);

  /**
   * Seek to the first frame of `beat`. Beat starts are rounded to whole frames, so
   * `beat * beatDuration` can still fall inside the previous beat's last frame.
   */
  const seekBeat = useCallback(
    (beat: number) => {
      const s = useStore.getState().session;
      if (!s) return;
      seek(beatToFrame(Math.max(0, beat), s.sequence.bpm, s.fps) / s.fps);
    },
    [seek],
  );

  const reroll = useCallback(() => {
    update((s) => {
      if (s.clips.length === 0 || s.sequence.zones.length === 0) return s;
      const seed = s.sequence.seed + 1;
      return { ...s, sequence: { ...s.sequence, seed, slots: solve(s, seed) } };
    }, true);
  }, [update]);

  const editSlot = useCallback(
    (slotId: string, fn: (slot: Slot) => Slot) =>
      update(
        (s) => ({ ...s, sequence: { ...s.sequence, slots: s.sequence.slots.map((x) => (x.slot_id === slotId ? fn(x) : x)) } }),
        true,
      ),
    [update],
  );

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const flashNotice = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 1800);
  }, []);

  /**
   * `+`/`−` over a Beat Card: re-tier the clip under the pointer (a thumbnail), or the
   * card's main clip. Changes the clip in the pool, so it applies to future rerolls.
   */
  const bumpHovered = useCallback(
    (s: Session, delta: 1 | -1) => {
      const under = [...document.querySelectorAll(':hover')].at(-1);
      const slotId = under?.closest<HTMLElement>('[data-slot]')?.dataset.slot;
      if (!slotId) return;
      const slot = s.sequence.slots.find((x) => x.slot_id === slotId);
      const cellIndex = Number(under?.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? 0);
      const clip = s.clips.find((c) => c.clip_id === slot?.cells[cellIndex]?.clip_id);
      if (!clip) return;
      const next = bumpTier(clip, delta);
      if (next === clip) {
        flashNotice(clip.mode === 'RANGE' ? `${clip.clip_id} is a breather: drag it in the clip library (C) to make it an anchor` : `${clip.clip_id} is already ${TAG_NAMES[clip.energy_tag]}`);
        return;
      }
      update((cur) => ({ ...cur, clips: cur.clips.map((c) => (c.clip_id === clip.clip_id ? next : c)) }), true);
      flashNotice(`${clip.clip_id}: ${TAG_NAMES[clip.energy_tag]} → ${TAG_NAMES[next.energy_tag]}`);
    },
    [update, flashNotice],
  );

  // --- hotkeys -------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useStore.getState().session;
      if (!s) return;
      const bd = beatDuration(s.sequence.bpm);
      const target = hoveredSlot.current ?? selectedSlotId;
      const bump = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ? 1 : e.key === '-' || e.code === 'NumpadSubtract' ? -1 : 0;
      if (bump) {
        bumpHovered(s, bump);
        return;
      }
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'KeyR':
          reroll();
          break;
        case 'KeyT':
          if (target) editSlot(target, (slot) => cycleLayout(s, slot));
          break;
        case 'KeyL':
          if (target) editSlot(target, (slot) => ({ ...slot, locked: !slot.locked }));
          break;
        case 'KeyC':
          setLibraryOpen((o) => !o);
          break;
        case 'Home':
          seek(0);
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          seekBeat(Math.round(transport.time() / bd) + (e.code === 'ArrowRight' ? 1 : -1));
          break;
        }
        case 'Delete':
        case 'Backspace':
          if (selectedZone != null) {
            const zones = [...s.sequence.zones].sort((a, b) => a.start_beat - b.start_beat);
            update((cur) => ({ ...cur, sequence: { ...cur.sequence, zones: zones.filter((_, i) => i !== selectedZone) } }), true);
            setSelectedZone(null);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, reroll, editSlot, seek, seekBeat, transport, selectedSlotId, selectedZone, update, bumpHovered]);

  const onSelectSlot = useCallback(
    (slot: Slot) => {
      const s = useStore.getState().session;
      setSelectedSlotId(slot.slot_id);
      setTab('card');
      if (s) seekBeat(slot.start_beat);
    },
    [seekBeat],
  );
  const onHover = useCallback((id: string | null) => {
    hoveredSlot.current = id;
  }, []);

  if (!session) return null;
  const slots = [...session.sequence.slots].sort((a, b) => a.start_beat - b.start_beat);
  const selectedSlot = slots.find((s) => s.slot_id === selectedSlotId) ?? null;
  const stale = session.sequence.slots.length > 0 && !slotsMatchZones(session.sequence);

  return (
    <div className="flex h-full flex-col">
      <TransportBar
        session={session}
        timeRef={timeRef}
        playing={playing}
        loop={loop}
        onToggleLoop={() => setLoop((l) => !l)}
        onTogglePlay={togglePlay}
        onReroll={reroll}
        audio={audio}
        onsetEnv={onsetEnv}
        audioStatus={audioStatus}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-3">
            <LogoDrag session={session} timeRef={timeRef}>
              <canvas ref={canvasRef} className="h-full w-full rounded bg-black shadow-2xl" />
            </LogoDrag>
            <div className="absolute left-3 top-3 flex flex-col gap-1 text-[10px]">
              <button className="btn" onClick={() => setHq((v) => !v)}>
                {hq ? 'Full res 1080p' : 'Half res 540p'}
              </button>
              {buffering && <span className="rounded bg-black/70 px-1.5 py-0.5 text-amber-300">buffering clips…</span>}
            </div>
            {session.clips.length === 0 && (
              <div className="absolute text-sm text-zinc-500">Log some clips in the Logger first.</div>
            )}
          </div>
          {stale && (
            <div className="bg-amber-950 px-3 py-1 text-xs text-amber-200">
              Zones changed since the last roll — press <span className="kbd">R</span> to refill them (locked cards are kept).
            </div>
          )}
          <Timeline
            session={session}
            waveform={waveform}
            timeRef={timeRef}
            onSeek={seek}
            selectedZone={selectedZone}
            onSelectZone={(i) => {
              setSelectedZone(i);
              if (i != null) setTab('style');
            }}
          />
          {libraryOpen && <ClipLibrary session={session} />}
          <div className="relative">
            <BeatCards
              slots={slots}
              clips={session.clips}
              activeSlotId={activeSlotId}
              selectedSlotId={selectedSlotId}
              onSelect={onSelectSlot}
              onHover={onHover}
            />
            {notice && (
              <div className="pointer-events-none absolute bottom-full left-3 mb-1 rounded bg-black/85 px-2 py-1 text-xs text-zinc-100">
                {notice}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 border-t border-ink-700 bg-ink-900 px-3 py-1 text-[10px] text-zinc-500">
            <span><span className="kbd">Space</span> play</span>
            <span><span className="kbd">R</span> reroll unlocked</span>
            <span><span className="kbd">T</span> cycle layout (hovered card)</span>
            <span><span className="kbd">+</span><span className="kbd">−</span> energy of hovered clip</span>
            <span><span className="kbd">L</span> lock</span>
            <span>hover clip + <span className="kbd">⌫</span> delete</span>
            <span>
              <button className="underline decoration-dotted" onClick={(e) => { e.currentTarget.blur(); setLibraryOpen((o) => !o); }}>
                clip library
              </button>{' '}
              <span className="kbd">C</span>
            </span>
            <span><span className="kbd">wheel</span> on thumbnail: slip ±2f</span>
            <span><span className="kbd">←</span><span className="kbd">→</span> beat</span>
            <span><span className="kbd">Ctrl+wheel</span> zoom timeline</span>
          </div>
        </div>
        <SidePanel
          session={session}
          selectedSlot={selectedSlot}
          selectedZone={selectedZone}
          onSelectZone={setSelectedZone}
          tab={tab}
          onTab={setTab}
        />
      </div>
    </div>
  );
}
