import type { Session, Slot } from '../types/session';
import CardTab from './tabs/CardTab';
import ExportTab from './tabs/ExportTab';
import StyleTab from './tabs/StyleTab';
import TextTab from './tabs/TextTab';

export type Tab = 'style' | 'text' | 'card' | 'export';

interface Props {
  session: Session;
  selectedSlot: Slot | null;
  selectedZone: number | null;
  onSelectZone: (i: number | null) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
}

export default function SidePanel({ session, selectedSlot, selectedZone, onSelectZone, tab, onTab }: Props) {
  return (
    <aside className="flex w-[330px] shrink-0 flex-col border-l border-ink-700 bg-ink-900">
      <div className="flex border-b border-ink-700">
        {(['style', 'text', 'card', 'export'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 py-2 text-xs font-semibold capitalize ${tab === t ? 'border-b-2 border-rose-500 text-white' : 'text-zinc-500'}`}
            onClick={() => onTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-3 text-xs">
        {tab === 'style' && <StyleTab session={session} selectedZone={selectedZone} onSelectZone={onSelectZone} />}
        {tab === 'text' && <TextTab session={session} />}
        {tab === 'card' && <CardTab session={session} slot={selectedSlot} />}
        {tab === 'export' && <ExportTab session={session} />}
      </div>
    </aside>
  );
}
