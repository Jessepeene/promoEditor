// The "slot machine": turns zones + the clip pool into Beat Cards (slots).
// Deterministic for a given seed; locked slots are kept and the gaps around
// them are re-rolled.

import type { Cell, Clip, LayoutParams, LayoutType, Session, Slot, SlotFx, Zone, ZoneType } from '../types/session';
import { DEFAULT_FX, DEFAULT_LAYOUT_PARAMS, LAYOUTS } from '../types/session';
import { Rng } from './rng';
import { matrixDims } from './timing';

const EPS = 1e-6;

/** Tags each role prefers, best first. Later tags are fallbacks with lower weight. */
const ROLE_TAGS = {
  story: [1, 4, 2],
  stutter: [2, 3, 1],
  breather: [4, 2],
  hero: [3, 2],
  stack: [2, 1, 3],
  pipFront: [2, 3],
  matrix: [1, 2],
} as const;
type Role = keyof typeof ROLE_TAGS;

class ClipPool {
  private uses = new Map<string, number>();
  private recent: string[] = [];

  constructor(private clips: Clip[], private rng: Rng) {}

  get size() {
    return this.clips.length;
  }

  pick(role: Role, exclude: Set<string> = new Set()): Clip | null {
    const tags = ROLE_TAGS[role];
    let candidates = this.clips.filter((c) => tags.includes(c.energy_tag as never) && !exclude.has(c.clip_id));
    if (candidates.length === 0) candidates = this.clips.filter((c) => !exclude.has(c.clip_id));
    if (candidates.length === 0) candidates = this.clips;
    if (candidates.length === 0) return null;
    const recentWindow = new Set(this.recent.slice(-Math.min(6, Math.floor(this.clips.length / 2))));
    const clip = this.rng.weighted(candidates, (c) => {
      const rank = tags.indexOf(c.energy_tag as never);
      const tagW = rank < 0 ? 0.15 : [1, 0.45, 0.2][rank] ?? 0.2;
      const freshness = 1 / (1 + (this.uses.get(c.clip_id) ?? 0));
      return tagW * freshness * (recentWindow.has(c.clip_id) ? 0.1 : 1);
    });
    this.uses.set(clip.clip_id, (this.uses.get(clip.clip_id) ?? 0) + 1);
    this.recent.push(clip.clip_id);
    return clip;
  }
}

interface Ctx {
  session: Session;
  rng: Rng;
  pool: ClipPool;
}

function cell(region: string, clip: Clip | null, start = 0, end: number | null = null, lock: Cell['anchor_lock'] = 'DOWNBEAT'): Cell[] {
  return clip ? [{ region, clip_id: clip.clip_id, start, end, slip_frames: 0, anchor_lock: lock }] : [];
}

function makeSlot(start: number, dur: number, zone: ZoneType, layout: LayoutType, cells: Cell[],
  fx: Partial<SlotFx> = {}, params: Partial<LayoutParams> = {}): Slot {
  return {
    slot_id: `s_${Math.round(start * 1000)}`,
    start_beat: start,
    duration_beats: dur,
    zone_type: zone,
    layout,
    layout_params: { ...DEFAULT_LAYOUT_PARAMS, ...params },
    locked: false,
    cells,
    fx: { ...DEFAULT_FX, ...fx },
  };
}

// ---------------------------------------------------------------------------
// Layout cell builders (also used by "cycle layout")
// ---------------------------------------------------------------------------

export function buildCells(layout: LayoutType, dur: number, ctx: Ctx, params: LayoutParams, primary?: Clip | null): Cell[] {
  const { pool, rng } = ctx;
  switch (layout) {
    case 'FULLSCREEN_VELOCITY':
      return cell('full', primary ?? pool.pick('hero'));
    case 'STACK_3_ROW': {
      // Outer rows hold; the centre row swaps every 1/2 beat.
      const top = primary ?? pool.pick('stack');
      const used = new Set(top ? [top.clip_id] : []);
      const bottom = pool.pick('stack', used);
      if (bottom) used.add(bottom.clip_id);
      const cells = [...cell('row0', top, 0, null, 'MIDPOINT'), ...cell('row2', bottom, 0, null, 'MIDPOINT')];
      const step = dur >= 1 ? 0.5 : dur / 2;
      for (let b = 0; b < dur - EPS; b += step) {
        cells.push(...cell('row1', pool.pick('stack', used), b, Math.min(b + step, dur)));
      }
      return cells;
    }
    case 'CENTER_PIP_PUNCH': {
      const cells: Cell[] =
        params.pip_background === 'STACK'
          ? [0, 1, 2].flatMap((i) => cell(`row${i}`, i === 0 && primary ? primary : pool.pick('stack'), 0, null, 'MIDPOINT'))
          : cell('full', primary ?? pool.pick('hero'), 0, null, 'MIDPOINT');
      // Foreground punches on the off-beats (snare positions).
      const punches = dur >= 1 ? Math.floor(dur + EPS) : 1;
      for (let i = 0; i < punches; i++) {
        const a = dur >= 1 ? i + 0.5 : dur / 2;
        const b = Math.min(a + 0.5, dur);
        if (b - a > EPS) cells.push(...cell('pip', pool.pick('pipFront'), a, b));
      }
      return cells;
    }
    case 'STROBE_MATRIX': {
      const [cols, rows] = matrixDims(params.matrix);
      const n = cols * rows;
      const order = rng.chance(0.5) ? [...Array(n).keys()] : rng.shuffle([...Array(n).keys()]);
      // 16th-note pop-ins; 32nds if the slot is too short to show every cell on 16ths.
      const interval = n * 0.25 <= dur - 0.25 + EPS ? 0.25 : 0.125;
      const used = new Set<string>();
      return order.flatMap((region, k) => {
        const clip = k === 0 && primary ? primary : pool.pick('matrix', pool.size > n ? used : undefined);
        if (clip) used.add(clip.clip_id);
        return cell(`m${region}`, clip, Math.min(k * interval, Math.max(dur - interval, 0)), null, 'MIDPOINT');
      });
    }
  }
}

function randomParams(layout: LayoutType, rng: Rng): Partial<LayoutParams> {
  if (layout === 'STROBE_MATRIX') return { matrix: rng.pick(['3x3', '3x3', '3x4', '2x5'] as const) };
  if (layout === 'CENTER_PIP_PUNCH')
    return { pip_aspect: rng.pick(['1:1', '4:3'] as const), pip_background: rng.chance(0.3) ? 'STACK' : 'FULLSCREEN' };
  return {};
}

// ---------------------------------------------------------------------------
// Zone generators
// ---------------------------------------------------------------------------

function introStory(a: number, b: number, ctx: Ctx): Slot[] {
  const out: Slot[] = [];
  let t = a;
  while (b - t > EPS) {
    let len = t % 4 < EPS && b - t >= 4 ? ctx.rng.pick([2, 4, 4]) : 2;
    if (b - t - len < 2 - EPS) len = b - t; // don't leave a sliver
    out.push(makeSlot(t, len, 'INTRO_STORY', 'FULLSCREEN_VELOCITY',
      cell('full', ctx.pool.pick('story'), 0, null, 'MIDPOINT'),
      { speed_ramp: false, transition: out.length && ctx.rng.chance(0.4) ? 'CROSSFADE' : 'CUT' }));
    t += len;
  }
  return out;
}

function stutterBuild(a: number, b: number, ctx: Ctx): Slot[] {
  // 1 beat -> 1/2 beat -> 1/4 beat machine-gun flashes into the drop.
  const len = b - a;
  const q = (x: number, step: number) => Math.round(x / step) * step;
  const halfStart = a + q(len * 0.5, 1);
  const quarterStart = Math.max(halfStart, a + q(len * 0.75, 0.5));
  const out: Slot[] = [];
  let t = a;
  let i = 0;
  while (b - t > EPS) {
    const step = t < halfStart - EPS ? 1 : t < quarterStart - EPS ? 0.5 : 0.25;
    const dur = Math.min(step, b - t);
    const stack = step === 1 && i % 4 === 3 && dur >= 1 - EPS;
    out.push(makeSlot(t, dur, 'STUTTER_BUILD', stack ? 'STACK_3_ROW' : 'FULLSCREEN_VELOCITY',
      stack ? buildCells('STACK_3_ROW', dur, ctx, DEFAULT_LAYOUT_PARAMS) : cell('full', ctx.pool.pick('stutter')),
      { transition: step === 0.25 && i % 2 ? 'FLASH' : 'CUT' }));
    t += dur;
    i++;
  }
  return out;
}

function vocalBreather(a: number, b: number, ctx: Ctx): Slot[] {
  // One continuous clip per <=4 beats, in 0.75x slow motion, no cuts.
  const out: Slot[] = [];
  const pieces = Math.max(1, Math.ceil((b - a) / 4 - EPS));
  const len = (b - a) / pieces;
  for (let i = 0; i < pieces; i++) {
    out.push(makeSlot(a + i * len, len, 'VOCAL_BREATHER', 'FULLSCREEN_VELOCITY',
      cell('full', ctx.pool.pick('breather'), 0, null, 'MIDPOINT'), { speed_ramp: false, speed: 0.75 }));
  }
  return out;
}

const LAYOUT_DUR: Record<LayoutType, number> = {
  FULLSCREEN_VELOCITY: 1,
  STACK_3_ROW: 2,
  CENTER_PIP_PUNCH: 2,
  STROBE_MATRIX: 4,
};

function hybridDrop(a: number, b: number, ctx: Ctx): Slot[] {
  const weights = ctx.session.sequence.style.layout_weights;
  const out: Slot[] = [];
  let t = a;
  let last: LayoutType | null = null;
  while (b - t > EPS) {
    const remaining = b - t;
    const options = LAYOUTS.filter((l) => {
      if ((weights[l] ?? 0) <= 0) return false;
      if (l !== 'FULLSCREEN_VELOCITY' && l === last) return false; // no back-to-back grids
      return l === 'FULLSCREEN_VELOCITY' || remaining >= 2 - EPS;
    });
    const layout = options.length ? ctx.rng.weighted(options, (l) => weights[l]) : 'FULLSCREEN_VELOCITY';
    let dur = Math.min(LAYOUT_DUR[layout], remaining);
    // Keep multi-beat grids on even beats so the downbeat hero cuts stay on the bar.
    if (layout === 'STROBE_MATRIX' && (t - a) % 4 > EPS) dur = Math.min(2, remaining);
    const params = { ...DEFAULT_LAYOUT_PARAMS, ...randomParams(layout, ctx.rng) };
    out.push(makeSlot(t, dur, 'HYBRID_DROP', layout, buildCells(layout, dur, ctx, params), {
      speed_ramp: layout === 'FULLSCREEN_VELOCITY' || layout === 'CENTER_PIP_PUNCH',
    }, params));
    last = layout;
    t += dur;
  }
  return out;
}

const GENERATORS: Record<ZoneType, (a: number, b: number, ctx: Ctx) => Slot[]> = {
  INTRO_STORY: introStory,
  STUTTER_BUILD: stutterBuild,
  VOCAL_BREATHER: vocalBreather,
  HYBRID_DROP: hybridDrop,
};

/** Impact FX are positional: bounce in drops, RGB split on downbeats, glitch on bar lines. */
function applyFx(slot: Slot, dropBeat: number): Slot {
  const onBeat = Math.abs(slot.start_beat - Math.round(slot.start_beat)) < EPS;
  const onBar = onBeat && Math.round(slot.start_beat) % 4 === 0;
  const energetic = slot.zone_type === 'HYBRID_DROP' || slot.zone_type === 'STUTTER_BUILD';
  const fx = { ...slot.fx };
  fx.bounce = slot.zone_type === 'HYBRID_DROP';
  fx.rgb_split = energetic && onBeat;
  fx.glitch = energetic && onBar;
  if (Math.abs(slot.start_beat - dropBeat) < EPS) fx.transition = 'FLASH';
  return { ...slot, fx };
}

function subtract(a: number, b: number, taken: Array<[number, number]>): Array<[number, number]> {
  let gaps: Array<[number, number]> = [[a, b]];
  for (const [x, y] of taken) {
    gaps = gaps.flatMap(([g0, g1]): Array<[number, number]> => {
      if (y <= g0 + EPS || x >= g1 - EPS) return [[g0, g1]];
      return [[g0, x], [y, g1]].filter(([p, q]) => q - p > EPS) as Array<[number, number]>;
    });
  }
  return gaps;
}

export function solve(session: Session, seed = session.sequence.seed): Slot[] {
  const seq = session.sequence;
  const rng = new Rng(seed);
  const usable = session.clips.filter((c) => c.proxy_status !== 'error');
  const ctx: Ctx = { session, rng, pool: new ClipPool(usable, rng) };
  const locked = seq.slots.filter((s) => s.locked);
  const taken = locked.map((s): [number, number] => [s.start_beat, s.start_beat + s.duration_beats]);
  const zones = [...seq.zones].sort((x, y) => x.start_beat - y.start_beat);
  const out: Slot[] = [...locked];
  for (const zone of zones) {
    for (const [a, b] of subtract(zone.start_beat, zone.end_beat, taken)) {
      out.push(...GENERATORS[zone.type](a, b, ctx).map((s) => applyFx(s, seq.drop_beat_index)));
    }
  }
  return out.sort((x, y) => x.start_beat - y.start_beat);
}

/** `T` on a card: FULLSCREEN -> STACK_3_ROW -> CENTER_PIP -> MATRIX, keeping the slot's main clip. */
export function cycleLayout(session: Session, slot: Slot): Slot {
  const next = LAYOUTS[(LAYOUTS.indexOf(slot.layout) + 1) % LAYOUTS.length];
  const rng = new Rng(session.sequence.seed * 7919 + Math.round(slot.start_beat * 1000));
  const usable = session.clips.filter((c) => c.proxy_status !== 'error');
  const ctx: Ctx = { session, rng, pool: new ClipPool(usable, rng) };
  const primary = session.clips.find((c) => c.clip_id === slot.cells[0]?.clip_id) ?? null;
  const params = { ...slot.layout_params, ...randomParams(next, rng) };
  return {
    ...slot,
    layout: next,
    layout_params: params,
    cells: buildCells(next, slot.duration_beats, ctx, params, primary),
    fx: { ...slot.fx, speed_ramp: next === 'FULLSCREEN_VELOCITY' || next === 'CENTER_PIP_PUNCH' },
  };
}

/** Classic promo arc around the drop: story intro, stutter build, breather, 8-bar drop. */
export function defaultZones(dropBeat: number): Zone[] {
  const d = Math.max(0, Math.round(dropBeat));
  const breather = Math.max(0, d - 4);
  const build = Math.max(0, breather - 4);
  const zones: Zone[] = [];
  if (build > 0) zones.push({ start_beat: 0, end_beat: build, type: 'INTRO_STORY' });
  if (breather > build) zones.push({ start_beat: build, end_beat: breather, type: 'STUTTER_BUILD' });
  if (d > breather) zones.push({ start_beat: breather, end_beat: d, type: 'VOCAL_BREATHER' });
  zones.push({ start_beat: d, end_beat: d + 32, type: 'HYBRID_DROP' });
  return zones;
}
