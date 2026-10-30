import { useEffect, useState } from 'react';
import AutoPromoDialog from './components/AutoPromoDialog';
import ProjectMenu from './components/ProjectMenu';
import GeneratorView from './generator/GeneratorView';
import { isTypingTarget } from './lib/dom';
import { flushSave, removeClip, useStore } from './lib/store';
import LoggerView from './logger/LoggerView';

/**
 * Save immediately. Text/number fields commit on blur, so blur the focused one first
 * and let React apply that edit before saving.
 */
async function saveNow() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await new Promise((r) => setTimeout(r, 0));
  // flushSave reports failures in the error banner itself.
  await flushSave().catch(() => undefined);
}

export default function App() {
  const { session, error, saving, lastSaved, view, setView, setError, load, undo, redo } = useStore();
  const [autoOpen, setAutoOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // Hover any clip (clip list, clip library, Beat Card thumbnail) + Backspace/Delete removes it.
  // Capture phase, so it wins over view shortcuts on the same keys (e.g. deleting a zone).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Backspace' && e.key !== 'Delete') || isTypingTarget(e.target)) return;
      const under = [...document.querySelectorAll(':hover')].at(-1);
      const clipId = under?.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId;
      if (!clipId) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      removeClip(clipId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === 'KeyS') {
        e.preventDefault(); // works from inside a field too, unlike the other shortcuts
        void saveNow();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-ink-700 bg-ink-900 px-4">
        <span className="text-sm font-bold tracking-tight">
          promo<span className="text-rose-500">Editor</span>
        </span>
        <ProjectMenu />
        <button
          className="btn btn-primary"
          disabled={!session}
          onClick={(e) => {
            e.currentTarget.blur();
            setAutoOpen(true);
          }}
          title="Pick a song, clips, length and style: it builds the whole promo"
        >
          ✨ Auto promo
        </button>
        <nav className="flex gap-1">
          {(['logger', 'generator'] as const).map((v) => (
            <button
              key={v}
              onClick={(e) => {
                setView(v);
                e.currentTarget.blur(); // keep Space/Tab for the tools' hotkeys
              }}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${
                view === v ? 'bg-rose-600 text-white' : 'text-zinc-400 hover:bg-ink-700'
              }`}
            >
              {v === 'logger' ? '1 · Logger' : '2 · Generator'}
            </button>
          ))}
        </nav>
        <span className="ml-auto text-[11px] text-zinc-500">
          {session
            ? `${session.clips.length} clips · ${
                saving ? 'saving…' : lastSaved ? `saved ${new Date(lastSaved).toLocaleTimeString()}` : 'autosave on'
              }`
            : 'loading…'}
        </span>
        <button
          className="btn"
          disabled={!session || saving}
          title="Save the project now (Ctrl+S). Edits also autosave."
          onClick={(e) => {
            e.currentTarget.blur();
            void saveNow();
          }}
        >
          💾 Save <span className="kbd">Ctrl+S</span>
        </button>
      </header>
      {error && (
        <div className="flex items-center gap-3 border-b border-red-900 bg-red-950 px-4 py-1.5 text-xs text-red-200">
          <span className="flex-1">{error}</span>
          <button className="btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <main className="min-h-0 flex-1">
        {session ? view === 'logger' ? <LoggerView /> : <GeneratorView /> : null}
      </main>
      {autoOpen && <AutoPromoDialog onClose={() => setAutoOpen(false)} />}
    </div>
  );
}
