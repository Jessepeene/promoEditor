import { useCallback, useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type FileEntry } from '../lib/api';
import { formatTime, isTypingTarget, TAG_COLORS, TAG_NAMES } from '../lib/dom';
import { nextClipId, useStore } from '../lib/store';
import type { Clip } from '../types/session';
import ClipQueue from './ClipQueue';
import ContactGrid, { type LogFn } from './ContactGrid';
import FolderBar from './FolderBar';

const SPEEDS = [1, 1.5, 2, 4];
const DEFAULT_SPEED = 1.5;
const START_FRAC = 0.3;
const ANCHOR_PAD = 2.0;
const MIN_RANGE = 0.5;
const FOCUS_APPLY_WINDOW_MS = 5000;
const VIDEO_EXTS = /\.(mp4|mov|m4v|webm|mkv)$/i;

type Guide = 'vertical' | 'stack' | 'off';
const GUIDES: Guide[] = ['vertical', 'stack', 'off'];
const GUIDE_LABEL: Record<Guide, string> = { vertical: '9:16 Vertical', stack: '16:9 3-Stack Row', off: 'Guides off' };
// Crop aspect (w/h) each guide previews: the full 9:16 frame, or one 1080x640 stack row.
const GUIDE_ASPECT: Record<Exclude<Guide, 'off'>, number> = { vertical: 9 / 16, stack: 1080 / 640 };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the picture actually sits inside an object-fit: contain <video> element. */
function contentBox(v: HTMLVideoElement): Box {
  const ew = v.clientWidth;
  const eh = v.clientHeight;
  if (!v.videoWidth || !v.videoHeight) return { x: 0, y: 0, w: ew, h: eh };
  const scale = Math.min(ew / v.videoWidth, eh / v.videoHeight);
  const w = v.videoWidth * scale;
  const h = v.videoHeight * scale;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

/** The export's cover-crop window for `aspect`, centred on focus and clamped inside the frame. */
function cropBox(box: Box, aspect: number, focus: [number, number]): Box {
  let w = box.w;
  let h = box.h;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  const cx = Math.min(Math.max(focus[0] * box.w, w / 2), box.w - w / 2);
  const cy = Math.min(Math.max(focus[1] * box.h, h / 2), box.h - h / 2);
  return { x: box.x + cx - w / 2, y: box.y + cy - h / 2, w, h };
}

async function collectDroppedFiles(items: DataTransferItemList): Promise<File[]> {
  const files: File[] = [];
  const readDir = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const reader = dir.createReader();
      const all: FileSystemEntry[] = [];
      // readEntries returns results in batches until an empty batch.
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
      next();
    });
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      if (VIDEO_EXTS.test(file.name)) files.push(file);
    } else if (entry.isDirectory) {
      for (const child of await readDir(entry as FileSystemDirectoryEntry)) await walk(child);
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  for (const e of entries) await walk(e);
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export default function LoggerView() {
  const { session, playlist, playlistIndex, setFolderFiles, setPlaylistIndex, update, setError, setView } = useStore();
  const file: FileEntry | undefined = playlist[playlistIndex];

  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<'player' | 'grid'>('player');
  const [gridPage, setGridPage] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [reverse, setReverse] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [guide, setGuide] = useState<Guide>('vertical');
  const [focus, setFocus] = useState<[number, number]>([0.5, 0.5]);
  const [flash, setFlash] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  // Refs mirror state for the key handlers, which must not re-subscribe every frame.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rangeRef = useRef<number | null>(null);
  const lastLogged = useRef<{ clipId: string; at: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingSeek = useRef<number | null>(null);

  // --- load file ------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !file) return;
    setVideoError(null);
    setReverse(false);
    setFocus([0.5, 0.5]);
    lastLogged.current = null;
    v.src = mediaUrl(file.path);
    // Keep the speed you chose: culling 180 files at a set pace beats re-picking it per file.
    v.playbackRate = speedRef.current;
    if (modeRef.current !== 'player') return;
    v.play().catch((err: DOMException) => {
      if (err.name !== 'AbortError') setVideoError(`Playback failed: ${err.message}`);
    });
  }, [file]);

  // --- reverse playback (J): the element can't play backwards, so step it ---
  useEffect(() => {
    const v = videoRef.current;
    if (!reverse || !v) return;
    v.pause();
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!v.seeking) v.currentTime = Math.max(0, v.currentTime - dt * speed);
      if (v.currentTime <= 0) {
        setReverse(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reverse, speed]);

  // Keep the guide overlay aligned with the picture.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const measure = () => setBox(contentBox(v));
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    v.addEventListener('loadedmetadata', measure);
    return () => {
      ro.disconnect();
      v.removeEventListener('loadedmetadata', measure);
    };
  }, []);

  const showFlash = (color: string) => {
    setFlash(color);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 260);
  };

  /** Grab the frame `v` is showing as the clip's thumbnail. */
  const captureThumb = useCallback(
    (clipId: string, v: HTMLVideoElement | null) => {
      if (!v || !v.videoWidth) return; // the slicer makes a thumbnail from the proxy instead
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = Math.round((320 * v.videoHeight) / v.videoWidth);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        async (blob) => {
          if (!blob) return;
          try {
            const { thumb_path } = await api.uploadThumb(clipId, blob);
            update((s) => ({ ...s, clips: s.clips.map((c) => (c.clip_id === clipId ? { ...c, thumb_path } : c)) }));
          } catch (e) {
            setError(`Thumbnail upload failed: ${(e as Error).message}`);
          }
        },
        'image/jpeg',
        0.8,
      );
    },
    [update, setError],
  );

  const logClip: LogFn = useCallback(
    (path, partial, frameSource) => {
      const s = useStore.getState().session;
      if (!s) return;
      const clip: Clip = {
        ...partial,
        clip_id: nextClipId(s),
        source_path: path,
        // The click-to-focus point belongs to the file open in the player.
        focus_xy: path === file?.path ? focusRef.current : [0.5, 0.5],
        proxy_status: 'pending',
      };
      update((cur) => ({ ...cur, clips: [...cur.clips, clip] }), true);
      lastLogged.current = { clipId: clip.clip_id, at: performance.now() };
      captureThumb(clip.clip_id, frameSource);
      api.slice(clip).catch((e: Error) => {
        setError(`Slice request failed for ${clip.clip_id}: ${e.message}`);
        update((cur) => ({
          ...cur,
          clips: cur.clips.map((c) => (c.clip_id === clip.clip_id ? { ...c, proxy_status: 'error', proxy_error: e.message } : c)),
        }));
      });
    },
    [file, update, captureThumb, setError],
  );

  const goto = useCallback(
    (index: number) => {
      if (index >= 0 && index < playlist.length) setPlaylistIndex(index);
    },
    [playlist.length, setPlaylistIndex],
  );

  const logAnchor = useCallback(
    (tag: 1 | 2 | 3 | 4) => {
      const v = videoRef.current;
      if (!v || !file || !Number.isFinite(v.duration)) return;
      const t = v.currentTime;
      logClip(file.path, {
        mode: 'ANCHOR',
        in_sec: Math.max(0, t - ANCHOR_PAD),
        anchor_sec: t,
        out_sec: Math.min(v.duration, t + ANCHOR_PAD),
        energy_tag: tag,
      }, v);
      showFlash(TAG_COLORS[tag]);
      if (autoAdvance) goto(playlistIndex + 1);
    },
    [file, logClip, autoAdvance, goto, playlistIndex],
  );

  const finishRange = useCallback(() => {
    const v = videoRef.current;
    const start = rangeRef.current;
    rangeRef.current = null;
    setRangeStart(null);
    if (!v || start == null) return;
    // Holding 0 while rewinding records the range backwards.
    let a = Math.min(start, v.currentTime);
    let b = Math.max(start, v.currentTime);
    if (b - a < MIN_RANGE) b = Math.min(v.duration, a + MIN_RANGE);
    if (b - a < MIN_RANGE) a = Math.max(0, b - MIN_RANGE);
    if (file) logClip(file.path, { mode: 'RANGE', in_sec: a, anchor_sec: null, out_sec: b, energy_tag: 0 }, v);
    showFlash(TAG_COLORS[0]);
  }, [file, logClip]);

  /** Change file, closing an open `0` range on the current one first. */
  const switchFile = useCallback(
    (index: number) => {
      if (rangeRef.current != null) finishRange();
      goto(index);
    },
    [finishRange, goto],
  );

  // --- view-level keys (both modes) -----------------------------------------
  const toggleMode = useCallback(() => {
    if (rangeRef.current != null) finishRange();
    videoRef.current?.pause();
    setReverse(false);
    setMode((m) => (m === 'player' ? 'grid' : 'player'));
  }, [finishRange]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyV') toggleMode();
      else if (e.code === 'Enter') {
        e.preventDefault();
        setView('generator');
      }
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [toggleMode, setView]);

  // --- player hotkeys -------------------------------------------------------
  useEffect(() => {
    if (mode !== 'player') return; // the grid has its own keys
    const onDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      const tagKey = /^(?:Digit|Numpad)([0-4])$/.exec(e.code);
      if (tagKey) {
        e.preventDefault();
        if (e.repeat) return;
        const n = Number(tagKey[1]);
        if (n === 0) {
          rangeRef.current = v.currentTime;
          setRangeStart(v.currentTime);
        } else {
          logAnchor(n as 1 | 2 | 3 | 4);
        }
        return;
      }
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (reverse) setReverse(false);
          else if (v.paused) void v.play();
          else v.pause();
          break;
        case 'KeyK':
          setReverse(false);
          v.pause();
          break;
        case 'KeyL': {
          // Forward: each press steps up 1 → 1.5 → 2 → 4x.
          const next = reverse || v.paused ? speed : SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
          setReverse(false);
          setSpeed(next);
          v.playbackRate = next;
          void v.play();
          break;
        }
        case 'KeyJ': {
          const next = reverse ? SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] : 1;
          setSpeed(next);
          setReverse(true);
          break;
        }
        case 'Tab':
          e.preventDefault();
          switchFile(playlistIndex + (e.shiftKey ? -1 : 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          switchFile(playlistIndex + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          switchFile(playlistIndex - 1);
          break;
        case 'Comma':
        case 'Period':
          setReverse(false);
          v.pause();
          v.currentTime = Math.max(0, v.currentTime + (e.code === 'Period' ? 1 : -1) / 30);
          break;
        case 'KeyG':
          setGuide((g) => GUIDES[(GUIDES.indexOf(g) + 1) % GUIDES.length]);
          break;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (/^(?:Digit|Numpad)0$/.test(e.code) && rangeRef.current != null) finishRange();
    };
    // Releasing 0 outside the window would otherwise leave the range open.
    const onBlur = () => rangeRef.current != null && finishRange();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [mode, reverse, speed, playlistIndex, logAnchor, finishRange, switchFile]);

  // --- focus click ----------------------------------------------------------
  const onVideoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !box) return;
    const rect = v.getBoundingClientRect();
    const fx = (e.clientX - rect.left - box.x) / box.w;
    const fy = (e.clientY - rect.top - box.y) / box.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    const xy: [number, number] = [Math.round(fx * 1000) / 1000, Math.round(fy * 1000) / 1000];
    setFocus(xy);
    // Also re-aim the clip just logged, so "tap 3, then click the subject" works.
    const last = lastLogged.current;
    if (last && performance.now() - last.at < FOCUS_APPLY_WINDOW_MS) {
      update((s) => ({ ...s, clips: s.clips.map((c) => (c.clip_id === last.clipId ? { ...c, focus_xy: xy } : c)) }), true);
    }
  };

  // --- drag & drop ingest ---------------------------------------------------
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = await collectDroppedFiles(e.dataTransfer.items);
    if (files.length === 0) {
      setError('No video files in the dropped items.');
      return;
    }
    setUploading(`Copying ${files.length} file(s) into the workspace…`);
    try {
      const res = await api.upload(files, 'raw');
      setFolderFiles(res.files);
    } catch (err) {
      setError(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(null);
    }
  };

  /** Show `index` in the player at `atSec` (from the clip queue or a grid tile). */
  const openAt = (index: number, atSec: number) => {
    setMode('player');
    if (index !== playlistIndex) {
      pendingSeek.current = atSec;
      switchFile(index);
    } else if (videoRef.current) {
      videoRef.current.currentTime = atSec;
      void videoRef.current.play();
    }
  };

  const jumpTo = (clip: Clip) => {
    const idx = playlist.findIndex((f) => f.path === clip.source_path);
    if (idx >= 0) openAt(idx, clip.anchor_sec ?? clip.in_sec);
  };

  const fileClips = session?.clips.filter((c) => c.source_path === file?.path) ?? [];
  const guideBox = box && guide !== 'off' ? cropBox(box, GUIDE_ASPECT[guide], focus) : null;
  const borderColor = rangeStart != null ? TAG_COLORS[0] : flash;

  return (
    <div className="flex h-full">
      <section
        className="flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <FolderBar
          uploading={uploading}
          mode={mode}
          onToggleMode={toggleMode}
          autoAdvance={autoAdvance}
          onToggleAutoAdvance={() => setAutoAdvance((a) => !a)}
        />
        {mode === 'grid' && (
          <div className="min-h-0 flex-1">
            <ContactGrid files={playlist} page={gridPage} onPage={setGridPage} onLog={logClip} onOpen={openAt} />
          </div>
        )}
        {/* The player stays mounted (just hidden) in grid mode so its element and observers persist. */}
        <div className={mode === 'grid' ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <div className="relative flex h-[85%] min-h-0 items-center justify-center overflow-hidden bg-black" onClick={onVideoClick}>
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            muted
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              if (pendingSeek.current != null) {
                e.currentTarget.currentTime = pendingSeek.current;
                pendingSeek.current = null;
              } else {
                // Skip the first 30%: that's usually the camera being set up.
                e.currentTarget.currentTime = e.currentTarget.duration * START_FRAC;
              }
            }}
            // Only auto-advance moves on by itself; otherwise the clip just stops at its end.
            onEnded={() => autoAdvance && switchFile(playlistIndex + 1)}
            onError={(e) =>
              setVideoError(
                `This browser can't play ${file?.name ?? 'the file'} (media error ${e.currentTarget.error?.code}). ` +
                  'HEVC/ProRes sources may need transcoding to H.264.',
              )
            }
          />
          {guideBox && box && (
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute border-2 border-dashed border-white/70"
                style={{
                  left: guideBox.x,
                  top: guideBox.y,
                  width: guideBox.w,
                  height: guideBox.h,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                }}
              >
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white/80">
                  {GUIDE_LABEL[guide]}
                </span>
              </div>
              <div
                className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-rose-400"
                style={{ left: box.x + focus[0] * box.w, top: box.y + focus[1] * box.h }}
              />
            </div>
          )}
          {borderColor && (
            <div className="pointer-events-none absolute inset-0" style={{ boxShadow: `inset 0 0 0 8px ${borderColor}` }} />
          )}
          {rangeStart != null && (
            <div className="absolute left-3 top-3 rounded bg-purple-600 px-2 py-0.5 text-xs font-bold text-white">
              ● REC range {(time - rangeStart).toFixed(1)}s
            </div>
          )}
          {!file && (
            <div className="absolute text-center text-sm text-zinc-400">
              Open a folder of raw clips (or drop one here) to start logging.
            </div>
          )}
          {videoError && <div className="absolute bottom-4 rounded bg-red-900/90 px-3 py-2 text-xs text-red-100">{videoError}</div>}
          {dragOver && (
            <div className="absolute inset-0 flex items-center justify-center border-4 border-dashed border-rose-500 bg-black/70 text-lg">
              Drop a folder of clips
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col justify-center gap-2 border-t border-ink-700 bg-ink-900 px-4">
          <div
            className="relative h-4 cursor-pointer rounded bg-ink-700"
            onClick={(e) => {
              const v = videoRef.current;
              if (!v || !duration) return;
              const r = e.currentTarget.getBoundingClientRect();
              v.currentTime = ((e.clientX - r.left) / r.width) * duration;
            }}
          >
            {duration > 0 &&
              fileClips.map((c) => (
                <span
                  key={c.clip_id}
                  className="absolute top-0 h-full opacity-60"
                  style={{
                    left: `${(c.in_sec / duration) * 100}%`,
                    width: `${((c.out_sec - c.in_sec) / duration) * 100}%`,
                    background: TAG_COLORS[c.energy_tag],
                  }}
                />
              ))}
            {duration > 0 && (
              <span className="absolute top-[-3px] h-[22px] w-0.5 bg-white" style={{ left: `${(time / duration) * 100}%` }} />
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-zinc-400">
            <span className="font-mono text-zinc-200">
              {formatTime(time)} / {formatTime(duration || 0)}
            </span>
            <span className="font-mono">
              {reverse ? '◀◀' : playing ? '▶' : '❚❚'} {speed}x
            </span>
            <span>
              {GUIDE_LABEL[guide]} <span className="kbd">G</span>
            </span>
            <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1">
              <span><span className="kbd">Space</span> play</span>
              <span><span className="kbd">J</span><span className="kbd">K</span><span className="kbd">L</span> rew/stop/ff</span>
              {([1, 2, 3, 4] as const).map((t) => (
                <span key={t} style={{ color: TAG_COLORS[t] }}><span className="kbd">{t}</span> {TAG_NAMES[t].toLowerCase()}</span>
              ))}
              <span style={{ color: TAG_COLORS[0] }}><span className="kbd">hold 0</span> breather range</span>
              <span><span className="kbd">click</span> focus</span>
              <span><span className="kbd">Tab</span>/<span className="kbd">→</span> next</span>
              <span><span className="kbd">,</span><span className="kbd">.</span> frame</span>
              <span><span className="kbd">V</span> grid view</span>
              <span>hover clip + <span className="kbd">⌫</span> delete</span>
              <span><span className="kbd">Ctrl+Z</span> undo</span>
            </span>
          </div>
        </div>
        </div>
      </section>
      <ClipQueue onJump={jumpTo} />
    </div>
  );
}
