import { api, mediaUrl } from '../lib/api';
import { formatTime, LOOK_COLORS, TAG_COLORS, TAG_NAMES, TIERS } from '../lib/dom';
import { removeClip, useStore } from '../lib/store';
import type { Clip } from '../types/session';

/** Roughly one clip per cut of a 15-second promo, plus spares for rerolls. */
const QUOTA = 25;

const STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: 'bg-zinc-500', label: 'queued' },
  slicing: { color: 'bg-amber-400 animate-pulse', label: 'slicing' },
  ready: { color: 'bg-emerald-500', label: 'ready' },
  error: { color: 'bg-red-500', label: 'error' },
};

export default function ClipQueue({ onJump }: { onJump: (clip: Clip) => void }) {
  const { session, update, setError } = useStore();
  if (!session) return null;
  const clips = [...session.clips].reverse();

  const retag = (clip: Clip) => {
    if (clip.mode !== 'ANCHOR') return; // breathers are always tier 0
    update(
      (s) => ({
        ...s,
        clips: s.clips.map((c) => (c.clip_id === clip.clip_id ? { ...c, energy_tag: (c.energy_tag % 4) + 1 } : c)),
      }),
      true,
    );
  };

  const retry = (clip: Clip) => {
    update((s) => ({
      ...s,
      clips: s.clips.map((c) => (c.clip_id === clip.clip_id ? { ...c, proxy_status: 'pending', proxy_error: null } : c)),
    }));
    api.slice(clip).catch((e: Error) => setError(e.message));
  };

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-ink-700 bg-ink-900">
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <span className="panel-title !mb-0">Logged clips</span>
        <span className="flex gap-2 text-[11px]">
          {TIERS.map((t) => (
            <span key={t} style={{ color: TAG_COLORS[t] }}>
              {t}:{session.clips.filter((c) => c.energy_tag === t).length}
            </span>
          ))}
        </span>
      </div>
      <div className="border-b border-ink-700 px-3 py-2">
        <div className="mb-1 flex justify-between text-[11px]">
          <span className="text-zinc-400">
            Clips logged: <span className="font-mono text-zinc-200">{session.clips.length}</span> / {QUOTA} recommended for a 15s promo
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-ink-700">
          <div
            className={`h-full ${session.clips.length >= QUOTA ? 'bg-emerald-500' : 'bg-rose-500'}`}
            style={{ width: `${Math.min(100, (100 * session.clips.length) / QUOTA)}%` }}
          />
        </div>
        {session.clips.length >= QUOTA && (
          <div className="mt-1.5 rounded bg-emerald-600/20 px-2 py-1 text-[11px] font-semibold text-emerald-300">
            Enough clips for a 15s promo — press <span className="kbd">Enter</span> to generate
          </div>
        )}
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto p-2">
        {clips.length === 0 && (
          <li className="p-4 text-center text-xs text-zinc-500">Tap 1–4 (energy) or hold 0 (breather) while a clip plays.</li>
        )}
        {clips.map((clip) => {
          const status = STATUS[clip.proxy_status ?? 'pending'];
          return (
            <li
              key={clip.clip_id}
              data-clip-id={clip.clip_id}
              className="group flex cursor-pointer gap-2 rounded-md border border-transparent p-1 hover:border-ink-600 hover:bg-ink-800"
              onClick={() => onJump(clip)}
            >
              <div className="relative h-[54px] w-[96px] shrink-0 overflow-hidden rounded bg-ink-700">
                {clip.thumb_path && (
                  <img
                    src={mediaUrl(clip.thumb_path, `${clip.in_sec}`)}
                    className="h-full w-full object-cover"
                    alt=""
                    draggable={false}
                  />
                )}
                <span
                  className="absolute left-0 top-0 h-full w-1"
                  style={{ background: TAG_COLORS[clip.energy_tag] }}
                />
              </div>
              <div className="min-w-0 flex-1 text-[11px] leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-zinc-300">{clip.clip_id}</span>
                  <button
                    title={clip.mode === 'ANCHOR' ? 'Click to change tag' : 'Range clip'}
                    className="rounded px-1 font-semibold text-black"
                    style={{ background: TAG_COLORS[clip.energy_tag] }}
                    onClick={(e) => {
                      e.stopPropagation();
                      retag(clip);
                    }}
                  >
                    {clip.energy_tag} {TAG_NAMES[clip.energy_tag]}
                  </button>
                  {clip.color_tag && clip.color_tag !== 'unknown' && (
                    <span
                      className="ml-auto h-2.5 w-2.5 rounded-sm border border-white/20"
                      style={{ background: LOOK_COLORS[clip.color_tag] ?? '#71717a' }}
                      title={`look: ${clip.color_tag.replace('_', ' ')}`}
                    />
                  )}
                  <span
                    className={`h-2 w-2 rounded-full ${status.color} ${clip.color_tag && clip.color_tag !== 'unknown' ? '' : 'ml-auto'}`}
                    title={clip.proxy_error ?? status.label}
                  />
                </div>
                <div className="truncate text-zinc-500">{clip.source_path.split(/[\\/]/).pop()}</div>
                <div className="font-mono text-zinc-400">
                  {clip.mode === 'ANCHOR' && clip.anchor_sec != null
                    ? `⚓ ${formatTime(clip.anchor_sec)}`
                    : `${formatTime(clip.in_sec)}–${formatTime(clip.out_sec)}`}
                </div>
                {clip.proxy_status === 'error' && (
                  <button
                    className="text-red-400 underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      retry(clip);
                    }}
                  >
                    retry slice
                  </button>
                )}
              </div>
              <button
                className="self-start text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                title="Delete clip (or hover + Backspace)"
                onClick={(e) => {
                  e.stopPropagation();
                  removeClip(clip.clip_id);
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
