import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, type FileEntry, type GlanceStatus } from '../lib/api';
import { isTypingTarget, TAG_COLORS } from '../lib/dom';
import { useStore } from '../lib/store';
import type { Clip } from '../types/session';

export const PAGE_SIZE = 20;
const ANCHOR_PAD = 2.0;
const POLL_MS = 1000;

export type LogFn = (path: string, clip: Omit<Clip, 'clip_id' | 'source_path' | 'focus_xy'>, frameSource: HTMLVideoElement | null) => void;

interface Props {
  files: FileEntry[];
  page: number;
  onPage: (page: number) => void;
  onLog: LogFn;
  onOpen: (index: number, atSec: number) => void;
}

/**
 * 5x4 wall of looping 3-second glances (from 30% into each file). Hover a tile and
 * tap 1-4 to log the moment it is showing, 0 to log its window as a breather.
 */
export default function ContactGrid({ files, page, onPage, onLog, onOpen }: Props) {
  const setError = useStore((s) => s.setError);
  const clips = useStore((s) => s.session?.clips ?? []);
  const duplicateOf = useStore((s) => s.duplicateOf);
  const [glances, setGlances] = useState<Record<string, GlanceStatus>>({});
  const [flash, setFlash] = useState<{ index: number; color: string } | null>(null);
  const hovered = useRef<number | null>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const pages = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
  const pageFiles = files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Request this page's glances (and the next page's, so paging feels instant); poll until ready.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wanted = files.slice(page * PAGE_SIZE, (page + 2) * PAGE_SIZE).map((f) => f.path);
    const current = new Set(files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((f) => f.path));
    const poll = async () => {
      try {
        const res = await api.glance(wanted);
        if (cancelled) return;
        setGlances((g) => ({ ...g, ...res }));
        if (Object.entries(res).some(([p, st]) => current.has(p) && st.status === 'pending')) timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!cancelled) setError(`Glance previews: ${(e as Error).message}`);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [files, page, setError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const back = e.code === 'ArrowLeft' || (e.code === 'Space' && e.shiftKey);
        onPage(Math.min(Math.max(page + (back ? -1 : 1), 0), pages - 1));
        return;
      }
      const tag = /^(?:Digit|Numpad)([0-4])$/.exec(e.code);
      const i = hovered.current;
      if (!tag || e.repeat || i == null) return;
      const file = pageFiles[i];
      const st = glances[file?.path];
      if (!file || st?.status !== 'ready') return;
      e.preventDefault();
      const n = Number(tag[1]);
      const video = videos.current[i];
      if (n === 0) {
        onLog(file.path, { mode: 'RANGE', in_sec: st.start_sec, anchor_sec: null, out_sec: st.start_sec + st.length_sec, energy_tag: 0 }, video);
      } else {
        const t = st.start_sec + (video?.currentTime ?? st.length_sec / 2);
        onLog(file.path, {
          mode: 'ANCHOR',
          anchor_sec: t,
          in_sec: Math.max(0, t - ANCHOR_PAD),
          out_sec: Math.min(st.source_duration_sec, t + ANCHOR_PAD),
          energy_tag: n,
        }, video);
      }
      setFlash({ index: i, color: TAG_COLORS[n] });
      setTimeout(() => setFlash((f) => (f?.index === i ? null : f)), 260);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, pages, pageFiles, glances, onLog, onPage]);

  const counts = new Map<string, number>();
  for (const c of clips) counts.set(c.source_path, (counts.get(c.source_path) ?? 0) + 1);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="grid min-h-0 flex-1 grid-cols-5 grid-rows-4 gap-1 p-1">
        {pageFiles.map((file, i) => {
          const st = glances[file.path];
          const count = counts.get(file.path) ?? 0;
          const border = flash?.index === i ? flash.color : count ? '#52525b' : 'transparent';
          return (
            <div
              key={file.path}
              className="group relative min-h-0 cursor-pointer overflow-hidden rounded bg-ink-900"
              style={{ boxShadow: `inset 0 0 0 ${flash?.index === i ? 6 : 2}px ${border}` }}
              onMouseEnter={() => (hovered.current = i)}
              onMouseLeave={() => (hovered.current = hovered.current === i ? null : hovered.current)}
              onClick={() => st?.status === 'ready' && onOpen(page * PAGE_SIZE + i, st.start_sec + (videos.current[i]?.currentTime ?? 0))}
            >
              {st?.status === 'ready' ? (
                <video
                  ref={(el) => (videos.current[i] = el)}
                  src={mediaUrl(st.glance_path)}
                  className="pointer-events-none h-full w-full object-contain"
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[10px] text-zinc-500">
                  {st?.status === 'error' ? `can't preview: ${st.error.slice(0, 60)}` : 'preparing…'}
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3 text-[10px]">
                <span className="truncate text-zinc-200">{file.name}</span>
                {duplicateOf[file.path] && (
                  <span className="rounded bg-amber-500 px-1 font-semibold text-black" title={`Same footage as ${duplicateOf[file.path].split(/[\\/]/).pop()}`}>
                    DUP
                  </span>
                )}
                {count > 0 && <span className="ml-auto rounded bg-zinc-200 px-1 font-semibold text-black">{count}</span>}
              </div>
              <div className="pointer-events-none absolute inset-0 hidden ring-2 ring-inset ring-white/60 group-hover:block" />
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 border-t border-ink-700 bg-ink-900 px-4 py-2 text-xs text-zinc-400">
        <span className="font-mono text-zinc-200">
          Page {page + 1}/{pages} · files {page * PAGE_SIZE + 1}–{Math.min(files.length, (page + 1) * PAGE_SIZE)} of {files.length}
        </span>
        <span className="ml-auto flex flex-wrap gap-x-3">
          <span>hover + <span className="kbd">1</span>–<span className="kbd">4</span> log what's on screen</span>
          <span><span className="kbd">0</span> tile as breather</span>
          <span><span className="kbd">Space</span> next page · <span className="kbd">Shift+Space</span> back</span>
          <span><span className="kbd">click</span> open in player</span>
          <span><span className="kbd">V</span> player view</span>
        </span>
      </div>
    </div>
  );
}
