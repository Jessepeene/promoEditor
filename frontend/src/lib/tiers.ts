import type { Clip } from '../types/session';

/**
 * Move a clip to energy tier `tier` (0 breather, 1–4 anchor energy).
 * Crossing between breather and anchor converts the clip type: an anchor becomes a
 * breather over its existing window; a breather becomes an anchor at its midpoint.
 * The in/out window never changes, so the existing proxy stays valid.
 */
export function withTier(clip: Clip, tier: number): Clip {
  if (!Number.isInteger(tier) || tier < 0 || tier > 4) throw new Error(`invalid tier ${tier}`);
  if (tier === clip.energy_tag) return clip;
  if (tier === 0) return { ...clip, mode: 'RANGE', anchor_sec: null, energy_tag: 0 };
  if (clip.mode === 'RANGE') return { ...clip, mode: 'ANCHOR', anchor_sec: (clip.in_sec + clip.out_sec) / 2, energy_tag: tier };
  return { ...clip, energy_tag: tier };
}

/** `+`/`−` on a card: step an anchor clip within 1–4. Breathers are left alone (use the library to convert). */
export function bumpTier(clip: Clip, delta: 1 | -1): Clip {
  if (clip.mode === 'RANGE') return clip;
  return withTier(clip, Math.min(4, Math.max(1, clip.energy_tag + delta)));
}
