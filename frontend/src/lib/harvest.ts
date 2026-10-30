// Run a server-side harvest and add what it proposes to the clip pool.
import type { Clip } from '../types/session';
import { api, type HarvestClip, type HarvestVersion } from './api';
import { nextClipId, useStore } from './store';

const POLL_MS = 700;
/** A proposed clip this close to one already logged (same file) is a duplicate. */
const DUPLICATE_WINDOW_SEC = 1.0;

/** Add proposed clips (skipping near-duplicates of existing ones) and queue their slicing. */
export function addProposedClips(proposed: HarvestClip[]): number {
  const s = useStore.getState().session;
  if (!s) return 0;
  const isDuplicate = (p: HarvestClip) =>
    s.clips.some((c) => c.source_path === p.source_path && Math.abs((c.anchor_sec ?? c.in_sec) - (p.anchor_sec ?? p.in_sec)) < DUPLICATE_WINDOW_SEC);
  let id = Number(/(\d+)$/.exec(nextClipId(s))?.[1]);
  const clips: Clip[] = proposed.filter((p) => !isDuplicate(p)).map((p) => ({
    ...p,
    clip_id: `c_${String(id++).padStart(3, '0')}`,
    proxy_status: 'pending',
  }));
  if (clips.length === 0) return 0;
  useStore.getState().update((cur) => ({ ...cur, clips: [...cur.clips, ...clips] }), true);
  for (const clip of clips) {
    api.slice(clip).catch((e: Error) => useStore.getState().setError(`Slice request failed for ${clip.clip_id}: ${e.message}`));
  }
  return clips.length;
}

/**
 * Harvest `count` energetic moments plus `breathers` calm range shots (count 0 = a B-roll
 * harvest) from `paths`, add them, and resolve with how many were added / skipped.
 * v1 picks straight from the keyframe scan; v2 refines the best candidates (see harvest_v2.py).
 */
export async function harvestClips(paths: string[], count: number, breathers: number, version: HarvestVersion,
  onProgress?: (phase: string, done: number, total: number) => void): Promise<{ added: number; skipped: number }> {
  await api.startHarvest(paths, count, breathers, version);
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const st = await api.harvestStatus();
    if (st.state === 'running') onProgress?.(st.phase ?? 'scanning', st.done ?? 0, st.total ?? paths.length);
    else if (st.state === 'error') throw new Error(st.error ?? 'harvest failed');
    else if (st.state === 'done') return { added: addProposedClips(st.clips ?? []), skipped: st.skipped ?? 0 };
  }
}
