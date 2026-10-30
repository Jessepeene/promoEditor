import { useState } from 'react';
import { api } from '../lib/api';
import { harvestClips } from '../lib/harvest';
import { useStore } from '../lib/store';

const HARVEST_COUNT = 35;
const HARVEST_BREATHERS = 3;
/** B-roll harvest: up to one calm range shot per file. */
const BROLL_MAX = 200;

interface Props {
  uploading: string | null;
  mode: 'player' | 'grid';
  onToggleMode: () => void;
  autoAdvance: boolean;
  onToggleAutoAdvance: () => void;
}

export default function FolderBar({ uploading, mode, onToggleMode, autoAdvance, onToggleAutoAdvance }: Props) {
  const {
    session, playlist, playlistIndex, openFolder, setPlaylistIndex, setError,
    folderFiles, duplicateOf, hideDuplicates, setHideDuplicates, dupeScan, shuffleSeed, setShuffle,
  } = useStore();
  const [path, setPath] = useState(session?.source_folders.at(-1) ?? '');
  const [busy, setBusy] = useState(false);
  const [harvest, setHarvest] = useState<string | null>(null);

  const open = async (folder: string) => {
    if (!folder.trim()) return;
    setBusy(true);
    try {
      const res = await openFolder(folder);
      setPath(res.folder);
      if (res.files.length === 0) setError(`No video files (.mp4 .mov .m4v .webm .mkv) in ${res.folder}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    try {
      const { path: picked } = await api.pick('folder');
      if (picked) await open(picked);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** `count` 0 = B-roll only: calm range shots, one per file. */
  const runHarvest = async (count: number, breathers: number, label: string) => {
    // One copy of each duplicate group, whether or not duplicates are hidden in the playlist.
    const paths = folderFiles.map((f) => f.path).filter((p) => !duplicateOf[p]);
    setHarvest(`${label}: analysing…`);
    try {
      const { added, skipped } = await harvestClips(paths, count, breathers, (done, total) => setHarvest(`${label}: analysing ${done}/${total}…`));
      setHarvest(`${label}: added ${added} clip(s)${skipped ? `, ${skipped} file(s) unusable` : ''}`);
    } catch (e) {
      setHarvest(null);
      setError(`${label}: ${(e as Error).message}`);
    }
  };

  const counts = new Map<string, number>();
  for (const c of session?.clips ?? []) counts.set(c.source_path, (counts.get(c.source_path) ?? 0) + 1);
  const analysing = harvest?.includes('analysing') ?? false;
  const dupeCount = Object.keys(duplicateOf).length;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2">
      <form
        className="flex min-w-[320px] flex-1 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <input
          className="input flex-1"
          placeholder="Paste a folder path, click Browse, or drop a folder onto the player"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          Open
        </button>
        <button className="btn" type="button" onClick={browse} disabled={busy}>
          Browse…
        </button>
      </form>
      {uploading && <span className="text-xs text-amber-300">{uploading}</span>}
      {playlist.length > 0 && (
        <>
          <button
            className="btn"
            onClick={(e) => {
              e.currentTarget.blur(); // keep Space for play/paging
              onToggleMode();
            }}
            title="Switch between the single player and a 20-tile grid (V)"
          >
            {mode === 'player' ? '▦ Grid' : '▶ Player'} <span className="kbd">V</span>
          </button>
          <button
            className="btn"
            onClick={(e) => {
              e.currentTarget.blur();
              void runHarvest(HARVEST_COUNT, HARVEST_BREATHERS, 'Harvest');
            }}
            disabled={analysing}
            title={`Pick the ${HARVEST_COUNT} most energetic moments (plus ${HARVEST_BREATHERS} calm breathers) across the folder, one copy of each duplicate`}
          >
            ✨ Auto-harvest
          </button>
          <button
            className="btn"
            onClick={(e) => {
              e.currentTarget.blur();
              void runHarvest(0, BROLL_MAX, 'B-roll');
            }}
            disabled={analysing}
            title="Collect B-roll: the calmest well-exposed 4-second range shot from every file (tier 0 breathers)"
          >
            🎞 Harvest B-roll
          </button>
          {harvest && <span className="text-xs text-emerald-300">{harvest}</span>}
        </>
      )}
      {playlist.length > 1 && (
        <label className="flex items-center gap-1 text-xs text-zinc-400" title="Play the folder in a random order (a fresh order each time you turn it on)">
          <input
            type="checkbox"
            className="accent-rose-500"
            checked={shuffleSeed != null}
            onChange={(e) => {
              setShuffle(e.target.checked);
              e.currentTarget.blur(); // keep Space for play/paging
            }}
          />
          Shuffle
        </label>
      )}
      {dupeScan && <span className="text-xs text-zinc-400">{dupeScan}</span>}
      {dupeCount > 0 && (
        <label
          className="flex items-center gap-1 text-xs text-amber-300"
          title="Files whose frames at 30/50/70% match another file (copies, re-encodes). Trimmed copies aren't detected."
        >
          <input
            type="checkbox"
            className="accent-rose-500"
            checked={hideDuplicates}
            onChange={(e) => {
              setHideDuplicates(e.target.checked);
              e.currentTarget.blur();
            }}
          />
          Hide {dupeCount} duplicate{dupeCount === 1 ? '' : 's'}
        </label>
      )}
      {playlist.length > 0 && mode === 'player' && (
        <div className="flex items-center gap-1">
          <label className="mr-2 flex items-center gap-1 text-xs text-zinc-400" title="Jump to the next file right after tagging 1/2/3">
            <input
              type="checkbox"
              className="accent-rose-500"
              checked={autoAdvance}
              onChange={(e) => {
                onToggleAutoAdvance();
                e.currentTarget.blur(); // otherwise Space would toggle it instead of playing
              }}
            />
            Auto-advance
          </label>
          <button className="btn" disabled={playlistIndex === 0} onClick={() => setPlaylistIndex(playlistIndex - 1)}>
            ◀
          </button>
          <select
            className="input max-w-[240px]"
            value={playlistIndex}
            onChange={(e) => {
              setPlaylistIndex(Number(e.target.value));
              e.currentTarget.blur();
            }}
          >
            {playlist.map((f, i) => (
              <option key={f.path} value={i}>
                {i + 1}/{playlist.length} · {f.name}
                {counts.get(f.path) ? ` (${counts.get(f.path)})` : ''}
                {duplicateOf[f.path] ? ' · duplicate' : ''}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={playlistIndex >= playlist.length - 1}
            onClick={() => setPlaylistIndex(playlistIndex + 1)}
          >
            ▶
          </button>
        </div>
      )}
    </div>
  );
}
