import { describe, expect, it } from 'vitest';
import type { Clip } from '../types/session';
import { bumpTier, withTier } from './tiers';

const anchor: Clip = { clip_id: 'a', source_path: 'x', mode: 'ANCHOR', in_sec: 4, anchor_sec: 6, out_sec: 8, energy_tag: 2, focus_xy: [0.5, 0.5] };
const breather: Clip = { clip_id: 'b', source_path: 'x', mode: 'RANGE', in_sec: 1, anchor_sec: null, out_sec: 5, energy_tag: 0, focus_xy: [0.5, 0.5] };

describe('tiers', () => {
  it('bumps anchors within 1-4 and clamps at the ends', () => {
    expect(bumpTier(anchor, 1).energy_tag).toBe(3);
    expect(bumpTier({ ...anchor, energy_tag: 4 }, 1).energy_tag).toBe(4);
    expect(bumpTier({ ...anchor, energy_tag: 1 }, -1).energy_tag).toBe(1);
  });

  it('leaves breathers alone on +/-', () => {
    expect(bumpTier(breather, 1)).toBe(breather);
  });

  it('converts across the breather boundary without touching the window', () => {
    const asBreather = withTier(anchor, 0);
    expect(asBreather).toMatchObject({ mode: 'RANGE', anchor_sec: null, energy_tag: 0, in_sec: 4, out_sec: 8 });
    const asAnchor = withTier(breather, 3);
    expect(asAnchor).toMatchObject({ mode: 'ANCHOR', anchor_sec: 3, energy_tag: 3, in_sec: 1, out_sec: 5 });
  });

  it('rejects tiers outside 0-4', () => {
    expect(() => withTier(anchor, 5)).toThrow();
    expect(() => withTier(anchor, 1.5)).toThrow();
  });
});
