import { useState } from 'react';
import NumberField from '../../components/NumberField';
import { api, mediaUrl } from '../../lib/api';
import { applyRecipe, LAYOUT_PRESETS, ZONE_RECIPES } from '../../lib/solver';
import { useStore } from '../../lib/store';
import type { LayoutType, Logo, LogoMotion, LogoPlacement, LogoWhen, Session, Style, Zone, ZoneType } from '../../types/session';
import { LAYOUTS } from '../../types/session';
import { ZONE_LABELS } from '../Timeline';

export const LAYOUT_LABEL: Record<LayoutType, string> = {
  FULLSCREEN_VELOCITY: 'Fullscreen velocity',
  STACK_3_ROW: '3-Stack rows',
  CENTER_PIP_PUNCH: 'Center PiP punch',
  STROBE_MATRIX: 'Strobe matrix',
  SPLIT_2: 'Split screen',
};
const ZONE_TYPES = Object.keys(ZONE_LABELS) as ZoneType[];
const MAX_LOGOS = 6;

const PLACEMENTS: Record<LogoPlacement, string> = {
  TOP_LEFT: 'Top left',
  TOP_CENTER: 'Top centre',
  TOP_RIGHT: 'Top right',
  CENTER: 'Centre',
  LOWER_THIRD: 'Lower third',
  CUSTOM: 'Custom (dragged)',
};
const WHENS: Record<LogoWhen, string> = { ALWAYS: 'Whole promo', INTRO: 'Intro', DROP: 'Drop', OUTRO: 'End card' };
const MOTIONS: Record<LogoMotion, string> = { STATIC: 'Static', PULSE: 'Pulse on beat', JITTER: 'Jitter', FADE: 'Fade in/out' };

interface Props {
  session: Session;
  selectedZone: number | null;
  onSelectZone: (i: number | null) => void;
}

export default function StyleTab({ session, selectedZone, onSelectZone }: Props) {
  const { update, setError } = useStore();
  const seq = session.sequence;
  const zones = [...seq.zones].sort((a, b) => a.start_beat - b.start_beat);
  const [uploading, setUploading] = useState(false);
  const [recipeId, setRecipeId] = useState(ZONE_RECIPES[0].id);

  const setZones = (next: Zone[]) =>
    update((s) => ({ ...s, sequence: { ...s.sequence, zones: [...next].sort((a, b) => a.start_beat - b.start_beat) } }), true);
  const setStyle = (patch: Partial<Style>) =>
    update((s) => ({ ...s, sequence: { ...s.sequence, style: { ...s.sequence.style, ...patch } } }), true);
  const setLogo = (i: number, patch: Partial<Logo>) =>
    setStyle({ logos: seq.style.logos.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const editZone = (i: number, patch: Partial<Zone>) => {
    const z = { ...zones[i], ...patch };
    const prevEnd = i > 0 ? zones[i - 1].end_beat : 0;
    const nextStart = i < zones.length - 1 ? zones[i + 1].start_beat : Infinity;
    if (z.start_beat < prevEnd || z.end_beat > nextStart || z.end_beat <= z.start_beat) {
      setError('Zones cannot overlap and must be at least a fraction of a beat long.');
      return;
    }
    setZones(zones.map((x, j) => (j === i ? z : x)));
  };

  const addLogo = async (file: File) => {
    setUploading(true);
    try {
      const png = file.type === 'image/svg+xml' ? await rasterizeSvg(file) : file;
      const { files } = await api.upload([png], 'assets');
      setStyle({ logos: [...seq.style.logos, { path: files[0].path, placement: 'TOP_LEFT', width_frac: 0.28, when: 'ALWAYS', motion: 'STATIC' }] });
    } catch (e) {
      setError(`Logo upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const weights = seq.style.layout_weights;
  const recipe = ZONE_RECIPES.find((r) => r.id === recipeId) ?? ZONE_RECIPES[0];
  return (
    <>
      <section>
        <div className="panel-title flex items-center justify-between">
          Zones <span className="normal-case tracking-normal text-zinc-600">beats · drag blocks on the timeline</span>
        </div>
        <div className="space-y-1">
          {zones.map((z, i) => (
            <div
              key={`${i}-${z.start_beat}`}
              className={`flex items-center gap-1 rounded p-1 ${selectedZone === i ? 'bg-ink-700' : ''}`}
              onClick={() => onSelectZone(i)}
            >
              <select className="input flex-1" value={z.type} onChange={(e) => editZone(i, { type: e.target.value as ZoneType })}>
                {ZONE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ZONE_LABELS[t]}
                  </option>
                ))}
              </select>
              <NumberField value={z.start_beat} step={1} min={0} className="w-14" onCommit={(v) => editZone(i, { start_beat: v })} />
              <NumberField value={z.end_beat} step={1} min={0} className="w-14" onCommit={(v) => editZone(i, { end_beat: v })} />
              <button
                className="px-1 text-zinc-500 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectZone(null);
                  setZones(zones.filter((_, j) => j !== i));
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-1">
          <div className="flex gap-1">
            <select className="input flex-1" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
              {ZONE_RECIPES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              className="btn"
              onClick={() => update((s) => ({ ...s, sequence: { ...s.sequence, ...applyRecipe(s.sequence, recipe) } }), true)}
            >
              Apply
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">{recipe.hint}. The song shifts so its drop still lands on the drop marker.</p>
          <button
            className="btn"
            onClick={() => {
              const start = zones.at(-1)?.end_beat ?? 0;
              setZones([...zones, { start_beat: start, end_beat: start + 8, type: 'HYBRID_DROP' }]);
            }}
          >
            + Add zone
          </button>
        </div>
      </section>

      <section>
        <div className="panel-title">Drop layout mix</div>
        <div className="mb-2 flex gap-1">
          {LAYOUT_PRESETS.map((p) => (
            <button key={p.id} className="btn" onClick={() => setStyle({ layout_weights: p.weights })}>
              {p.label}
            </button>
          ))}
        </div>
        {LAYOUTS.map((l) => (
          <label key={l} className="mb-1 flex items-center gap-2">
            <span className="w-32 text-zinc-400">{LAYOUT_LABEL[l]}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              className="flex-1 accent-rose-500"
              value={weights[l]}
              onChange={(e) => setStyle({ layout_weights: { ...weights, [l]: Number(e.target.value) } })}
            />
            <span className="w-8 text-right font-mono text-zinc-500">{Math.round(weights[l] * 100)}</span>
          </label>
        ))}
        <p className="text-[10px] text-zinc-600">Applies to Hybrid drop zones on the next reroll.</p>
      </section>

      <section>
        <div className="panel-title">Variety</div>
        <label className="flex items-center gap-2">
          <span className="w-32 text-zinc-400">Source cooldown</span>
          <input
            type="range"
            min={0}
            max={8}
            step={1}
            className="flex-1 accent-rose-500"
            value={seq.style.source_cooldown}
            onChange={(e) => setStyle({ source_cooldown: Number(e.target.value) })}
          />
          <span className="w-16 whitespace-nowrap text-right font-mono text-zinc-500">{seq.style.source_cooldown} cards</span>
        </label>
        <p className="text-[10px] text-zinc-600">
          Clips from the same file stay this many cards apart, and neighbouring cards never share a dominant colour.
          If a pool runs dry, an adjacent energy level is used with a micro-zoom. Applies on the next reroll.
        </p>
      </section>

      <section>
        <div className="panel-title">Effects</div>
        {(
          [
            ['bounce', 'Scale bounce + motion blur on drop cuts'],
            ['rgb_split', 'RGB split on downbeat impacts'],
            ['vhs_glitch', 'VHS scanlines + block glitch on bar lines'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="mb-1 flex items-center gap-2">
            <input type="checkbox" className="accent-rose-500" checked={seq.style[key]} onChange={(e) => setStyle({ [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <label className="mt-2 flex items-center gap-2">
          <span className="w-32 text-zinc-400">Extra effects</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.25}
            className="flex-1 accent-rose-500"
            value={seq.style.fx_intensity}
            onChange={(e) => setStyle({ fx_intensity: Number(e.target.value) })}
          />
          <span className="w-12 text-right font-mono text-zinc-500">
            {seq.style.fx_intensity === 0 ? 'off' : seq.style.fx_intensity <= 1 ? 'normal' : 'wild'}
          </span>
        </label>
        <p className="text-[10px] text-zinc-600">
          How often a reroll adds shake, push-in/out, invert flashes, strobe, mirror and echo trails. All are beat-locked.
        </p>
      </section>

      <section>
        <div className="panel-title">Logos</div>
        <div className="space-y-2">
          {seq.style.logos.map((logo, i) => (
            <div key={`${logo.path}-${i}`} className="space-y-1 rounded border border-ink-700 p-1.5">
              <div className="flex items-center gap-2">
                <img
                  src={mediaUrl(logo.path)}
                  className="h-8 max-w-[90px] rounded bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:10px_10px] object-contain"
                  alt=""
                />
                <select
                  className="input flex-1"
                  value={logo.placement}
                  onChange={(e) => setLogo(i, { placement: e.target.value as LogoPlacement, x: null, y: null })}
                >
                  {/* "Custom" comes from dragging the logo in the preview, so it's only listed once set. */}
                  {Object.entries(PLACEMENTS)
                    .filter(([k]) => k !== 'CUSTOM' || logo.placement === 'CUSTOM')
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
                <button className="px-1 text-zinc-500 hover:text-red-400" onClick={() => setStyle({ logos: seq.style.logos.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
              <div className="flex gap-1">
                <select className="input flex-1" value={logo.when} onChange={(e) => setLogo(i, { when: e.target.value as LogoWhen })}>
                  {Object.entries(WHENS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <select className="input flex-1" value={logo.motion} onChange={(e) => setLogo(i, { motion: e.target.value as LogoMotion })}>
                  {Object.entries(MOTIONS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2">
                <span className="w-10 text-zinc-400">Size</span>
                <input
                  type="range"
                  min={0.08}
                  max={1}
                  step={0.02}
                  className="flex-1 accent-rose-500"
                  value={logo.width_frac}
                  onChange={(e) => setLogo(i, { width_frac: Number(e.target.value) })}
                />
                <span className="w-8 text-right font-mono text-zinc-500">{Math.round(logo.width_frac * 100)}%</span>
              </label>
            </div>
          ))}
        </div>
        {seq.style.logos.length < MAX_LOGOS && (
          <label className="btn mt-2 cursor-pointer">
            {uploading ? 'Uploading…' : '+ Add logo (PNG / SVG)'}
            <input
              type="file"
              accept="image/png,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addLogo(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
        <p className="mt-1 text-[10px] text-zinc-600">
          Drag a logo in the preview to place it anywhere. Presets avoid the bottom quarter and the right edge,
          where Reels/TikTok put their buttons and captions.
        </p>
      </section>
    </>
  );
}

/** ffmpeg builds usually can't decode SVG, so vector logos are rasterized to PNG in the browser. */
async function rasterizeSvg(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = 2160;
    const aspect = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 1;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width * aspect);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Could not rasterize the SVG');
    return new File([blob], file.name.replace(/\.svg$/i, '.png'), { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
