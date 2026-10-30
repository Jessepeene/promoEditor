import { useState } from 'react';
import { mediaUrl } from '../lib/api';
import { LOOK_COLORS, TAG_COLORS, TAG_NAMES, TIERS } from '../lib/dom';
import { useStore } from '../lib/store';
import { withTier } from '../lib/tiers';
import type { Clip, Session } from '../types/session';

const DRAG_TYPE = 'application/x-promo-clip';

/** Clip pool grouped by energy tier; drag a clip to another column to retag it. */
export default function ClipLibrary({ session }: { session: Session }) {
  const update = useStore((s) => s.update);
  const [over, setOver] = useState<number | null>(null);
  const usage = new Map<string, number>();
  for (const slot of session.sequence.slots) for (const c of slot.cells) usage.set(c.clip_id, (usage.get(c.clip_id) ?? 0) + 1);

  const move = (clipId: string, tier: number) =>
    update((s) => ({ ...s, clips: s.clips.map((c) => (c.clip_id === clipId ? withTier(c, tier) : c)) }), true);

  return (
    <div className="grid h-52 shrink-0 grid-cols-5 gap-1 border-t border-ink-700 bg-ink-950 p-1">
      {TIERS.map((tier) => {
        const clips = session.clips.filter((c) => c.energy_tag === tier);
        return (
          <div
            key={tier}
            className={`flex min-h-0 flex-col rounded border ${over === tier ? 'border-white bg-ink-800' : 'border-ink-700 bg-ink-900'}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setOver(tier);
            }}
            onDragLeave={() => setOver((o) => (o === tier ? null : o))}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (id) move(id, tier);
            }}
          >
            <div className="flex items-center gap-1.5 border-b border-ink-700 px-2 py-1 text-[11px] font-semibold" style={{ color: TAG_COLORS[tier] }}>
              <span className="kbd">{tier}</span> {TAG_NAMES[tier]}
              <span className="ml-auto font-mono text-zinc-500">{clips.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto p-1">
              {clips.map((c) => (
                <LibraryTile key={c.clip_id} clip={c} used={usage.get(c.clip_id) ?? 0} />
              ))}
              {clips.length === 0 && <div className="p-2 text-[10px] text-zinc-600">Drop clips here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LibraryTile({ clip, used }: { clip: Clip; used: number }) {
  const name = clip.source_path.split(/[\\/]/).pop();
  const look = clip.color_tag && clip.color_tag !== 'unknown' ? clip.color_tag : null;
  return (
    <div
      draggable
      data-clip-id={clip.clip_id}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, clip.clip_id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={`${clip.clip_id} · ${name}${look ? ` · ${look.replace('_', ' ')}` : ''} · used in ${used} card(s)`}
      className="relative h-10 w-[72px] cursor-grab overflow-hidden rounded-sm bg-ink-700 active:cursor-grabbing"
    >
      {clip.thumb_path && <img src={mediaUrl(clip.thumb_path, clip.in_sec)} className="pointer-events-none h-full w-full object-cover" alt="" />}
      {look && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-sm border border-black/40" style={{ background: LOOK_COLORS[look] }} />}
      {used > 0 && <span className="absolute bottom-0 left-0 bg-black/70 px-0.5 font-mono text-[8px] text-zinc-200">×{used}</span>}
    </div>
  );
}
