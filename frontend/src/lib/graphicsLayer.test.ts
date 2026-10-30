import { describe, expect, it } from 'vitest';
import type { Logo, Session, TextConfig } from '../types/session';
import { ACCENTS, graphicsFrameKey, graphicsSchedule, layoutBlock, logoRect, parseInfoRows, TEXT_STYLE_IDS, textLook } from './graphicsLayer';
import { defaultZones } from './solver';
import { makeSession, TEST_STYLE, TEST_TEXT } from './testFixtures';
import { beatToFrame } from './timing';

/** intro 0-8, build 8-12, breather 12-16, drop 16-48 at 128 BPM / 60 fps. */
function session(text: Partial<TextConfig>, logos: Logo[] = []): Session {
  return makeSession({}, {
    zones: defaultZones(16),
    text_config: { ...TEST_TEXT, style_preset: 'RAVE_MONO', ...text },
    style: { ...TEST_STYLE, logos },
  });
}

const fr = (beat: number) => beatToFrame(beat, 128, 60);

describe('text schedule', () => {
  it('shows nothing for an empty config', () => {
    expect(graphicsSchedule(session({}))).toEqual([]);
    expect(graphicsSchedule(session({ intro_title: '   ', hook_words: [' ', ''], info_rows: [{ left: ' ', right: '' }] }))).toEqual([]);
  });

  it('pins the title across the intro zone', () => {
    const [title] = graphicsSchedule(session({ intro_title: 'BAILE TRAMA w/ SANTANA LOUIS' }));
    expect(title).toMatchObject({ kind: 'title', start: fr(0), end: fr(8) });
  });

  it('flashes one hook word per breather beat, then punches the next word on the drop', () => {
    const hooks = graphicsSchedule(session({ hook_words: ['ATENÇÃO', 'ATTENTION!'] })).filter((e) => e.kind === 'hook');
    expect(hooks.map((h) => [h.start, h.kind === 'hook' && h.text])).toEqual([
      [fr(12), 'ATENÇÃO'],
      [fr(13), 'ATTENTION!'],
      [fr(14), 'ATENÇÃO'],
      [fr(15), 'ATTENTION!'],
      [fr(16), 'ATENÇÃO'],
    ]);
    expect(hooks.at(-1)).toMatchObject({ drop: true, end: fr(17) });
  });

  it('reveals info rows on consecutive beats from the bar nearest the middle of the last drop', () => {
    const rows = [
      { left: 'BERLIN', right: '09/10' },
      { left: 'AMSTERDAM', right: '16/10' },
      { left: 'LONDON', right: '24/10' },
    ];
    const ev = graphicsSchedule(session({ info_rows: rows })).find((e) => e.kind === 'rows');
    // Drop zone 16-48: middle is beat 32, already on a bar line.
    expect(ev).toMatchObject({ start: fr(32), end: fr(48), rowStarts: [fr(32), fr(33), fr(34)] });
  });

  it('squeezes rows into a short drop instead of running past it', () => {
    const s = session({ info_rows: Array.from({ length: 5 }, (_, i) => ({ left: `CITY${i}`, right: '01/01' })) });
    s.sequence.zones = [{ start_beat: 0, end_beat: 4, type: 'HYBRID_DROP' }];
    const ev = graphicsSchedule(s).find((e) => e.kind === 'rows');
    expect(ev?.kind === 'rows' && ev.rowStarts.every((r) => r >= fr(0) && r < fr(4))).toBe(true);
  });
});

describe('title layout', () => {
  // Monospace stand-in: every character is 0.6 em wide.
  const measure = (t: string, size: number) => t.length * size * 0.6;

  it('shrinks the font instead of dropping words that need a 4th line', () => {
    const text = 'BAILE TRAMA W/ SANTANA LOUIS';
    const { size, lines } = layoutBlock(measure, text, 400, 120, 3);
    expect(lines.join(' ')).toBe(text); // regression: "LOUIS" used to be cut off
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(measure(l, size)).toBeLessThanOrEqual(400);
    expect(size).toBeLessThan(120);
  });

  it('keeps the starting size when the text already fits', () => {
    expect(layoutBlock(measure, 'HI', 400, 120, 3)).toEqual({ size: 120, lines: ['HI'] });
  });
});

describe('info row parsing', () => {
  it('splits on the first separator and keeps the rest intact', () => {
    expect(parseInfoRows('BERLIN + 09/10\r\n\n  AMSTERDAM|16/10  \nLONDON\t24/10\nSÃO PAULO + 01/11 + LATE')).toEqual([
      { left: 'BERLIN', right: '09/10' },
      { left: 'AMSTERDAM', right: '16/10' },
      { left: 'LONDON', right: '24/10' },
      { left: 'SÃO PAULO', right: '01/11 + LATE' },
    ]);
  });

  it('keeps a line without a separator as a left-only row', () => {
    expect(parseInfoRows('SOLD OUT')).toEqual([{ left: 'SOLD OUT', right: '' }]);
  });
});

describe('frame keys (export dedupe)', () => {
  it('is stable once an animation settles and changes while it runs', () => {
    const events = graphicsSchedule(session({ intro_title: 'HELLO' }));
    const k = (f: number) => graphicsFrameKey(events, f);
    expect(k(0)).not.toBe(k(1)); // popping in
    expect(k(10)).toBe(k(30)); // settled: same pixels, one PNG for the whole stretch
    expect(k(fr(8))).toBe(''); // after the intro
  });

  it('flickers the drop hook off on strobe frames', () => {
    const events = graphicsSchedule(session({ hook_words: ['GO'] }));
    expect(graphicsFrameKey(events, fr(16) + 2)).toBe('');
    expect(graphicsFrameKey(events, fr(16) + 3)).not.toBe('');
  });

  it('tracks every row when rows are revealed faster than they finish popping', () => {
    const s = session({ info_rows: Array.from({ length: 8 }, (_, i) => ({ left: `R${i}`, right: 'x' })) });
    s.sequence.zones = [{ start_beat: 0, end_beat: 2, type: 'HYBRID_DROP' }];
    const events = graphicsSchedule(s);
    const ev = events.find((e) => e.kind === 'rows');
    if (ev?.kind !== 'rows') throw new Error('expected rows');
    // Rows 0.25 beat (~7 frames) apart: row 0 is still settling when row 1 appears.
    const f = ev.rowStarts[1] + 1;
    expect(graphicsFrameKey(events, f)).not.toBe(graphicsFrameKey(events, f + 1));
  });
});

describe('end card, recipes and animation choice', () => {
  const logo = (over: Partial<Logo>): Logo => ({ path: '/assets/l.png', placement: 'TOP_LEFT', width_frac: 0.3, when: 'ALWAYS', motion: 'STATIC', ...over });

  it('puts rows + CTA on the OUTRO zone, or the CTA alone over the last 4 beats', () => {
    const rows = [{ left: 'BERLIN', right: '09/10' }];
    const s = session({ info_rows: rows, cta: 'TICKETS · LINK IN BIO' });
    s.sequence.zones = [...defaultZones(16).slice(0, -1), { start_beat: 16, end_beat: 40, type: 'HYBRID_DROP' }, { start_beat: 40, end_beat: 48, type: 'OUTRO' }];
    expect(graphicsSchedule(s).find((e) => e.kind === 'endcard')).toMatchObject({ start: fr(40), end: fr(48), rows, cta: 'TICKETS · LINK IN BIO' });
    const noOutro = graphicsSchedule(session({ cta: 'TICKETS' })).find((e) => e.kind === 'endcard');
    expect(noOutro).toMatchObject({ start: fr(44), end: fr(48), rows: [] });
  });

  it('shows the title over the opening bars when there is no intro zone (hook-first)', () => {
    const s = session({ intro_title: 'HELLO' });
    s.sequence.zones = [{ start_beat: 0, end_beat: 4, type: 'STUTTER_BUILD' }, { start_beat: 4, end_beat: 28, type: 'HYBRID_DROP' }];
    expect(graphicsSchedule(s).find((e) => e.kind === 'title')).toMatchObject({ start: fr(0), end: fr(4) });
  });

  it('resolves AUTO animations per seed (varied, but reproducible) and respects explicit choices', () => {
    const anims = (seed: number) => {
      const s = session({ intro_title: 'X', title_anim: 'AUTO', hook_words: ['A', 'B'], hook_anim: 'AUTO' });
      s.sequence.seed = seed;
      return graphicsSchedule(s).filter((e) => e.kind === 'title' || (e.kind === 'hook' && !e.drop)).map((e) => ('anim' in e ? e.anim : ''));
    };
    expect(anims(3)).toEqual(anims(3));
    const seen = new Set(Array.from({ length: 12 }, (_, i) => anims(i).join()));
    expect(seen.size).toBeGreaterThan(1);
    const fixed = graphicsSchedule(session({ intro_title: 'X', title_anim: 'TYPEWRITER' })).find((e) => e.kind === 'title');
    expect(fixed).toMatchObject({ anim: 'TYPEWRITER' });
  });

  it('places logo windows by timing setting', () => {
    const s = session({}, [logo({ when: 'DROP' }), logo({ when: 'OUTRO' })]);
    const logos = graphicsSchedule(s).filter((e) => e.kind === 'logo');
    expect(logos.map((e) => [e.start, e.end])).toEqual([[fr(16), fr(48)], [fr(44), fr(48)]]); // no OUTRO zone: last 4 beats
  });

  it('keys logos so static ones upload once and pulses only change around beats', () => {
    const still = graphicsSchedule(session({}, [logo({ motion: 'STATIC' })]));
    expect(graphicsFrameKey(still, 10)).toBe(graphicsFrameKey(still, 900));
    const pulse = graphicsSchedule(session({}, [logo({ motion: 'PULSE' })]));
    const b = fr(20);
    expect(graphicsFrameKey(pulse, b)).not.toBe(graphicsFrameKey(pulse, b + 1)); // pulsing on the beat
    expect(graphicsFrameKey(pulse, b + 14)).toBe(graphicsFrameKey(pulse, b + 20)); // settled between beats
    const jitter = graphicsSchedule(session({}, [logo({ motion: 'JITTER' })]));
    expect(graphicsFrameKey(jitter, 30)).toBe(graphicsFrameKey(jitter, 32));
    expect(graphicsFrameKey(jitter, 32)).not.toBe(graphicsFrameKey(jitter, 33));
  });
});

describe('title placement without an intro zone', () => {
  it('never overlaps a hook word: no room before the first hook means no title', () => {
    const s = session({ intro_title: 'HELLO', hook_words: ['GO'] });
    s.sequence.zones = [{ start_beat: 0, end_beat: 4, type: 'VOCAL_BREATHER' }, { start_beat: 4, end_beat: 28, type: 'HYBRID_DROP' }];
    expect(graphicsSchedule(s).some((e) => e.kind === 'title')).toBe(false);
    s.sequence.text_config = { ...s.sequence.text_config, hook_words: [] };
    expect(graphicsSchedule(s).find((e) => e.kind === 'title')).toMatchObject({ start: fr(0), end: fr(4) });
  });
});

describe('auto text look and logo geometry', () => {
  it('AUTO picks a style and accent per seed; explicit choices win', () => {
    const look = (seed: number, style: TextConfig['style_preset'] = 'AUTO', accent = 'AUTO') =>
      textLook({ seed, text_config: { ...TEST_TEXT, style_preset: style, accent } });
    expect(look(5)).toEqual(look(5));
    const styles = new Set(Array.from({ length: 40 }, (_, s) => look(s).style));
    expect(styles.size).toBeGreaterThan(4);
    for (const s of styles) expect(TEXT_STYLE_IDS).toContain(s);
    expect(ACCENTS).toContain(look(3).accent);
    expect(look(3, 'NEON', '#123456')).toEqual({ style: 'NEON', accent: '#123456' });
  });

  it('places a dragged logo by its centre and presets inside the safe area', () => {
    const base: Logo = { path: 'p', placement: 'CUSTOM', x: 0.25, y: 0.4, width_frac: 0.2, when: 'ALWAYS', motion: 'STATIC' };
    const [x, y, w, h] = logoRect(base, 2, 1080, 1920);
    expect([x + w / 2, y + h / 2]).toEqual([270, 768]);
    expect([w, h]).toEqual([216, 108]);
    const [tx, , tw] = logoRect({ ...base, placement: 'TOP_RIGHT', x: null, y: null }, 2, 1080, 1920);
    expect(tx + tw).toBeCloseTo(1080 * 0.88); // clear of the right-edge buttons
    const [, ly, , lh] = logoRect({ ...base, placement: 'LOWER_THIRD', x: null, y: null }, 2, 1080, 1920);
    expect(ly + lh).toBeLessThan(1920 * 0.75); // clear of the bottom quarter
  });
});
