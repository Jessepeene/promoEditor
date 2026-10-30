// The "slot machine": turns zones + the clip pool into Beat Cards (slots).
// Deterministic for a given seed (Reroll bumps the seed); locked slots are kept and
// the gaps around them are re-rolled.

import type { Cell, Clip, LayoutParams, LayoutType, Sequence, Session, Slot, SlotFx, Zone, ZoneType } from '../types/session';
import { DEFAULT_FX, DEFAULT_LAYOUT_PARAMS, LAYOUTS } from '../types/session';
import { Rng } from './rng';
import { beatDuration, matrixDims } from './timing';

const EPS = 1e-6;

/**
 * Energy tiers each role wants, best first. 0 = breather (RANGE), 1 vibe … 4 peak.
 * When these run out, the pool steps to adjacent tiers (see ClipPool.pick).
 */
const ROLE_TIERS = {
  story: [1, 2],
  stutter: [3, 2],
  breather: [0],
  hero: [4, 3],
  stack: [2, 3],
  pipFront: [3, 2],
  matrix: [1, 2],
  outro: [1, 0],
} as const;
type Role = keyof typeof ROLE_TIERS;

const hasColor = (c: Clip) => c.color_tag != null && c.color_tag !== 'unknown';

/**
 * Draws clips one slot at a time and enforces the anti-clustering rules:
 *   - source cooldown: a source file can't reappear within `cooldown` slots
 *   - colour dispersion: a slot's main clip can't share the previous slot's dominant colour
 * When the wanted tiers are exhausted under those rules it uses adjacent tiers (and
 * reports it, so the slot gets a micro-zoom), then relaxes colour, then cooldown.
 */
class ClipPool {
  private uses = new Map<string, number>();
  private history: Set<string>[] = []; // sources per finished slot, newest last
  private lastSlotOfSource = new Map<string, number>();
  private slotCount = 0;
  private prevColor: string | null = null;
  private slotSources = new Set<string>();
  private slotPicks = 0;
  /** Sources / colours of following slots that a rebuilt slot must also avoid. */
  readonly blockedSources = new Set<string>();
  readonly blockedColors = new Set<string>();
  slotFellBack = false;

  constructor(private clips: Clip[], private rng: Rng, private cooldown: number) {}

  get size() {
    return this.clips.length;
  }

  beginSlot() {
    this.slotSources = new Set();
    this.slotPicks = 0;
    this.slotFellBack = false;
  }

  /** Record a finished (or locked / neighbouring) slot in the cooldown history. */
  endSlot(slot: Slot, clipsById: Map<string, Clip>) {
    const sources = new Set<string>();
    for (const c of slot.cells) {
      const clip = clipsById.get(c.clip_id);
      if (!clip) continue;
      sources.add(clip.source_path);
      this.lastSlotOfSource.set(clip.source_path, this.slotCount);
    }
    this.history = [...this.history, sources].slice(-Math.max(this.cooldown, 1));
    const main = clipsById.get(slot.cells[0]?.clip_id ?? '');
    this.prevColor = main && hasColor(main) ? (main.color_tag ?? null) : null;
    this.slotCount++;
  }

  private cooled(c: Clip): boolean {
    if (this.slotSources.has(c.source_path) || this.blockedSources.has(c.source_path)) return false;
    return this.cooldown === 0 || !this.history.some((h) => h.has(c.source_path));
  }

  private colorOk(c: Clip, main: boolean): boolean {
    if (!main || !hasColor(c)) return true;
    return c.color_tag !== this.prevColor && !this.blockedColors.has(c.color_tag ?? '');
  }

  pick(role: Role, exclude: Set<string> = new Set()): Clip | null {
    const main = this.slotPicks === 0;
    const tiers: readonly number[] = ROLE_TIERS[role];
    const adjacent = [0, 1, 2, 3, 4].filter((t) => !tiers.includes(t) && tiers.some((w) => Math.abs(w - t) === 1));
    const inTiers = (ts: readonly number[]) => (c: Clip) => ts.includes(c.energy_tag);
    const pool = this.clips.filter((c) => !exclude.has(c.clip_id));
    const stages: { test: (c: Clip) => boolean; fallback: boolean }[] = [
      { test: (c) => inTiers(tiers)(c) && this.cooled(c) && this.colorOk(c, main), fallback: false },
      { test: (c) => inTiers(adjacent)(c) && this.cooled(c) && this.colorOk(c, main), fallback: true },
      // Keep both variety rules as long as any tier can: an off-tier clip (with the
      // micro-zoom) beats a repeated source or colour.
      { test: (c) => this.cooled(c) && this.colorOk(c, main), fallback: true },
      { test: (c) => inTiers(tiers)(c) && this.cooled(c), fallback: false },
      { test: (c) => inTiers(adjacent)(c) && this.cooled(c), fallback: true },
      { test: (c) => this.cooled(c), fallback: true },
      // The pool is too small for the cooldown: stay in tier, favour sources unused longest.
      { test: (c) => inTiers(tiers)(c) && !this.slotSources.has(c.source_path), fallback: false },
      { test: () => true, fallback: true },
    ];
    for (const stage of stages) {
      const candidates = pool.filter(stage.test);
      if (candidates.length === 0) continue;
      const clip = this.rng.weighted(candidates, (c) => {
        const rank = tiers.indexOf(c.energy_tag);
        const tierW = rank < 0 ? 0.5 : rank === 0 ? 1 : 0.6;
        const freshness = 1 / (1 + (this.uses.get(c.clip_id) ?? 0));
        const since = this.slotCount - (this.lastSlotOfSource.get(c.source_path) ?? -100);
        return tierW * freshness * Math.min(since, 20);
      });
      this.uses.set(clip.clip_id, (this.uses.get(clip.clip_id) ?? 0) + 1);
      this.slotSources.add(clip.source_path);
      this.slotPicks++;
      if (stage.fallback && main) this.slotFellBack = true;
      return clip;
    }
    return null;
  }
}

interface Ctx {
  session: Session;
  rng: Rng;
  pool: ClipPool;
  clipsById: Map<string, Clip>;
  /** Slots whose main clip came from outside the wanted tiers: they get a micro-zoom. */
  fellBack: Set<string>;
}

function makeCtx(session: Session, rng: Rng): Ctx {
  const usable = session.clips.filter((c) => c.proxy_status !== 'error');
  return {
    session,
    rng,
    pool: new ClipPool(usable, rng, session.sequence.style.source_cooldown),
    clipsById: new Map(session.clips.map((c) => [c.clip_id, c])),
    fellBack: new Set(),
  };
}

/** Build one slot inside the pool's per-slot bookkeeping. */
function roll(ctx: Ctx, build: () => Slot): Slot {
  ctx.pool.beginSlot();
  const slot = build();
  if (ctx.pool.slotFellBack) ctx.fellBack.add(slot.slot_id);
  ctx.pool.endSlot(slot, ctx.clipsById);
  return slot;
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

function buildCells(layout: LayoutType, dur: number, ctx: Ctx, params: LayoutParams, primary?: Clip | null): Cell[] {
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
    case 'SPLIT_2': {
      // One half holds; the other swaps every beat on longer cards.
      const keep = primary ?? pool.pick('stack');
      const used = new Set(keep ? [keep.clip_id] : []);
      const cells = cell('half0', keep, 0, null, 'MIDPOINT');
      const step = dur >= 2 - EPS ? 1 : dur;
      for (let b = 0; b < dur - EPS; b += step) {
        cells.push(...cell('half1', pool.pick('stack', used), b, Math.min(b + step, dur), 'MIDPOINT'));
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
  if (layout === 'SPLIT_2') return { split: rng.chance(0.5) ? 'ROWS' : 'COLS' };
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
    const transition = out.length && ctx.rng.chance(0.4) ? 'CROSSFADE' : 'CUT';
    out.push(roll(ctx, () => makeSlot(t, len, 'INTRO_STORY', 'FULLSCREEN_VELOCITY',
      cell('full', ctx.pool.pick('story'), 0, null, 'MIDPOINT'), { speed_ramp: false, transition })));
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
    out.push(roll(ctx, () => makeSlot(t, dur, 'STUTTER_BUILD', stack ? 'STACK_3_ROW' : 'FULLSCREEN_VELOCITY',
      stack ? buildCells('STACK_3_ROW', dur, ctx, DEFAULT_LAYOUT_PARAMS) : cell('full', ctx.pool.pick('stutter')),
      { transition: step === 0.25 && i % 2 ? 'FLASH' : 'CUT' })));
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
    out.push(roll(ctx, () => makeSlot(a + i * len, len, 'VOCAL_BREATHER', 'FULLSCREEN_VELOCITY',
      cell('full', ctx.pool.pick('breather'), 0, null, 'MIDPOINT'), { speed_ramp: false, speed: 0.75 })));
  }
  return out;
}

function outro(a: number, b: number, ctx: Ctx): Slot[] {
  // End card: a calm clip slowly pulling out, dimmed so the CTA / dates read clearly.
  const out: Slot[] = [];
  const pieces = Math.max(1, Math.ceil((b - a) / 8 - EPS));
  const len = (b - a) / pieces;
  for (let i = 0; i < pieces; i++) {
    out.push(roll(ctx, () => makeSlot(a + i * len, len, 'OUTRO', 'FULLSCREEN_VELOCITY',
      cell('full', ctx.pool.pick('outro'), 0, null, 'MIDPOINT'),
      { speed_ramp: false, speed: 0.85, dim: true, push: 'OUT', transition: i === 0 ? 'CROSSFADE' : 'CUT' })));
  }
  return out;
}

const LAYOUT_DUR: Record<LayoutType, number> = {
  FULLSCREEN_VELOCITY: 1,
  STACK_3_ROW: 2,
  CENTER_PIP_PUNCH: 2,
  STROBE_MATRIX: 4,
  SPLIT_2: 2,
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
    out.push(roll(ctx, () => makeSlot(t, dur, 'HYBRID_DROP', layout, buildCells(layout, dur, ctx, params), {
      speed_ramp: layout === 'FULLSCREEN_VELOCITY' || layout === 'CENTER_PIP_PUNCH',
    }, params)));
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
  OUTRO: outro,
};

/**
 * Impact FX are positional: bounce in drops, RGB split on downbeats, glitch on bar lines.
 * A slot whose main clip came from outside its wanted energy tiers also gets the bounce
 * (micro-zoom) so the substitution still reads as deliberate motion.
 *
 * The optional looks (push, shake, invert, strobe, mirror, echo) are drawn with the seeded
 * rng at rates scaled by `intensity` (0 = none, 1 = default, 2 = wild); the flashy ones
 * never land on two cards in a row.
 */
function applyFx(slot: Slot, prev: Slot | null, dropBeat: number, fellBack: boolean, rng: Rng, intensity: number): Slot {
  const onBeat = Math.abs(slot.start_beat - Math.round(slot.start_beat)) < EPS;
  const onBar = onBeat && Math.round(slot.start_beat) % 4 === 0;
  const zone = slot.zone_type;
  const drop = zone === 'HYBRID_DROP';
  const energetic = drop || zone === 'STUTTER_BUILD';
  const isDropHit = Math.abs(slot.start_beat - dropBeat) < EPS;
  const full = slot.layout === 'FULLSCREEN_VELOCITY';
  const k = Math.max(0, intensity);
  const maybe = (p: number) => k > 0 && rng.chance(Math.min(1, p * k));
  const fx = { ...slot.fx };
  fx.bounce = drop || fellBack;
  fx.rgb_split = energetic && onBeat;
  fx.glitch = energetic && onBar;
  if (isDropHit) fx.transition = 'FLASH';

  if (zone === 'INTRO_STORY' || zone === 'VOCAL_BREATHER') fx.push = k > 0 ? (rng.chance(0.5) ? 'IN' : 'OUT') : 'NONE';
  else if (drop && full && slot.duration_beats >= 2 - EPS && maybe(0.3)) fx.push = 'IN';
  fx.shake = drop && full && ((isDropHit && k > 0) || (onBar && maybe(0.7)));
  fx.invert = drop && onBeat && !isDropHit && !prev?.fx.invert && maybe(0.12);
  const lastBeforeDrop = zone === 'STUTTER_BUILD' && Math.abs(slot.start_beat + slot.duration_beats - dropBeat) < EPS;
  fx.strobe = zone === 'STUTTER_BUILD' && ((lastBeforeDrop && k > 0) || (slot.duration_beats <= 0.25 + EPS && maybe(0.5)));
  fx.mirror = drop && full && !prev?.fx.mirror && maybe(0.1);
  fx.echo = (zone === 'VOCAL_BREATHER' && maybe(0.6)) || (drop && slot.layout === 'STROBE_MATRIX' && maybe(0.2));
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
  const ctx = makeCtx(session, new Rng(seed));
  const locked = seq.slots.filter((s) => s.locked);
  const taken = locked.map((s): [number, number] => [s.start_beat, s.start_beat + s.duration_beats]);
  // Walk the timeline in order so cooldown and colour rules also hold across locked cards.
  type Item = { start: number; locked: Slot } | { start: number; gap: [number, number]; type: ZoneType };
  const items: Item[] = locked.map((s) => ({ start: s.start_beat, locked: s }));
  for (const zone of seq.zones) {
    for (const gap of subtract(zone.start_beat, zone.end_beat, taken)) items.push({ start: gap[0], gap, type: zone.type });
  }
  items.sort((x, y) => x.start - y.start);
  const out: Slot[] = [];
  for (const item of items) {
    if ('locked' in item) {
      ctx.pool.beginSlot();
      ctx.pool.endSlot(item.locked, ctx.clipsById);
      out.push(item.locked);
    } else {
      const [a, b] = item.gap;
      for (const slot of GENERATORS[item.type](a, b, ctx)) {
        const prev = out.at(-1) ?? null;
        out.push(applyFx(slot, prev, seq.drop_beat_index, ctx.fellBack.has(slot.slot_id), ctx.rng, seq.style.fx_intensity));
      }
    }
  }
  return out.sort((x, y) => x.start_beat - y.start_beat);
}

/** `T` on a card: FULLSCREEN -> STACK_3_ROW -> CENTER_PIP -> MATRIX, keeping the slot's main clip. */
export function cycleLayout(session: Session, slot: Slot): Slot {
  return withLayout(session, slot, LAYOUTS[(LAYOUTS.indexOf(slot.layout) + 1) % LAYOUTS.length]);
}

/** Rebuild a slot's cells for `next` (or for new layout params when `next` is unchanged). */
export function withLayout(session: Session, slot: Slot, next: LayoutType, params?: Partial<LayoutParams>): Slot {
  const rng = new Rng(session.sequence.seed * 7919 + Math.round(slot.start_beat * 1000));
  const ctx = makeCtx(session, rng);
  // Rebuilt cells respect the neighbours: earlier slots feed the cooldown history,
  // later ones block their sources and the next card's main colour.
  const sorted = [...session.sequence.slots].sort((a, b) => a.start_beat - b.start_beat);
  const at = sorted.findIndex((s) => s.slot_id === slot.slot_id);
  const n = Math.max(session.sequence.style.source_cooldown, 1);
  for (const prev of sorted.slice(Math.max(0, at - n), Math.max(at, 0))) {
    ctx.pool.beginSlot();
    ctx.pool.endSlot(prev, ctx.clipsById);
  }
  if (at >= 0) {
    for (const following of sorted.slice(at + 1, at + 1 + n)) {
      for (const c of following.cells) {
        const clip = ctx.clipsById.get(c.clip_id);
        if (clip) ctx.pool.blockedSources.add(clip.source_path);
      }
    }
    const nextMain = ctx.clipsById.get(sorted[at + 1]?.cells[0]?.clip_id ?? '');
    if (nextMain?.color_tag && nextMain.color_tag !== 'unknown') ctx.pool.blockedColors.add(nextMain.color_tag);
  }
  ctx.pool.beginSlot();
  const primary = ctx.clipsById.get(slot.cells[0]?.clip_id ?? '') ?? null;
  const layoutParams = { ...slot.layout_params, ...(params ?? randomParams(next, rng)) };
  return {
    ...slot,
    layout: next,
    layout_params: layoutParams,
    cells: buildCells(next, slot.duration_beats, ctx, layoutParams, primary),
    fx: { ...slot.fx, speed_ramp: next === 'FULLSCREEN_VELOCITY' || next === 'CENTER_PIP_PUNCH' },
  };
}

export interface ZoneRecipe {
  id: string;
  label: string;
  hint: string;
  /** Zones plus the beat the drop sits on; the caller shifts the song so its drop kick stays on it. */
  build: (currentDrop: number) => { zones: Zone[]; drop: number };
}

/**
 * Promo structures to start from. Common advice for short promos: hook within the first
 * ~3 s, keep the info on screen, end on a call to action, so every recipe ends on an OUTRO.
 */
export const ZONE_RECIPES: ZoneRecipe[] = [
  {
    id: 'CLASSIC',
    label: 'Classic build',
    hint: 'Story intro, stutter build, breather, 6-bar drop, end card',
    build: (d) => {
      const zones = defaultZones(d).map((z) => (z.type === 'HYBRID_DROP' ? { ...z, end_beat: z.start_beat + 24 } : z));
      return { zones: [...zones, { start_beat: d + 24, end_beat: d + 32, type: 'OUTRO' }], drop: d };
    },
  },
  {
    id: 'HOOK_FIRST',
    label: 'Hook first (~15 s teaser)',
    hint: 'Machine-gun build straight into the drop, then the end card: energy from the first second',
    build: () => ({
      drop: 4,
      zones: [
        { start_beat: 0, end_beat: 4, type: 'STUTTER_BUILD' },
        { start_beat: 4, end_beat: 28, type: 'HYBRID_DROP' },
        { start_beat: 28, end_beat: 36, type: 'OUTRO' },
      ],
    }),
  },
  {
    id: 'STORY',
    label: 'Story then drop',
    hint: 'Long atmospheric intro with the event title, breather, drop, end card',
    build: () => ({
      drop: 24,
      zones: [
        { start_beat: 0, end_beat: 16, type: 'INTRO_STORY' },
        { start_beat: 16, end_beat: 24, type: 'VOCAL_BREATHER' },
        { start_beat: 24, end_beat: 48, type: 'HYBRID_DROP' },
        { start_beat: 48, end_beat: 56, type: 'OUTRO' },
      ],
    }),
  },
  {
    id: 'DOUBLE_DROP',
    label: 'Double drop',
    hint: 'Build, drop, short breather, second drop, end card',
    build: () => ({
      drop: 8,
      zones: [
        { start_beat: 0, end_beat: 4, type: 'STUTTER_BUILD' },
        { start_beat: 4, end_beat: 8, type: 'VOCAL_BREATHER' },
        { start_beat: 8, end_beat: 24, type: 'HYBRID_DROP' },
        { start_beat: 24, end_beat: 28, type: 'VOCAL_BREATHER' },
        { start_beat: 28, end_beat: 44, type: 'HYBRID_DROP' },
        { start_beat: 44, end_beat: 52, type: 'OUTRO' },
      ],
    }),
  },
];

/**
 * Apply a recipe: new zones and drop beat, with beat 0 moved through the song so the
 * same drop kick still lands on the (possibly different) drop beat.
 */
export function applyRecipe(seq: Sequence, recipe: ZoneRecipe): Pick<Sequence, 'zones' | 'drop_beat_index' | 'beat_1_offset_sec'> {
  const { zones, drop } = recipe.build(seq.drop_beat_index);
  const shift = (seq.drop_beat_index - drop) * beatDuration(seq.bpm);
  return { zones, drop_beat_index: drop, beat_1_offset_sec: Math.round((seq.beat_1_offset_sec + shift) * 1000) / 1000 };
}

/** Drop layout-mix presets after the reference edits (car velocity, rave collage, hybrid dancer). */
export const LAYOUT_PRESETS: { id: string; label: string; weights: Record<LayoutType, number> }[] = [
  { id: 'VELOCITY', label: 'Velocity', weights: { FULLSCREEN_VELOCITY: 1, STACK_3_ROW: 0, CENTER_PIP_PUNCH: 0, STROBE_MATRIX: 0, SPLIT_2: 0 } },
  { id: 'COLLAGE', label: 'Collage', weights: { FULLSCREEN_VELOCITY: 0.15, STACK_3_ROW: 0.3, CENTER_PIP_PUNCH: 0.2, STROBE_MATRIX: 0.2, SPLIT_2: 0.15 } },
  { id: 'HYBRID', label: 'Hybrid', weights: { FULLSCREEN_VELOCITY: 0.4, STACK_3_ROW: 0.2, CENTER_PIP_PUNCH: 0.15, STROBE_MATRIX: 0.1, SPLIT_2: 0.15 } },
];

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
