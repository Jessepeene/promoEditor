import { describe, expect, it } from 'vitest';
import type { Clip, Session } from '../types/session';
import { cycleLayout, defaultZones, solve } from './solver';

function clips(): Clip[] {
  const out: Clip[] = [];
  for (let i = 0; i < 24; i++) {
    const tag = (i % 4) + 1;
    out.push({
      clip_id: `c_${String(i).padStart(3, '0')}`, source_path: `/raw/${i}.mp4`, mode: tag === 4 ? 'RANGE' : 'ANCHOR',
      in_sec: 10, anchor_sec: tag === 4 ? null : 12, out_sec: 14, energy_tag: tag, focus_xy: [0.5, 0.5],
    });
  }
  return out;
}

function session(): Session {
  return {
    project_id: 'p', target_aspect: '9:16', resolution: [1080, 1920], fps: 60, clips: clips(), source_folders: [],
    sequence: {
      bpm: 128, beat_1_offset_sec: 0.5, drop_beat_index: 16, zones: defaultZones(16), slots: [], seed: 7,
      style: {
        bounce: true, rgb_split: true, vhs_glitch: true, overlay: { motion: 'STATIC', width_frac: 0.8 },
        layout_weights: { FULLSCREEN_VELOCITY: 0.4, STACK_3_ROW: 0.25, CENTER_PIP_PUNCH: 0.2, STROBE_MATRIX: 0.15 },
      },
    },
  };
}

describe('solver', () => {
  it('is deterministic per seed and changes with the seed', () => {
    const s = session();
    expect(solve(s, 7)).toEqual(solve(s, 7));
    expect(solve(s, 8)).not.toEqual(solve(s, 7));
  });

  it('tiles every zone exactly with no overlaps', () => {
    const s = session();
    const slots = solve(s);
    let t = 0;
    for (const slot of slots) {
      expect(slot.start_beat).toBeCloseTo(t, 6);
      t = slot.start_beat + slot.duration_beats;
    }
    expect(t).toBeCloseTo(48, 6);
  });

  it('follows each zone recipe', () => {
    const slots = solve(session());
    const build = slots.filter((s) => s.zone_type === 'STUTTER_BUILD').map((s) => s.duration_beats);
    expect(build).toEqual([...build].sort((a, b) => b - a)); // accelerating cuts
    expect(build.at(-1)).toBe(0.25);
    const breather = slots.filter((s) => s.zone_type === 'VOCAL_BREATHER');
    expect(breather).toHaveLength(1);
    expect(breather[0].fx.speed).toBe(0.75);
    expect(breather[0].cells).toHaveLength(1);
    const drop = slots.find((s) => s.start_beat === 16)!;
    expect(drop.fx.transition).toBe('FLASH');
    for (const m of slots.filter((s) => s.layout === 'STROBE_MATRIX')) {
      for (const c of m.cells) expect((c.start * 8) % 1).toBeCloseTo(0, 6); // on the 32nd grid
    }
  });

  it('only uses clips from the pool and prefers peak clips for hero shots', () => {
    const s = session();
    const ids = new Set(s.clips.map((c) => c.clip_id));
    const slots = solve(s);
    for (const slot of slots) for (const c of slot.cells) expect(ids.has(c.clip_id)).toBe(true);
    const heroTags = slots
      .filter((x) => x.zone_type === 'HYBRID_DROP' && x.layout === 'FULLSCREEN_VELOCITY')
      .map((x) => s.clips.find((c) => c.clip_id === x.cells[0].clip_id)!.energy_tag);
    expect(heroTags.filter((t) => t === 3).length).toBeGreaterThan(heroTags.length / 2);
  });

  it('keeps locked slots and rerolls around them', () => {
    const s = session();
    const first = solve(s, 1);
    const keep = { ...first.find((x) => x.start_beat >= 20 && x.zone_type === 'HYBRID_DROP')!, locked: true };
    s.sequence.slots = [keep];
    const second = solve(s, 99);
    expect(second.find((x) => x.slot_id === keep.slot_id)).toEqual(keep);
    let t = 0;
    for (const slot of second) {
      expect(slot.start_beat).toBeCloseTo(t, 6);
      t = slot.start_beat + slot.duration_beats;
    }
  });

  it('cycles layouts in spec order keeping the main clip', () => {
    const s = session();
    let slot = solve(s).find((x) => x.layout === 'FULLSCREEN_VELOCITY' && x.zone_type === 'HYBRID_DROP')!;
    const main = slot.cells[0].clip_id;
    const seen = [slot.layout];
    for (let i = 0; i < 4; i++) {
      slot = cycleLayout(s, slot);
      seen.push(slot.layout);
      expect(slot.cells[0].clip_id).toBe(main);
    }
    expect(seen).toEqual(['FULLSCREEN_VELOCITY', 'STACK_3_ROW', 'CENTER_PIP_PUNCH', 'STROBE_MATRIX', 'FULLSCREEN_VELOCITY']);
  });

  it('keeps the drop on drop_beat_index for early drops', () => {
    for (const d of [0, 2, 4, 6, 9, 16, 32]) {
      const zones = defaultZones(d);
      expect(zones.find((z) => z.type === 'HYBRID_DROP')!.start_beat).toBe(d);
      expect(zones[0].start_beat).toBe(0);
    }
  });
});
