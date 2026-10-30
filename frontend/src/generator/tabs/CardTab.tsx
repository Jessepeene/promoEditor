import NumberField from '../../components/NumberField';
import { TAG_NAMES } from '../../lib/dom';
import { withLayout } from '../../lib/solver';
import { useStore } from '../../lib/store';
import { layoutRegions } from '../../lib/timing';
import type { Cell, LayoutParams, LayoutType, Session, Slot, SlotFx, Transition } from '../../types/session';
import { LAYOUTS } from '../../types/session';
import { durationLabel } from '../BeatCards';
import { ZONE_LABELS } from '../Timeline';
import { LAYOUT_LABEL } from './StyleTab';

const FX_TOGGLES: [keyof SlotFx, string][] = [
  ['speed_ramp', 'Velocity ramp (fullscreen anchor clips)'],
  ['bounce', 'Scale bounce'],
  ['shake', 'Impact shake'],
  ['rgb_split', 'RGB split'],
  ['glitch', 'Block glitch'],
  ['invert', 'Invert flash'],
  ['strobe', 'Black-frame strobe'],
  ['mirror', 'Mirror'],
  ['echo', 'Echo trails'],
  ['dim', 'Dim (for text on top)'],
];

export default function CardTab({ session, slot }: { session: Session; slot: Slot | null }) {
  const update = useStore((s) => s.update);
  if (!slot) {
    return (
      <p className="text-zinc-500">
        Click a Beat Card to inspect it. Hover a card and press <span className="kbd">T</span> to cycle its layout.
      </p>
    );
  }

  // Hand edits lock the card so the next reroll keeps them.
  const edit = (fn: (s: Slot) => Slot) =>
    update(
      (s) => ({
        ...s,
        sequence: { ...s.sequence, slots: s.sequence.slots.map((x) => (x.slot_id === slot.slot_id ? { ...fn(x), locked: true } : x)) },
      }),
      true,
    );
  const editCell = (i: number, patch: Partial<Cell>) => edit((s) => ({ ...s, cells: s.cells.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const setFx = (patch: Partial<SlotFx>) => edit((s) => ({ ...s, fx: { ...s.fx, ...patch } }));
  const setParams = (patch: Partial<LayoutParams>) => edit((s) => withLayout(session, s, s.layout, { ...s.layout_params, ...patch }));
  const regions = Object.keys(layoutRegions(slot.layout, slot.layout_params, 1080, 1920));
  const fx = slot.fx;

  return (
    <>
      <section className="space-y-1">
        <div className="panel-title">
          Card B{slot.start_beat} · {durationLabel(slot)}
        </div>
        <div className="text-zinc-400">
          {ZONE_LABELS[slot.zone_type]} · {slot.locked ? '🔒 locked' : 'unlocked'}
        </div>
        <button
          className="btn"
          onClick={() =>
            update((s) => ({ ...s, sequence: { ...s.sequence, slots: s.sequence.slots.map((x) => (x.slot_id === slot.slot_id ? { ...x, locked: !x.locked } : x)) } }), true)
          }
        >
          {slot.locked ? 'Unlock' : 'Lock'}
        </button>
      </section>

      <section className="space-y-2">
        <div className="panel-title">Layout</div>
        <select className="input w-full" value={slot.layout} onChange={(e) => edit((s) => withLayout(session, s, e.target.value as LayoutType))}>
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {LAYOUT_LABEL[l]}
            </option>
          ))}
        </select>
        {slot.layout === 'STROBE_MATRIX' && (
          <select className="input w-full" value={slot.layout_params.matrix} onChange={(e) => setParams({ matrix: e.target.value as LayoutParams['matrix'] })}>
            <option value="3x3">3×3 grid</option>
            <option value="3x4">3×4 grid</option>
            <option value="2x5">2×5 grid</option>
          </select>
        )}
        {slot.layout === 'SPLIT_2' && (
          <select className="input w-full" value={slot.layout_params.split} onChange={(e) => setParams({ split: e.target.value as LayoutParams['split'] })}>
            <option value="ROWS">Top / bottom</option>
            <option value="COLS">Left / right</option>
          </select>
        )}
        {slot.layout === 'CENTER_PIP_PUNCH' && (
          <div className="flex gap-1">
            <select className="input flex-1" value={slot.layout_params.pip_aspect} onChange={(e) => setParams({ pip_aspect: e.target.value as LayoutParams['pip_aspect'] })}>
              <option value="1:1">1:1 box</option>
              <option value="4:3">4:3 box</option>
            </select>
            <select className="input flex-1" value={slot.layout_params.pip_background} onChange={(e) => setParams({ pip_background: e.target.value as LayoutParams['pip_background'] })}>
              <option value="FULLSCREEN">over fullscreen</option>
              <option value="STACK">over 3-stack</option>
            </select>
          </div>
        )}
      </section>

      <section className="space-y-1">
        <div className="panel-title">Motion &amp; FX</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {FX_TOGGLES.map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5">
              <input type="checkbox" className="accent-rose-500" checked={Boolean(fx[key])} onChange={(e) => setFx({ [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">Push</span>
          <select className="input flex-1" value={fx.push} onChange={(e) => setFx({ push: e.target.value as SlotFx['push'] })}>
            <option value="NONE">None</option>
            <option value="IN">Slow push in</option>
            <option value="OUT">Slow pull out</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">Speed</span>
          <NumberField value={fx.speed} step={0.05} min={0.1} max={4} className="w-20" onCommit={(v) => setFx({ speed: v })} />
          <span className="text-zinc-600">when ramp is off</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">Transition in</span>
          <select className="input flex-1" value={fx.transition} onChange={(e) => setFx({ transition: e.target.value as Transition })}>
            <option value="CUT">Cut</option>
            <option value="CROSSFADE">Crossfade</option>
            <option value="FLASH">White flash</option>
          </select>
        </label>
      </section>

      <section>
        <div className="panel-title">Cells</div>
        <div className="space-y-1.5">
          {slot.cells.map((cell, i) => (
            <div key={i} className="rounded border border-ink-700 p-1.5">
              <div className="mb-1 flex items-center gap-1">
                <select className="input w-16" value={cell.region} onChange={(e) => editCell(i, { region: e.target.value })}>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <select className="input flex-1" value={cell.clip_id} onChange={(e) => editCell(i, { clip_id: e.target.value })}>
                  {session.clips.map((c) => (
                    <option key={c.clip_id} value={c.clip_id}>
                      {c.clip_id} · {TAG_NAMES[c.energy_tag]} · {c.source_path.split(/[\\/]/).pop()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1 text-zinc-500">
                <span>
                  {cell.start}→{cell.end ?? 'end'} b
                </span>
                <select className="input ml-auto" value={cell.anchor_lock} onChange={(e) => editCell(i, { anchor_lock: e.target.value as Cell['anchor_lock'] })}>
                  <option value="DOWNBEAT">anchor on downbeat</option>
                  <option value="MIDPOINT">anchor at midpoint</option>
                </select>
                <NumberField value={cell.slip_frames} step={2} className="w-14" onCommit={(v) => editCell(i, { slip_frames: Math.round(v) })} />
                <span>f</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
