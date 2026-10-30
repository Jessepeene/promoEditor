// Graphics layer: promo text and logos, drawn by one renderer for both the live
// preview and the export (the export uploads the rendered frames; see renderGraphicsTrack).
//
// Placement follows the zones:
//   intro_title – centred over the first INTRO_STORY zone (or the opening bars)
//   hook_words  – one word per beat across VOCAL_BREATHER zones, then a big punch on the drop
//   info_rows   – second half of the last HYBRID_DROP zone, one row per beat
//   end card    – OUTRO zone: the rows again plus the call to action (or the CTA alone at the end)
//   logos       – each in its own window (always / intro / drop / outro)
//
// `graphicsFrameKey` returns the same string for frames that render identically, so the
// export only has to rasterize (and upload) frames where something actually changes.

import type { InfoRow, Logo, Session, TextAnim, TextConfig, TextStyle, Zone } from '../types/session';
import { mediaUrl } from './api';
import { beatDuration, beatToFrame, promoEndBeat, promoFrameCount } from './timing';

const POP_FRAMES = 6;
const DROP_FRAMES = 10;
const DROP_PUNCH = 0.3;
/** Frames (from the drop) on which the drop hook flickers off, for a strobe feel. */
const DROP_FLICKER = new Set([2, 4]);
const LOGO_FADE_FRAMES = 10;
const LOGO_PULSE_FRAMES = 12;
const LOGO_JITTER_STEP = 3; // jitter moves every 3rd frame: lively, and far fewer unique frames to export
/** Without an OUTRO zone, the call to action takes the last beats of the promo. */
const CTA_FALLBACK_BEATS = 4;

export const TITLE_ANIMS: TextAnim[] = ['POP', 'TYPEWRITER', 'WORDS', 'SLIDE', 'SLAM', 'GLITCH'];
export const HOOK_ANIMS: TextAnim[] = ['SLAM', 'FLICKER', 'ZOOM', 'LETTERS'];
export const ROWS_ANIMS: TextAnim[] = ['POP', 'TYPEWRITER', 'SLIDE'];

export type GraphicsEvent =
  | { kind: 'title'; start: number; end: number; text: string; anim: TextAnim }
  | { kind: 'hook'; start: number; end: number; text: string; drop: boolean; anim: TextAnim }
  | { kind: 'rows'; start: number; end: number; rowStarts: number[]; rows: InfoRow[]; anim: TextAnim }
  | { kind: 'endcard'; start: number; end: number; rows: InfoRow[]; cta: string }
  | { kind: 'logo'; start: number; end: number; index: number; logo: Logo; framesPerBeat: number; bpm: number; fps: number };

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A chosen animation, or (AUTO) a seeded pick that changes on every reroll. */
function resolveAnim(choice: TextAnim, options: TextAnim[], seed: number, salt: string): TextAnim {
  if (choice !== 'AUTO' && options.includes(choice)) return choice;
  return options[hashString(`${seed}:${salt}`) % options.length];
}

function logoWindows(when: Logo['when'], zones: Zone[], total: number, endBeat: number, frame: (b: number) => number): [number, number][] {
  const span = (z: Zone): [number, number] => [frame(z.start_beat), frame(z.end_beat)];
  switch (when) {
    case 'ALWAYS':
      return [[0, total]];
    case 'INTRO': {
      const intro = zones.find((z) => z.type === 'INTRO_STORY') ?? zones[0];
      return intro ? [span(intro)] : [];
    }
    case 'DROP':
      return zones.filter((z) => z.type === 'HYBRID_DROP').map(span);
    case 'OUTRO': {
      const outros = zones.filter((z) => z.type === 'OUTRO').map(span);
      return outros.length ? outros : [[frame(Math.max(0, endBeat - CTA_FALLBACK_BEATS)), total]];
    }
  }
}

export function graphicsSchedule(session: Session): GraphicsEvent[] {
  const { bpm, zones, seed, text_config: cfg, style } = session.sequence;
  const fps = session.fps;
  const frame = (beat: number) => beatToFrame(beat, bpm, fps);
  const sorted = [...zones].sort((a, b) => a.start_beat - b.start_beat);
  const total = promoFrameCount(session);
  const endBeat = promoEndBeat(session);
  const events: GraphicsEvent[] = [];

  style.logos.forEach((logo, index) => {
    for (const [start, end] of logoWindows(logo.when, sorted, total, endBeat, frame)) {
      if (end > start) events.push({ kind: 'logo', start, end, index, logo, framesPerBeat: beatDuration(bpm) * fps, bpm, fps });
    }
  });

  const title = cfg.intro_title.trim();
  const intro = sorted.find((z) => z.type === 'INTRO_STORY');
  const words = cfg.hook_words.map((w) => w.trim()).filter(Boolean);
  // Where hook words take over the centre of the frame: breather beats, then the drop punch.
  const firstHookBeat = words.length
    ? Math.min(...sorted.filter((z) => z.type === 'VOCAL_BREATHER' || z.type === 'HYBRID_DROP').map((z) => Math.ceil(z.start_beat)), Infinity)
    : Infinity;
  if (title && sorted.length) {
    // The intro zone, or else (e.g. a hook-first recipe) the first zone, at most 2 bars and
    // never into the first hook word.
    const start = intro ? intro.start_beat : sorted[0].start_beat;
    const end = intro ? intro.end_beat : Math.min(sorted[0].end_beat, start + 8, firstHookBeat);
    if (end - start >= 1) {
      events.push({ kind: 'title', start: frame(start), end: frame(end), text: title,
        anim: resolveAnim(cfg.title_anim, TITLE_ANIMS, seed, 'title') });
    }
  }

  if (words.length) {
    let k = 0;
    for (const z of sorted.filter((x) => x.type === 'VOCAL_BREATHER')) {
      for (let b = Math.ceil(z.start_beat); b < z.end_beat; b++) {
        events.push({ kind: 'hook', start: frame(b), end: frame(Math.min(b + 1, z.end_beat)), text: words[k % words.length],
          drop: false, anim: resolveAnim(cfg.hook_anim, HOOK_ANIMS, seed, `hook${k}`) });
        k++;
      }
    }
    const drop = sorted.find((z) => z.type === 'HYBRID_DROP');
    if (drop) {
      const end = Math.min(drop.start_beat + 1, drop.end_beat);
      events.push({ kind: 'hook', start: frame(drop.start_beat), end: frame(end), text: words[k % words.length], drop: true, anim: 'SLAM' });
    }
  }

  const rows = cfg.info_rows.filter((r) => r.left.trim() || r.right.trim());
  const lastDrop = sorted.filter((z) => z.type === 'HYBRID_DROP').at(-1);
  if (rows.length && lastDrop) {
    const len = lastDrop.end_beat - lastDrop.start_beat;
    // Start on the bar nearest the middle, early enough for every row to get its beat.
    const mid = lastDrop.start_beat + (len >= 8 ? Math.floor(len / 2 / 4) * 4 : Math.floor(len / 2));
    const start = Math.max(lastDrop.start_beat, Math.min(mid, lastDrop.end_beat - rows.length));
    const step = Math.min(1, (lastDrop.end_beat - start) / rows.length);
    events.push({
      kind: 'rows',
      start: frame(start),
      end: frame(lastDrop.end_beat),
      rowStarts: rows.map((_, i) => frame(start + i * step)),
      rows,
      anim: resolveAnim(cfg.rows_anim, ROWS_ANIMS, seed, 'rows'),
    });
  }

  const cta = cfg.cta.trim();
  const outro = sorted.filter((z) => z.type === 'OUTRO').at(-1);
  if (outro && (rows.length || cta)) {
    events.push({ kind: 'endcard', start: frame(outro.start_beat), end: frame(outro.end_beat), rows, cta });
  } else if (!outro && cta && total > 0) {
    events.push({ kind: 'endcard', start: frame(Math.max(0, endBeat - CTA_FALLBACK_BEATS)), end: total, rows: [], cta });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Animation timing (shared by the frame key and the painter)
// ---------------------------------------------------------------------------

/** Frames until an animation is done; the key stops changing after this. */
function animLength(anim: TextAnim, text: string): number {
  switch (anim) {
    case 'TYPEWRITER':
      return text.length * 2;
    case 'WORDS':
      return text.split(/\s+/).filter(Boolean).length * 5;
    case 'LETTERS':
      return text.length + 4;
    case 'SLIDE':
    case 'SLAM':
      return 8;
    case 'GLITCH':
      return 12;
    default:
      return POP_FRAMES;
  }
}

/** Frame offset since the most recent beat (for logo pulses). */
function framesSinceBeat(f: number, bpm: number, fps: number, framesPerBeat: number): number {
  let b = Math.floor(f / framesPerBeat);
  while (b > 0 && beatToFrame(b, bpm, fps) > f) b--;
  while (beatToFrame(b + 1, bpm, fps) <= f) b++;
  return f - beatToFrame(b, bpm, fps);
}

function rowsAnimLength(anim: TextAnim, row: InfoRow): number {
  return anim === 'TYPEWRITER' ? row.left.length + row.right.length + 2 : anim === 'SLIDE' ? 8 : POP_FRAMES;
}

/** "BERLIN + 09/10" → { left: "BERLIN", right: "09/10" }. The first "+", "|" or tab splits; no separator = left only. */
export function parseInfoRows(text: string): InfoRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.*?\S)\s*[+|\t]\s*(\S.*)$/.exec(line);
      return m ? { left: m[1], right: m[2] } : { left: line, right: '' };
    });
}

/** Identical keys ⇒ identical pixels. Empty string = nothing visible. */
export function graphicsFrameKey(events: GraphicsEvent[], f: number): string {
  const parts: string[] = [];
  for (const e of events) {
    if (f < e.start || f >= e.end) continue;
    const t = f - e.start;
    switch (e.kind) {
      case 'logo': {
        const m = e.logo.motion;
        const state =
          m === 'PULSE' ? Math.min(framesSinceBeat(f, e.bpm, e.fps, e.framesPerBeat), LOGO_PULSE_FRAMES)
          : m === 'JITTER' ? Math.floor(f / LOGO_JITTER_STEP)
          : m === 'FADE' ? `${Math.min(t, LOGO_FADE_FRAMES)}/${Math.min(e.end - 1 - f, LOGO_FADE_FRAMES)}`
          : '';
        parts.push(`logo${e.index}@${e.start}:${state}`);
        break;
      }
      case 'rows': {
        // Every row's own state: rows can be revealed faster than they finish animating.
        const states = e.rowStarts.map((s, i) => (f < s ? '-' : Math.min(f - s, rowsAnimLength(e.anim, e.rows[i]))));
        parts.push(`rows@${e.start}:${states.join(',')}`);
        break;
      }
      case 'hook':
        if (e.drop) {
          if (DROP_FLICKER.has(t)) continue;
          parts.push(`drop@${e.start}:${Math.min(t, DROP_FRAMES)}`);
        } else {
          parts.push(`hook@${e.start}:${Math.min(t, animLength(e.anim, e.text))}`);
        }
        break;
      case 'title':
        parts.push(`title@${e.start}:${Math.min(t, animLength(e.anim, e.text))}`);
        break;
      case 'endcard':
        parts.push(`end@${e.start}:${Math.min(t, POP_FRAMES)}`);
        break;
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

export const FONT_FACES = ['800 64px Inter', '700 64px "Space Mono"', '400 64px Michroma'];

/** Resolve once the bundled fonts are usable, so canvas text never falls back. */
export function ensureFonts(): Promise<void> {
  return Promise.all(FONT_FACES.map((f) => document.fonts.load(f))).then(() => undefined);
}

/** Load each logo image once (decoded), keyed by its manifest path. */
export async function loadLogoImages(logos: Logo[], cache = new Map<string, HTMLImageElement>()): Promise<Map<string, HTMLImageElement>> {
  await Promise.all(
    logos
      .filter((l) => !cache.has(l.path))
      .map(async (l) => {
        const img = new Image();
        img.src = mediaUrl(l.path);
        await img.decode();
        cache.set(l.path, img);
      }),
  );
  return cache;
}

const easeOut = (x: number) => 1 - (1 - Math.min(Math.max(x, 0), 1)) ** 3;

interface Paint {
  font: (size: number) => string;
  spacing: number; // letter spacing as a fraction of font size
  upper: boolean;
}

const STYLES: Record<TextStyle, Paint> = {
  CLEAN_BOLD: { font: (s) => `800 ${s}px Inter`, spacing: 0, upper: false },
  RAVE_MONO: { font: (s) => `700 ${s}px "Space Mono"`, spacing: 0.3, upper: true },
  CHROME_Y2K: { font: (s) => `400 ${s}px Michroma`, spacing: 0.04, upper: true },
  OUTLINE_STACK: { font: (s) => `800 ${s}px Inter`, spacing: 0.02, upper: true },
  TAPE_LABEL: { font: (s) => `800 ${s}px Inter`, spacing: 0.01, upper: true },
  NEON: { font: (s) => `800 ${s}px Inter`, spacing: 0.06, upper: true },
  GRADIENT_POP: { font: (s) => `800 ${s}px Inter`, spacing: 0, upper: true },
  MINIMAL: { font: (s) => `800 ${s}px Inter`, spacing: 0.35, upper: true },
};

export const TEXT_STYLE_IDS = Object.keys(STYLES) as TextStyle[];

const START_SIZE: Record<'title' | 'rows' | 'cta', Record<TextStyle, number>> = {
  title: { CLEAN_BOLD: 110, RAVE_MONO: 64, CHROME_Y2K: 78, OUTLINE_STACK: 120, TAPE_LABEL: 96, NEON: 100, GRADIENT_POP: 120, MINIMAL: 56 },
  rows: { CLEAN_BOLD: 64, RAVE_MONO: 46, CHROME_Y2K: 52, OUTLINE_STACK: 64, TAPE_LABEL: 56, NEON: 58, GRADIENT_POP: 62, MINIMAL: 40 },
  cta: { CLEAN_BOLD: 72, RAVE_MONO: 48, CHROME_Y2K: 56, OUTLINE_STACK: 76, TAPE_LABEL: 64, NEON: 66, GRADIENT_POP: 74, MINIMAL: 44 },
};

/** Accent colours AUTO chooses from: saturated, and readable against dark or busy footage. */
export const ACCENTS = ['#facc15', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#a78bfa', '#f43f5e'];

/** The concrete style + accent one roll is drawn with. */
export interface Look {
  style: TextStyle;
  accent: string;
}

/** Resolve AUTO style / accent from the seed: a different look per reroll, stable for a given seed. */
export function textLook(seq: { seed: number; text_config: TextConfig }): Look {
  const cfg = seq.text_config;
  const style = cfg.style_preset === 'AUTO' ? TEXT_STYLE_IDS[hashString(`${seq.seed}:style`) % TEXT_STYLE_IDS.length] : cfg.style_preset;
  const accent = cfg.accent === 'AUTO' ? ACCENTS[hashString(`${seq.seed}:accent`) % ACCENTS.length] : cfg.accent;
  return { style, accent };
}

function setFont(ctx: CanvasRenderingContext2D, style: TextStyle, size: number) {
  const p = STYLES[style];
  ctx.font = p.font(size);
  ctx.letterSpacing = `${p.spacing * size}px`;
}

function fitSize(ctx: CanvasRenderingContext2D, style: TextStyle, lines: string[], maxWidth: number, start: number): number {
  let size = start;
  for (; size > 12; size *= 0.94) {
    setFont(ctx, style, size);
    if (Math.max(...lines.map((l) => ctx.measureText(l).width)) <= maxWidth) break;
  }
  return size;
}

/** Greedy word wrap; a single word wider than `maxWidth` gets a line of its own. */
export function wrapWords(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Largest font size (shrinking from `start`) at which `text` wraps into at most
 * `maxLines` lines that all fit `maxWidth`. Never drops words.
 * `measure(text, size)` returns the rendered width at that size.
 */
export function layoutBlock(
  measure: (text: string, size: number) => number,
  text: string,
  maxWidth: number,
  start: number,
  maxLines: number,
): { size: number; lines: string[] } {
  let size = start;
  for (;;) {
    const lines = wrapWords((t) => measure(t, size), text, maxWidth);
    const fits = lines.length <= maxLines && lines.every((l) => measure(l, size) <= maxWidth);
    if (fits || size <= 12) return { size, lines };
    size *= 0.94;
  }
}

/**
 * Draw one line of text at (x, y) in the given style. `emphasis` adds the style's
 * decorations meant for big words (outline echoes); small rows stay plain for legibility.
 */
function paintLine(ctx: CanvasRenderingContext2D, look: Look, text: string, x: number, y: number, size: number,
  align: CanvasTextAlign, emphasis = false) {
  if (!text) return;
  setFont(ctx, look.style, size);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (look.style === 'CLEAN_BOLD') {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.18;
    ctx.shadowOffsetY = size * 0.05;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  } else if (look.style === 'RAVE_MONO') {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = size * 0.12;
    ctx.fillStyle = '#f4f4f5';
    ctx.fillText(text, x, y);
  } else if (look.style === 'CHROME_Y2K') {
    // Glow pass, then a crisp metallic gradient with a dark edge.
    const grad = ctx.createLinearGradient(0, y - size * 0.6, 0, y + size * 0.6);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, '#c7d0db');
    grad.addColorStop(0.5, '#5d6673');
    grad.addColorStop(0.68, '#eef2f6');
    grad.addColorStop(1, '#8e97a3');
    ctx.shadowColor = 'rgba(170,210,255,0.85)';
    ctx.shadowBlur = size * 0.35;
    ctx.fillStyle = grad;
    ctx.fillText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.strokeStyle = 'rgba(15,18,26,0.9)';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  } else if (look.style === 'OUTLINE_STACK') {
    if (emphasis) {
      // Hollow word with fading copies stacked above and below.
      ctx.lineWidth = Math.max(1, size * 0.04);
      for (const [dy, alpha] of [[-1.05, 0.35], [1.05, 0.35], [-2.1, 0.12], [2.1, 0.12]] as const) {
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.strokeText(text, x, y + dy * size);
      }
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(text, x, y);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.15;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, y);
    }
  } else if (look.style === 'NEON') {
    // Accent-coloured tube with a white-hot core.
    ctx.shadowColor = look.accent;
    ctx.shadowBlur = size * 0.45;
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.strokeStyle = look.accent;
    ctx.strokeText(text, x, y);
    ctx.shadowBlur = size * 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  } else if (look.style === 'GRADIENT_POP') {
    // Heavy black outline under an accent-to-white gradient, with a hard drop shadow.
    const grad = ctx.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.5);
    grad.addColorStop(0, look.accent);
    grad.addColorStop(1, '#ffffff');
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.12);
    ctx.strokeStyle = '#0a0a0a';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowOffsetY = size * 0.08;
    ctx.strokeText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = grad;
    ctx.fillText(text, x, y);
  } else if (look.style === 'MINIMAL') {
    // Small, wide-tracked caps; big words get a thin accent rule underneath.
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = size * 0.2;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
    if (emphasis) {
      const w = ctx.measureText(text).width;
      const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = look.accent;
      ctx.fillRect(left, y + size * 0.75, w, Math.max(1, size * 0.06));
    }
  } else {
    // TAPE_LABEL: black type on an accent strip.
    const w = ctx.measureText(text).width;
    const padX = size * 0.28;
    const padY = size * 0.2;
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = look.accent;
    ctx.fillRect(left - padX, y - size * 0.5 - padY, w + 2 * padX, size + 2 * padY);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillText(text, x, y);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** RAVE_MONO's "+-----  TEXT  -----+" rules either side of a centred block. */
function monoRules(ctx: CanvasRenderingContext2D, cx: number, y: number, textWidth: number, W: number, u: number) {
  const gap = 24 * u;
  const len = Math.min(110 * u, (W - textWidth) / 2 - gap - 30 * u);
  if (len < 20 * u) return;
  ctx.strokeStyle = '#f4f4f5';
  ctx.fillStyle = '#f4f4f5';
  ctx.lineWidth = Math.max(1, 3 * u);
  for (const dir of [-1, 1]) {
    const inner = cx + dir * (textWidth / 2 + gap);
    const outer = inner + dir * len;
    ctx.setLineDash([10 * u, 7 * u]);
    ctx.beginPath();
    ctx.moveTo(inner, y);
    ctx.lineTo(outer, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${28 * u}px "Space Mono"`;
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'center';
    ctx.fillText('+', outer + dir * 10 * u, y);
  }
}

const prep = (look: Look, text: string) => (STYLES[look.style].upper ? text.toUpperCase() : text);

/** Deterministic pseudo-random in [0,1) for glitch offsets. */
const noise = (n: number) => (hashString(`g${n}`) % 1000) / 1000;

/** Title / block of centred lines, with its reveal animation applied. */
function paintTitle(ctx: CanvasRenderingContext2D, look: Look, lines: string[], size: number, cx: number, cy: number,
  t: number, anim: TextAnim, W: number, u: number) {
  const lh = size * 1.25;
  setFont(ctx, look.style, size);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const ys = lines.map((_, i) => cy + (i - (lines.length - 1) / 2) * lh);
  ctx.save();
  if (anim === 'POP' || anim === 'SLIDE' || anim === 'SLAM') {
    const a = easeOut(t / animLength(anim, ''));
    ctx.globalAlpha = anim === 'SLAM' ? 1 : a;
    ctx.translate(cx, cy + (anim === 'SLIDE' ? (1 - a) * 60 * u : 0));
    const s = anim === 'SLAM' ? 1 + 0.6 * (1 - a) : anim === 'POP' ? 0.92 + 0.08 * a : 1;
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    lines.forEach((l, i) => paintLine(ctx, look, l, cx, ys[i], size, 'center', true));
  } else if (anim === 'TYPEWRITER') {
    // Characters appear left to right; each line keeps its final position.
    let budget = Math.floor(t / 2);
    lines.forEach((l, i) => {
      const shown = l.slice(0, Math.max(0, budget));
      budget -= l.length;
      paintLine(ctx, look, shown, cx - widths[i] / 2, ys[i], size, 'left', true);
    });
  } else if (anim === 'WORDS') {
    let k = 0;
    lines.forEach((l, i) => {
      let x = cx - widths[i] / 2;
      for (const word of l.split(' ')) {
        setFont(ctx, look.style, size);
        const w = ctx.measureText(word).width;
        const local = t - k * 5;
        if (local >= 0) {
          const a = easeOut(local / 5);
          ctx.save();
          ctx.globalAlpha = a;
          ctx.translate(x + w / 2, ys[i]);
          ctx.scale(0.7 + 0.3 * a, 0.7 + 0.3 * a);
          paintLine(ctx, look, word, 0, 0, size, 'center', true);
          ctx.restore();
        }
        x += w + ctx.measureText(' ').width;
        k++;
      }
    });
  } else {
    // GLITCH: sliced, jittering copies that settle after 12 frames.
    const settled = t >= animLength('GLITCH', '');
    if (!settled && t % 3 === 1) ctx.globalAlpha = 0.6;
    const bands = settled ? 1 : 4;
    const top = ys[0] - lh;
    const height = lh * (lines.length + 1);
    for (let b = 0; b < bands; b++) {
      ctx.save();
      if (!settled) {
        ctx.beginPath();
        ctx.rect(0, top + (height * b) / bands, W, height / bands);
        ctx.clip();
        ctx.translate((noise(t * 7 + b) - 0.5) * 60 * u, 0);
      }
      lines.forEach((l, i) => paintLine(ctx, look, l, cx, ys[i], size, 'center', true));
      ctx.restore();
    }
  }
  ctx.restore();
  if (look.style === 'RAVE_MONO' && lines.length === 1 && (t >= animLength(anim, lines[0]) || anim === 'POP')) {
    monoRules(ctx, cx, ys[0], widths[0], W, u);
  }
}

function paintRows(ctx: CanvasRenderingContext2D, look: Look, rows: (readonly [string, string])[], f: number,
  starts: number[] | null, anim: TextAnim, centerY: number, W: number, u: number) {
  const x0 = W * 0.1;
  const x1 = W * 0.9;
  const size = fitSize(ctx, look.style, rows.map(([l, r]) => `${l}      ${r}`), x1 - x0, START_SIZE.rows[look.style] * u);
  const lh = size * (look.style === 'TAPE_LABEL' ? 1.9 : 1.7);
  const top = centerY - ((rows.length - 1) * lh) / 2;
  rows.forEach(([left, right], i) => {
    const rs = starts ? starts[i] : -Infinity;
    if (f < rs) return;
    const local = f - rs;
    const y0 = top + i * lh;
    let l = left;
    let r = right;
    let dx = 0;
    let dy = 0;
    let alpha = 1;
    if (starts && anim === 'TYPEWRITER') {
      const n = local;
      l = left.slice(0, n);
      r = right.slice(0, Math.max(0, n - left.length - 2));
    } else if (starts && anim === 'SLIDE') {
      const a = easeOut(local / 8);
      dx = (i % 2 ? 1 : -1) * (1 - a) * W * 0.3;
      alpha = a;
    } else if (starts) {
      const a = easeOut(local / POP_FRAMES);
      dy = (1 - a) * 24 * u;
      alpha = a;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx, dy);
    paintLine(ctx, look, l, x0, y0, size, 'left');
    paintLine(ctx, look, r, x1, y0, size, 'right');
    setFont(ctx, look.style, size);
    const a0 = x0 + ctx.measureText(left).width + 22 * u;
    const a1 = x1 - ctx.measureText(right).width - 22 * u;
    const lineDone = !(starts && anim === 'TYPEWRITER') || local >= left.length;
    if (lineDone && a1 - a0 > 30 * u && look.style !== 'TAPE_LABEL') {
      ctx.strokeStyle = look.style === 'CHROME_Y2K' ? '#c7d0db' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1, 3 * u);
      if (look.style === 'RAVE_MONO') ctx.setLineDash([10 * u, 7 * u]);
      ctx.beginPath();
      ctx.moveTo(a0, y0);
      ctx.lineTo(a1 - (look.style === 'RAVE_MONO' ? 26 * u : 0), y0);
      ctx.stroke();
      ctx.setLineDash([]);
      if (look.style === 'RAVE_MONO') {
        ctx.fillStyle = '#f4f4f5';
        ctx.font = `700 ${size * 0.8}px "Space Mono"`;
        ctx.letterSpacing = '0px';
        ctx.textAlign = 'center';
        ctx.fillText('+', a1 - 10 * u, y0);
      }
    }
    ctx.restore();
  });
}

/** Preset positions as the logo's centre (canvas fractions). Kept clear of the right-edge buttons and bottom quarter. */
export const LOGO_PRESETS: Record<Exclude<Logo['placement'], 'CUSTOM'>, (wFrac: number, hFrac: number) => [number, number]> = {
  TOP_LEFT: (w, h) => [0.06 + w / 2, 0.09 + h / 2],
  TOP_CENTER: (_w, h) => [0.5, 0.09 + h / 2],
  TOP_RIGHT: (w, h) => [0.88 - w / 2, 0.09 + h / 2],
  CENTER: () => [0.5, 0.5],
  LOWER_THIRD: () => [0.5, 0.7],
};

/** Where a logo sits (top-left x, y, width, height in px) for an image with this width/height ratio. */
export function logoRect(logo: Logo, aspect: number, W: number, H: number): [number, number, number, number] {
  const w = W * logo.width_frac;
  const h = w / Math.max(aspect, 1e-6);
  const [cx, cy] = logo.placement === 'CUSTOM' && logo.x != null && logo.y != null
    ? [logo.x, logo.y]
    : LOGO_PRESETS[logo.placement === 'CUSTOM' ? 'TOP_LEFT' : logo.placement](logo.width_frac, h / H);
  return [cx * W - w / 2, cy * H - h / 2, w, h];
}

function paintLogo(ctx: CanvasRenderingContext2D, e: Extract<GraphicsEvent, { kind: 'logo' }>, img: HTMLImageElement, f: number, W: number, H: number) {
  const { logo } = e;
  let [x, y, w, h] = logoRect(logo, img.naturalWidth / Math.max(img.naturalHeight, 1), W, H);
  let scale = 1;
  let alpha = 1;
  const u = W / 1080;
  if (logo.motion === 'PULSE') {
    const since = Math.min(framesSinceBeat(f, e.bpm, e.fps, e.framesPerBeat), LOGO_PULSE_FRAMES);
    scale = since >= LOGO_PULSE_FRAMES ? 1 : 1 + 0.08 * Math.exp(-since / 3);
  } else if (logo.motion === 'JITTER') {
    const t = (Math.floor(f / LOGO_JITTER_STEP) * LOGO_JITTER_STEP) / e.fps;
    x += (3 * Math.sin(2 * Math.PI * t * 7.3) + 2 * Math.sin(2 * Math.PI * t * 13.1)) * u;
    y += (2 * Math.sin(2 * Math.PI * t * 5.9) + 2 * Math.sin(2 * Math.PI * t * 11.7)) * u;
  } else if (logo.motion === 'FADE') {
    alpha = Math.min(1, (f - e.start) / LOGO_FADE_FRAMES, (e.end - 1 - f) / LOGO_FADE_FRAMES);
  }
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/**
 * Paint the graphics layer for frame `f` onto a transparent W x H context. Logos whose
 * image isn't in `images` are skipped; returns false if any were (caller should retry).
 */
export function drawGraphicsFrame(ctx: CanvasRenderingContext2D, look: Look, events: GraphicsEvent[], f: number,
  W: number, H: number, images: Map<string, HTMLImageElement>): boolean {
  ctx.clearRect(0, 0, W, H);
  const u = W / 1080;

  let complete = true;
  // Logos first so text always reads on top of them.
  for (const e of events) {
    if (e.kind !== 'logo' || f < e.start || f >= e.end) continue;
    const img = images.get(e.logo.path);
    if (img) paintLogo(ctx, e, img, f, W, H);
    else complete = false;
  }
  for (const e of events) {
    if (e.kind === 'logo' || f < e.start || f >= e.end) continue;
    const t = f - e.start;
    ctx.save();
    if (e.kind === 'title') {
      const measure = (s: string, sz: number) => {
        setFont(ctx, look.style, sz);
        return ctx.measureText(s).width;
      };
      const { size, lines } = layoutBlock(measure, prep(look, e.text), W * 0.84, START_SIZE.title[look.style] * u, 3);
      paintTitle(ctx, look, lines, size, W / 2, H / 2, t, e.anim, W, u);
    } else if (e.kind === 'hook') {
      if (!(e.drop && DROP_FLICKER.has(t))) paintHook(ctx, look, prep(look, e.text), e.drop, e.anim, t, W, H, u);
    } else if (e.kind === 'rows') {
      const rows = e.rows.map((r) => [prep(look, r.left.trim()), prep(look, r.right.trim())] as const);
      paintRows(ctx, look, rows, f, e.rowStarts, e.anim, H / 2, W, u);
    } else {
      // End card: dates/lineup (all at once) above the call to action.
      const a = easeOut(t / POP_FRAMES);
      ctx.globalAlpha = a;
      const rows = e.rows.map((r) => [prep(look, r.left.trim()), prep(look, r.right.trim())] as const);
      if (rows.length) paintRows(ctx, look, rows, f, null, 'POP', H * 0.42, W, u);
      if (e.cta) {
        const text = prep(look, e.cta);
        const size = fitSize(ctx, look.style, [text], W * 0.84, START_SIZE.cta[look.style] * u);
        const y = rows.length ? H * 0.62 : H / 2;
        ctx.translate(W / 2, y + (1 - a) * 30 * u);
        paintLine(ctx, look, text, 0, 0, size, 'center', true);
      }
    }
    ctx.restore();
  }
  return complete;
}

function paintHook(ctx: CanvasRenderingContext2D, look: Look, text: string, drop: boolean, anim: TextAnim, t: number,
  W: number, H: number, u: number) {
  // Fit the animation's peak scale, not the settled size, so the word never runs off frame.
  const peak = drop ? 1 + DROP_PUNCH : anim === 'SLAM' ? 1.12 : 1;
  const size = fitSize(ctx, look.style, [text], (W * 0.94) / peak, (drop ? 190 : 150) * u);
  ctx.translate(W / 2, H / 2);
  if (drop || anim === 'SLAM') {
    const span = drop ? DROP_FRAMES : POP_FRAMES;
    const s = 1 + (peak - 1) * (1 - Math.min(t, span) / span) ** 2;
    ctx.scale(s, s);
    paintLine(ctx, look, text, 0, 0, size, 'center', true);
  } else if (anim === 'FLICKER') {
    if (t >= POP_FRAMES || t % 2 === 0) paintLine(ctx, look, text, 0, 0, size, 'center', true);
  } else if (anim === 'ZOOM') {
    const a = easeOut(t / POP_FRAMES);
    ctx.globalAlpha = a;
    ctx.scale(0.3 + 0.7 * a, 0.3 + 0.7 * a);
    paintLine(ctx, look, text, 0, 0, size, 'center', true);
  } else {
    // LETTERS: one letter per frame, the newest half-transparent.
    setFont(ctx, look.style, size);
    const full = ctx.measureText(text).width;
    const n = Math.min(text.length, t + 1);
    paintLine(ctx, look, text.slice(0, n - 1), -full / 2, 0, size, 'left', true);
    setFont(ctx, look.style, size);
    const x = -full / 2 + ctx.measureText(text.slice(0, n - 1)).width;
    ctx.globalAlpha = n >= text.length && t >= animLength('LETTERS', text) ? 1 : 0.5;
    paintLine(ctx, look, text.slice(n - 1, n), x, 0, size, 'left', true);
  }
  if (look.style === 'RAVE_MONO') {
    ctx.globalAlpha = 1;
    setFont(ctx, look.style, size);
    monoRules(ctx, 0, size * 0.9, ctx.measureText(text).width * 0.6, W, u);
  }
}

/**
 * Rasterize the whole graphics layer at export resolution: one PNG per run of identical
 * frames. Returns null when there is nothing to draw.
 */
export async function renderGraphicsTrack(session: Session, onProgress?: (done: number, total: number) => void) {
  const events = graphicsSchedule(session);
  if (events.length === 0) return null;
  await ensureFonts();
  const images = await loadLogoImages(session.sequence.style.logos);
  const look = textLook(session.sequence);
  const [W, H] = session.resolution;
  const total = promoFrameCount(session);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const spans: { file: string; start: number; end: number }[] = [];
  const files: File[] = [];
  let curKey = '';
  let spanStart = 0;
  for (let f = 0; f <= total; f++) {
    const key = f < total ? graphicsFrameKey(events, f) : '';
    if (key === curKey && f < total) continue;
    if (curKey) {
      // The canvas still holds the frame drawn when this span opened.
      const file = `t_${String(files.length).padStart(4, '0')}.png`;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Could not encode a graphics frame');
      spans.push({ file, start: spanStart, end: f });
      files.push(new File([blob], file, { type: 'image/png' }));
    }
    if (key && f < total) drawGraphicsFrame(ctx, look, events, f, W, H, images);
    curKey = key;
    spanStart = f;
    onProgress?.(f, total);
  }
  return { manifest: { fps: session.fps, width: W, height: H, total_frames: total, spans }, files };
}
