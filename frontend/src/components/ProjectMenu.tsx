import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ProjectList } from '../lib/api';
import { switchProject, useStore } from '../lib/store';

type Mode = 'menu' | 'new' | 'saveas';

/** Header dropdown: open another project, start a new one, or save the current one under a new name. */
export default function ProjectMenu() {
  const setError = useStore((s) => s.setError);
  const [list, setList] = useState<ProjectList | null>(null);
  const [open, setOpen] = useState<Mode | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => api.projects().then(setList, (e: Error) => setError(`Projects: ${e.message}`)),
    [setError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !boxRef.current?.contains(e.target)) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const run = async (action: () => Promise<ProjectList>) => {
    setBusy(true);
    try {
      let next: ProjectList | null = null;
      await switchProject(async () => {
        next = await action();
      });
      setList(next);
      setOpen(null);
      setName('');
    } catch (e) {
      setError(`Project: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const current = list?.projects.find((p) => p.id === list.current);
  return (
    <div ref={boxRef} className="relative">
      <button
        className="btn"
        onClick={(e) => {
          e.currentTarget.blur();
          setOpen(open ? null : 'menu');
          void refresh();
        }}
        title="Projects"
      >
        📁 {current?.name ?? '…'} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-ink-600 bg-ink-850 p-1 text-xs shadow-2xl">
          {open === 'menu' ? (
            <>
              <div className="max-h-64 overflow-y-auto">
                {list?.projects.map((p) => (
                  <button
                    key={p.id}
                    disabled={busy || p.id === list.current}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-700 disabled:cursor-default ${p.id === list.current ? 'text-rose-300' : ''}`}
                    onClick={() => void run(() => api.openProject(p.id))}
                  >
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="text-zinc-500">{p.clips} clips</span>
                  </button>
                ))}
              </div>
              <div className="mt-1 flex gap-1 border-t border-ink-700 pt-1">
                <button className="btn flex-1 justify-center" onClick={() => setOpen('new')}>
                  + New project
                </button>
                <button className="btn flex-1 justify-center" onClick={() => setOpen('saveas')}>
                  Save as…
                </button>
              </div>
            </>
          ) : (
            <form
              className="space-y-2 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                const copy = open === 'saveas';
                void run(() => api.createProject(name, copy));
              }}
            >
              <div className="text-zinc-400">
                {open === 'new' ? 'New empty project' : `Copy “${current?.name}” (clips, slices, uploads) to a new project`}
              </div>
              <input autoFocus className="input w-full" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
              <div className="flex gap-1">
                <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
                  {busy ? 'Working…' : open === 'new' ? 'Create' : 'Save copy'}
                </button>
                <button className="btn" type="button" onClick={() => setOpen('menu')}>
                  Back
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
