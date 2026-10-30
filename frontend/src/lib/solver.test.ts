import { describe, expect, it } from 'vitest';
import type { Clip, Session } from '../types/session';
import { applyRecipe, cycleLayout, defaultZones, LAYOUT_PRESETS, solve, ZONE_RECIPES } from './solver';
import { makeSession, TEST_STYLE } from './testFixtures';

const COLORS = ['blue', 'red', 'magenta', 'dark_ambient', 'green', 'orange'];

/** 40 clips from 10 source files: 8 per tier 0-4, colours cycling. */
function clips(): Clip[] {
  const out: Clip[] = [];
  for (let i = 0; i < 40; i++) {
    const tier = Math.floor(i / 8) % 5;
    out.push({
      clip_id: `c_${String(i).padStart(3, '0')}`, source_path: `/raw/${i % 10}.mp4`, mode: tier === 0 ? 'RANGE' : 'ANCHOR',
      in_sec: 10, anchor_sec: tier === 0 ? null : 12, out_sec: 14, energy_tag: tier, focus_xy: [0.5, 0.5],
      color_tag: COLORS[i % COLORS.length],
    });
  }
  return out;
}

function session(): Session {
  return makeSession({ clips: clips() }, {
    beat_1_offset_sec: 0.5, zones: defaultZones(16), seed: 7, style: { ...TEST_STYLE, vhs_glitch: true },
  });
}

/** One clip per card (no build zone, fullscreen-only drop) so per-card rules can be checked exactly. */
function singleClipSession(): Session {
  const s = session();
  s.sequence.zones = [
    { start_beat: 0, end_beat: 12, type: 'INTRO_STORY' },
    { start_beat: 12, end_beat: 16, type: 'VOCAL_BREATHER' },
    { start_beat: 16, end_beat: 48, type: 'HYBRID_DROP' },
  ];
  s.sequence.style = { ...s.sequence.style, layout_weights: LAYOUT_PRESETS[0].weights }; // fullscreen only
  return s;
}

const sourceOf = (s: Session, clipId: string) => s.clips.find((c) => c.clip_id === clipId)!.source_path;
const colorOf = (s: Session, clipId: string) => s.clips.find((c) => c.clip_id === clipId)!.color_tag;

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
    // Heroes come from the peak tiers; cooldown + colour spread share them between 4 and 3.
    expect(heroTags.every((t) => t === 4 || t === 3)).toBe(true);
    expect(heroTags.filter((t) => t === 4).length).toBeGreaterThanOrEqual(heroTags.filter((t) => t === 3).length);
    const breather = slots.find((x) => x.zone_type === 'VOCAL_BREATHER')!;
    expect(s.clips.find((c) => c.clip_id === breather.cells[0].clip_id)!.energy_tag).toBe(0);
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
    for (let i = 0; i < 5; i++) {
      slot = cycleLayout(s, slot);
      seen.push(slot.layout);
      expect(slot.cells[0].clip_id).toBe(main);
    }
    expect(seen).toEqual(['FULLSCREEN_VELOCITY', 'STACK_3_ROW', 'CENTER_PIP_PUNCH', 'STROBE_MATRIX', 'SPLIT_2', 'FULLSCREEN_VELOCITY']);
  });

  it('never repeats a source file within the cooldown window', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = singleClipSession();
      const slots = solve(s, seed);
      for (let i = 0; i < slots.length; i++) {
        for (let j = Math.max(0, i - 4); j < i; j++) {
          expect(sourceOf(s, slots[i].cells[0].clip_id), `seed ${seed}, cards ${j} and ${i}`).not.toBe(sourceOf(s, slots[j].cells[0].clip_id));
        }
      }
    }
  });

  it('never puts the same dominant colour on two cards in a row', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = singleClipSession();
      const slots = solve(s, seed);
      for (let i = 1; i < slots.length; i++) {
        expect(colorOf(s, slots[i].cells[0].clip_id)).not.toBe(colorOf(s, slots[i - 1].cells[0].clip_id));
      }
    }
  });

  it('respects cooldown around a locked card', () => {
    const s = singleClipSession();
    const keep = { ...solve(s, 1).find((x) => x.start_beat === 20)!, locked: true };
    s.sequence.slots = [keep];
    const slots = solve(s, 42);
    const at = slots.findIndex((x) => x.slot_id === keep.slot_id);
    const lockedSource = sourceOf(s, keep.cells[0].clip_id);
    for (const after of slots.slice(at + 1, at + 5)) expect(sourceOf(s, after.cells[0].clip_id)).not.toBe(lockedSource);
  });

  it('falls back to an adjacent tier with a micro-zoom when the wanted tier is missing', () => {
    const s = singleClipSession();
    s.clips = s.clips.filter((c) => c.energy_tag === 3); // no vibe/groove clips for the intro
    const intro = solve(s).filter((x) => x.zone_type === 'INTRO_STORY');
    expect(intro.length).toBeGreaterThan(0);
    for (const slot of intro) {
      expect(s.clips.find((c) => c.clip_id === slot.cells[0].clip_id)!.energy_tag).toBe(3);
      expect(slot.fx.bounce).toBe(true);
    }
    // With the right tiers available, intro cards don't get the zoom.
    for (const slot of solve(singleClipSession()).filter((x) => x.zone_type === 'INTRO_STORY')) expect(slot.fx.bounce).toBe(false);
  });

  it('still fills every card from a tiny pool by relaxing the rules', () => {
    const s = session();
    s.clips = s.clips.filter((c) => c.source_path === '/raw/1.mp4' || c.source_path === '/raw/2.mp4');
    const slots = solve(s);
    expect(slots.every((x) => x.cells.length > 0)).toBe(true);
  });

  it('keeps the drop on drop_beat_index for early drops', () => {
    for (const d of [0, 2, 4, 6, 9, 16, 32]) {
      const zones = defaultZones(d);
      expect(zones.find((z) => z.type === 'HYBRID_DROP')!.start_beat).toBe(d);
      expect(zones[0].start_beat).toBe(0);
    }
  });
});

describe('clip quality', () => {
  const softIds = (s: Session) => new Set(s.clips.filter((_, i) => i % 4 === 3).map((c) => c.clip_id));
  const withQuality = (s: Session, measured: boolean) => {
    const soft = softIds(s);
    s.clips = s.clips.map((c) => ({ ...c, quality: measured ? (soft.has(c.clip_id) ? 0.2 : 0.9) : null }));
    return s;
  };
  const softFullFrame = (s: Session, seed: number) =>
    solve(s, seed).flatMap((x) => x.cells).filter((c) => c.region === 'full' && softIds(s).has(c.clip_id)).length;

  it('keeps soft clips off full screen when sharp ones can fill it', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      // Control: unmeasured, the same clips do land full screen, so the rule below is what keeps them off.
      expect(softFullFrame(withQuality(singleClipSession(), false), seed)).toBeGreaterThan(0);
      expect(softFullFrame(withQuality(singleClipSession(), true), seed)).toBe(0);
    }
  });

  it('still uses soft clips in small cells and as a last resort', () => {
    const mixed = withQuality(session(), true);
    const soft = softIds(mixed);
    expect(solve(mixed).flatMap((x) => x.cells).some((c) => c.region !== 'full' && soft.has(c.clip_id))).toBe(true);
    const allSoft = singleClipSession();
    allSoft.clips = allSoft.clips.map((c) => ({ ...c, quality: 0.1 }));
    expect(solve(allSoft).every((x) => x.cells.length > 0)).toBe(true);
  });
});

describe('zone recipes, outro and effect intensity', () => {
  it('every recipe tiles from beat 0, drops on its drop beat and ends on an end card', () => {
    for (const r of ZONE_RECIPES) {
      const { zones, drop } = r.build(16);
      let t = 0;
      for (const z of zones) {
        expect(z.start_beat, r.id).toBe(t);
        t = z.end_beat;
      }
      expect(zones.find((z) => z.type === 'HYBRID_DROP')!.start_beat, r.id).toBe(drop);
      expect(zones.at(-1)!.type, r.id).toBe('OUTRO');
    }
  });

  it('fills the outro with calm, dimmed, slowly pulling-out cards', () => {
    const s = session();
    s.sequence.zones = ZONE_RECIPES.find((r) => r.id === 'STORY')!.build(16).zones;
    const outro = solve(s).filter((x) => x.zone_type === 'OUTRO');
    expect(outro.length).toBeGreaterThan(0);
    for (const slot of outro) {
      expect(slot.fx).toMatchObject({ dim: true, push: 'OUT', speed_ramp: false });
      expect([0, 1]).toContain(s.clips.find((c) => c.clip_id === slot.cells[0].clip_id)!.energy_tag);
    }
  });

  it('uses no optional effects at intensity 0 and more of them at 2', () => {
    const count = (k: number) => {
      const s = session();
      s.sequence.style = { ...s.sequence.style, fx_intensity: k };
      return solve(s).reduce((n, x) => n + Number(x.fx.shake) + Number(x.fx.invert) + Number(x.fx.strobe) + Number(x.fx.mirror) + Number(x.fx.echo) + Number(x.fx.push !== 'NONE'), 0);
    };
    expect(count(0)).toBe(0);
    expect(count(2)).toBeGreaterThan(count(1));
  });

  it('never puts invert or mirror on two cards in a row', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = session();
      s.sequence.style = { ...s.sequence.style, fx_intensity: 2 };
      const slots = solve(s, seed);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].fx.invert && slots[i - 1].fx.invert).toBe(false);
        expect(slots[i].fx.mirror && slots[i - 1].fx.mirror).toBe(false);
      }
    }
  });

  it('builds split cards with a held half and a swapping half', () => {
    const s = session();
    s.sequence.style = { ...s.sequence.style, layout_weights: { FULLSCREEN_VELOCITY: 0, STACK_3_ROW: 0, CENTER_PIP_PUNCH: 0, STROBE_MATRIX: 0, SPLIT_2: 1 } };
    const split = solve(s).find((x) => x.layout === 'SPLIT_2' && x.duration_beats >= 2)!;
    expect(split.cells.filter((c) => c.region === 'half0')).toHaveLength(1);
    expect(split.cells.filter((c) => c.region === 'half1').length).toBe(split.duration_beats);
  });
});

describe('applyRecipe', () => {
  it('keeps the same moment of the song on the drop beat', () => {
    const s = session(); // drop at beat 16, beat 0 at 0.5 s
    const dropTime = s.sequence.beat_1_offset_sec + 16 * (60 / 128);
    for (const r of ZONE_RECIPES) {
      const next = applyRecipe(s.sequence, r);
      expect(next.beat_1_offset_sec + next.drop_beat_index * (60 / 128)).toBeCloseTo(dropTime, 2);
    }
  });
});
