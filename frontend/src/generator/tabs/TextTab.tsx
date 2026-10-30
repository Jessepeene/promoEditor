import { ACCENTS, graphicsSchedule, HOOK_ANIMS, parseInfoRows, ROWS_ANIMS, textLook, TITLE_ANIMS } from '../../lib/graphicsLayer';
import { useStore } from '../../lib/store';
import type { Session, TextAnim, TextConfig, TextStyle } from '../../types/session';

const TEXT_STYLES: { id: TextStyle | 'AUTO'; label: string; sample: string }[] = [
  { id: 'AUTO', label: 'Auto', sample: 'new look every roll' },
  { id: 'RAVE_MONO', label: 'Rave mono', sample: '+--- A T T E N T I O N ---+' },
  { id: 'CHROME_Y2K', label: 'Chrome Y2K', sample: 'ATENÇÃO' },
  { id: 'CLEAN_BOLD', label: 'Clean bold', sample: 'Baile Trama' },
  { id: 'OUTLINE_STACK', label: 'Outline stack', sample: 'SOLD OUT ×3' },
  { id: 'TAPE_LABEL', label: 'Tape label', sample: '▮ NEXT FRIDAY ▮' },
  { id: 'NEON', label: 'Neon', sample: 'glowing tube' },
  { id: 'GRADIENT_POP', label: 'Gradient pop', sample: 'outlined + gradient' },
  { id: 'MINIMAL', label: 'Minimal', sample: 'S P A C E D' },
];

const ANIM_LABEL: Record<TextAnim, string> = {
  AUTO: 'Auto (varies per roll)',
  POP: 'Pop',
  TYPEWRITER: 'Typewriter',
  WORDS: 'Word by word',
  SLIDE: 'Slide',
  SLAM: 'Slam',
  GLITCH: 'Glitch',
  FLICKER: 'Flicker',
  ZOOM: 'Zoom in',
  LETTERS: 'Letter by letter',
};

function AnimSelect({ value, options, onChange }: { value: TextAnim; options: TextAnim[]; onChange: (a: TextAnim) => void }) {
  return (
    <select className="input w-full" value={value} onChange={(e) => onChange(e.target.value as TextAnim)}>
      {(['AUTO', ...options] as TextAnim[]).map((a) => (
        <option key={a} value={a}>
          {ANIM_LABEL[a]}
        </option>
      ))}
    </select>
  );
}

export default function TextTab({ session }: { session: Session }) {
  const update = useStore((s) => s.update);
  const cfg = session.sequence.text_config;
  const set = (patch: Partial<TextConfig>) =>
    update((s) => ({ ...s, sequence: { ...s.sequence, text_config: { ...s.sequence.text_config, ...patch } } }), true);
  const rowsText = cfg.info_rows.map((r) => (r.right ? `${r.left} + ${r.right}` : r.left)).join('\n');
  const hooksText = cfg.hook_words.join(', ');
  const look = textLook(session.sequence);
  const titleHidden = cfg.intro_title.trim() !== '' && !graphicsSchedule(session).some((e) => e.kind === 'title');

  // Fields commit on blur (one undo step per edit); `key` resets them after undo/redo.
  return (
    <>
      <section>
        <div className="panel-title">Style</div>
        <div className="grid grid-cols-3 gap-1">
          {TEXT_STYLES.map((st) => (
            <button
              key={st.id}
              className={`rounded border p-1.5 text-left ${cfg.style_preset === st.id ? 'border-rose-500 bg-ink-700' : 'border-ink-600 hover:bg-ink-800'}`}
              onClick={() => set({ style_preset: st.id })}
            >
              <div className="font-semibold">{st.label}</div>
              <div className="truncate text-[9px] text-zinc-500">{st.sample}</div>
            </button>
          ))}
        </div>
        {cfg.style_preset === 'AUTO' && (
          <p className="mt-1 text-[10px] text-zinc-500">This roll: {look.style.replace('_', ' ').toLowerCase()}. Press R for another look.</p>
        )}
        <div className="mt-2 flex items-center gap-1">
          <span className="mr-1 text-zinc-400">Accent</span>
          <button
            className={`rounded border px-1.5 py-0.5 ${cfg.accent === 'AUTO' ? 'border-rose-500 text-white' : 'border-ink-600 text-zinc-400'}`}
            onClick={() => set({ accent: 'AUTO' })}
          >
            Auto
          </button>
          {ACCENTS.map((c) => (
            <button
              key={c}
              title={c}
              className={`h-5 w-5 rounded border-2 ${cfg.accent === c ? 'border-white' : 'border-transparent'}`}
              style={{ background: c }}
              onClick={() => set({ accent: c })}
            />
          ))}
        </div>
        <p className="text-[10px] text-zinc-600">Used by Tape label, Neon, Gradient pop and Minimal.</p>
      </section>
      <section className="space-y-1">
        <div className="panel-title">Event header</div>
        <input
          key={cfg.intro_title}
          className="input w-full"
          placeholder="BAILE TRAMA w/ SANTANA LOUIS"
          defaultValue={cfg.intro_title}
          onBlur={(e) => e.target.value !== cfg.intro_title && set({ intro_title: e.target.value })}
        />
        <AnimSelect value={cfg.title_anim} options={TITLE_ANIMS} onChange={(a) => set({ title_anim: a })} />
        <p className="text-[10px] text-zinc-600">Centred over the Intro story zone (or the opening bars).</p>
        {titleHidden && (
          <p className="text-[10px] text-amber-300">
            Not shown with these zones: the promo opens straight into hook words. Add an Intro story zone, or clear the hook words.
          </p>
        )}
      </section>
      <section className="space-y-1">
        <div className="panel-title">Hook / flash words</div>
        <input
          key={hooksText}
          className="input w-full"
          placeholder="ATTENTION!, SOLD OUT, NEXT FRIDAY"
          defaultValue={hooksText}
          onBlur={(e) => {
            const words = e.target.value.split(',').map((w) => w.trim()).filter(Boolean);
            if (words.join(', ') !== hooksText) set({ hook_words: words });
          }}
        />
        <AnimSelect value={cfg.hook_anim} options={HOOK_ANIMS} onChange={(a) => set({ hook_anim: a })} />
        <p className="text-[10px] text-zinc-600">One word per beat of the Vocal breather, then a big punch on the drop. Auto mixes animations word to word.</p>
      </section>
      <section className="space-y-1">
        <div className="panel-title">Lineup / dates / locations</div>
        <textarea
          key={rowsText}
          className="input h-24 w-full font-mono"
          placeholder={'BERLIN + 09/10\nAMSTERDAM + 16/10\nLONDON + 24/10'}
          defaultValue={rowsText}
          onBlur={(e) => {
            const rows = parseInfoRows(e.target.value);
            if (JSON.stringify(rows) !== JSON.stringify(cfg.info_rows)) set({ info_rows: rows });
          }}
        />
        <AnimSelect value={cfg.rows_anim} options={ROWS_ANIMS} onChange={(a) => set({ rows_anim: a })} />
        <p className="text-[10px] text-zinc-600">
          One row per line, split with <span className="kbd">+</span>. Rows pop in per beat over the second half of the last drop, and
          are repeated on the end card.
        </p>
      </section>
      <section className="space-y-1">
        <div className="panel-title">Call to action</div>
        <input
          key={cfg.cta}
          className="input w-full"
          placeholder="TICKETS · LINK IN BIO"
          defaultValue={cfg.cta}
          onBlur={(e) => e.target.value !== cfg.cta && set({ cta: e.target.value })}
        />
        <p className="text-[10px] text-zinc-600">Shown on the End card zone (or the last 4 beats if there is none).</p>
      </section>
    </>
  );
}
