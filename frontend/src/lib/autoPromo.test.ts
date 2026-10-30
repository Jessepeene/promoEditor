import { describe, expect, it } from 'vitest';
import { planPromo, VIDEO_TYPES, type VideoTypeId } from './autoPromo';

const type = (id: VideoTypeId) => VIDEO_TYPES.find((t) => t.id === id)!;
const bd = 60 / 128;

function contiguous(zones: { start_beat: number; end_beat: number }[]) {
  let t = 0;
  for (const z of zones) {
    expect(z.start_beat).toBe(t);
    t = z.end_beat;
  }
  return t;
}

describe('planPromo', () => {
  it('hits the requested length in whole bars and keeps the song drop on the drop beat', () => {
    for (const t of VIDEO_TYPES) {
      for (const len of [15, 30, 60]) {
        const p = planPromo(t, len, 128, 60, 240);
        const end = contiguous(p.zones);
        expect(end % 4, `${t.id} ${len}s`).toBe(0);
        expect(Math.abs(end * bd - len), `${t.id} ${len}s`).toBeLessThan(4 * bd); // within a bar
        expect(p.beat_1_offset_sec + p.drop_beat_index * bd).toBeCloseTo(60, 2);
        expect(p.zones.find((z) => z.type === 'HYBRID_DROP')!.start_beat).toBe(p.drop_beat_index);
        expect(p.zones.at(-1)!.type).toBe('OUTRO');
      }
    }
  });

  it('applies each type’s run-up: story intro, car build + breather, teaser straight in', () => {
    const story = planPromo(type('DANCER_STORY'), 30, 128, 60, 240).zones.map((z) => z.type);
    expect(story.slice(0, 2)).toEqual(['INTRO_STORY', 'VOCAL_BREATHER']);
    const car = planPromo(type('CAR_VELOCITY'), 30, 128, 60, 240).zones.map((z) => z.type);
    expect(car.slice(0, 3)).toEqual(['INTRO_STORY', 'STUTTER_BUILD', 'VOCAL_BREATHER']);
    const teaser = planPromo(type('TEASER'), 15, 128, 60, 240).zones.map((z) => z.type);
    expect(teaser).toEqual(['STUTTER_BUILD', 'HYBRID_DROP', 'OUTRO']);
  });

  it('shrinks the run-up when the drop comes early in the song (never before the song starts)', () => {
    const p = planPromo(type('DANCER_STORY'), 30, 128, 3 * bd + 0.1, 240); // only 3 beats before the drop
    expect(p.drop_beat_index).toBe(0);
    expect(p.beat_1_offset_sec).toBeGreaterThanOrEqual(0);
    expect(p.zones[0].type).toBe('HYBRID_DROP');
  });

  it('ends the drop and outro with the song', () => {
    const p = planPromo(type('TEASER'), 60, 128, 60, 60 + 20 * bd); // 20 beats of song after the drop
    expect(p.zones.at(-1)!.end_beat - p.drop_beat_index).toBeLessThanOrEqual(20);
  });
});
