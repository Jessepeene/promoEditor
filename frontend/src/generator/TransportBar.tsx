import { useEffect, useRef, useState } from 'react';
import NumberField from '../components/NumberField';
import { api } from '../lib/api';
import { estimateTempo, mixToMono, strongestOnsetNear, tapTempo } from '../lib/bpm';
import { formatTime } from '../lib/dom';
import { applyRecipe, ZONE_RECIPES } from '../lib/solver';
import { useStore } from '../lib/store';
import { beatDuration } from '../lib/timing';
import type { Session } from '../types/session';

interface Props {
  session: Session;
  timeRef: React.MutableRefObject<number>;
  playing: boolean;
  loop: boolean;
  onToggleLoop: () => void;
  onTogglePlay: () => void;
  onReroll: () => void;
  audio: AudioBuffer | null;
  onsetEnv: Float32Array | null;
  audioStatus: string | null;
}

const TAP_RESET_MS = 2000;

export default function TransportBar(props: Props) {
  const { session, timeRef, playing, loop, onToggleLoop, onTogglePlay, onReroll, audio, onsetEnv, audioStatus } = props;
  const { update, setError } = useStore();
  const seq = session.sequence;
  const bd = beatDuration(seq.bpm);
  const clockRef = useRef<HTMLSpanElement>(null);
  const taps = useRef<number[]>([]);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Clock text is written straight to the DOM so the bar doesn't re-render per frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = timeRef.current;
      const beat = t / bd;
      if (clockRef.current) {
        clockRef.current.textContent = `${formatTime(t)} · bar ${Math.floor(beat / 4) + 1}.${(Math.floor(beat) % 4) + 1}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeRef, bd]);

  const setSeq = (patch: Partial<Session['sequence']>, undoable = true) =>
    update((s) => ({ ...s, sequence: { ...s.sequence, ...patch } }), undoable);

  /** Keep the drop marker on the same moment of the song when the tempo changes. */
  const setBpm = (bpm: number, phaseSec?: number) => {
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) return;
    const dropTime = seq.beat_1_offset_sec + seq.drop_beat_index * bd;
    const nbd = 60 / bpm;
    let anchor = dropTime;
    if (phaseSec != null) anchor = phaseSec + Math.round((dropTime - phaseSec) / nbd) * nbd;
    setSeq({ bpm, beat_1_offset_sec: Math.round((anchor - seq.drop_beat_index * nbd) * 1000) / 1000 });
  };

  const detect = () => {
    if (!audio) return;
    setDetecting(true);
    // Let React paint the busy state before the (synchronous) analysis.
    setTimeout(() => {
      const est = estimateTempo(mixToMono(audio), audio.sampleRate);
      setBpm(est.bpm, est.firstBeatSec);
      setDetecting(false);
    }, 20);
  };

  const snapDrop = () => {
    if (!onsetEnv) return;
    const dropTime = seq.beat_1_offset_sec + seq.drop_beat_index * bd;
    const kick = strongestOnsetNear(onsetEnv, dropTime, bd / 2);
    setSeq({ beat_1_offset_sec: Math.round((seq.beat_1_offset_sec + kick - dropTime) * 1000) / 1000 });
  };

  const tap = () => {
    const now = performance.now();
    if (taps.current.length && now - taps.current[taps.current.length - 1] > TAP_RESET_MS) taps.current = [];
    taps.current = [...taps.current.slice(-11), now];
    const bpm = tapTempo(taps.current);
    setTapBpm(bpm);
    if (bpm) setBpm(bpm);
  };

  const chooseAudio = async (source: 'pick' | File) => {
    try {
      let path: string | null;
      if (source === 'pick') path = (await api.pick('audio')).path;
      else path = (await api.upload([source], 'audio')).files[0]?.path ?? null;
      if (path) setSeq({ audio_path: path });
    } catch (e) {
      setError(`Could not set audio: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700 bg-ink-900 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <button className="btn btn-primary w-16 justify-center" onClick={onTogglePlay}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className={`btn ${loop ? 'border-rose-500 text-rose-300' : ''}`} onClick={onToggleLoop} title="Loop the promo">
          ⟳
        </button>
        <span ref={clockRef} className="w-40 font-mono text-zinc-300" />
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500">Track</span>
        <span className="max-w-[180px] truncate text-zinc-300" title={seq.audio_path ?? ''}>
          {seq.audio_path ? seq.audio_path.split(/[\\/]/).pop() : 'none'}
        </span>
        <button className="btn" onClick={() => void chooseAudio('pick')}>
          Browse…
        </button>
        <label className="btn cursor-pointer">
          Upload
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void chooseAudio(f);
              e.target.value = '';
            }}
          />
        </label>
        {audioStatus && <span className="text-amber-300">{audioStatus}</span>}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500">BPM</span>
        <NumberField value={seq.bpm} step={0.1} min={40} max={300} className="w-20" onCommit={(v) => setBpm(v)} />
        <button className="btn" onClick={detect} disabled={!audio || detecting} title="Detect tempo and beat phase">
          {detecting ? 'Detecting…' : 'Detect'}
        </button>
        <button className="btn" onClick={tap} title="Tap along to the beat">
          Tap{tapBpm ? ` ${tapBpm}` : ''}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500">Beat 0 at</span>
        <button className="btn" onClick={() => setSeq({ beat_1_offset_sec: Math.round((seq.beat_1_offset_sec - 0.01) * 1000) / 1000 })}>
          −10ms
        </button>
        <NumberField
          value={seq.beat_1_offset_sec}
          step={0.01}
          className="w-20"
          onCommit={(v) => setSeq({ beat_1_offset_sec: v })}
        />
        <button className="btn" onClick={() => setSeq({ beat_1_offset_sec: Math.round((seq.beat_1_offset_sec + 0.01) * 1000) / 1000 })}>
          +10ms
        </button>
        <span className="text-zinc-500">s</span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-red-400">DROP beat</span>
        <NumberField
          value={seq.drop_beat_index}
          step={1}
          min={0}
          className="w-16"
          onCommit={(v) => setSeq({ drop_beat_index: Math.round(v) })}
        />
        <button className="btn" onClick={snapDrop} disabled={!onsetEnv} title="Nudge the grid so the DROP marker sits on the nearest kick">
          Snap to kick
        </button>
        <select
          className="input"
          value=""
          title="Lay out zones from a promo structure (keeps the drop on the same moment of the song)"
          onChange={(e) => {
            const recipe = ZONE_RECIPES.find((r) => r.id === e.target.value);
            if (recipe) setSeq(applyRecipe(seq, recipe));
            e.currentTarget.blur();
          }}
        >
          <option value="" disabled>
            Auto zones…
          </option>
          {ZONE_RECIPES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <button className="btn btn-primary ml-auto" onClick={onReroll} disabled={session.clips.length === 0}>
        Reroll <span className="kbd">R</span>
      </button>
    </div>
  );
}
