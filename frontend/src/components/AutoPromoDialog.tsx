import { useState } from 'react';
import { api, mediaUrl, type HarvestVersion } from '../lib/api';
import { runAutoPromo, VIDEO_TYPES, type VideoTypeId } from '../lib/autoPromo';
import { parseInfoRows } from '../lib/graphicsLayer';
import { useStore } from '../lib/store';

const LENGTHS = [15, 30, 45, 60];

interface Step {
  name: string;
  detail?: string;
}

/** One form → a finished promo: clips harvested, song analysed, edit rolled (and optionally exported). */
export default function AutoPromoDialog({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session);
  const [folder, setFolder] = useState(session?.source_folders.at(-1) ?? '');
  const [audioPath, setAudioPath] = useState(session?.sequence.audio_path ?? '');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [length, setLength] = useState(30);
  const [typeId, setTypeId] = useState<VideoTypeId>('RAVE_COLLAGE');
  const [newProject, setNewProject] = useState(true);
  const [projectName, setProjectName] = useState(`Auto promo ${new Date().toLocaleDateString()}`);
  const [title, setTitle] = useState('');
  const [hooks, setHooks] = useState('');
  const [rows, setRows] = useState('');
  const [cta, setCta] = useState('');
  const [exportWhenDone, setExportWhenDone] = useState(false);
  const [harvestVersion, setHarvestVersion] = useState<HarvestVersion>(2);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const report = (name: string, detail?: string) =>
    setSteps((s) => (s.at(-1)?.name === name ? [...s.slice(0, -1), { name, detail }] : [...s, { name, detail }]));

  const pick = async (kind: 'folder' | 'audio') => {
    const { path } = await api.pick(kind);
    if (!path) return;
    if (kind === 'folder') setFolder(path);
    else {
      setAudioPath(path);
      setAudioFile(null);
    }
  };

  const canRun = folder.trim() && (audioFile || audioPath.trim()) && (!newProject || projectName.trim());
  const run = async () => {
    setRunning(true);
    setError(null);
    setSteps([]);
    try {
      const out = await runAutoPromo({
        projectName: newProject ? projectName.trim() : null,
        folder: folder.trim(),
        audio: audioFile ? { file: audioFile } : { path: audioPath.trim() },
        lengthSec: length,
        typeId,
        text: {
          title: title.trim(),
          hooks: hooks.split(',').map((w) => w.trim()).filter(Boolean),
          rows: parseInfoRows(rows),
          cta: cta.trim(),
        },
        exportWhenDone,
        harvestVersion,
      }, report);
      setOutput(out);
      setFinished(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-full w-[640px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-900 text-xs shadow-2xl">
        <div className="flex items-center border-b border-ink-700 px-4 py-3">
          <span className="text-sm font-semibold">✨ Auto promo</span>
          <span className="ml-2 text-zinc-500">song + clips in, finished edit out</span>
          <button className="ml-auto text-zinc-500 hover:text-white" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>

        {steps.length === 0 || error ? (
          <div className="space-y-4 overflow-y-auto p-4">
            <section className="space-y-1">
              <div className="panel-title">Song</div>
              <div className="flex gap-1">
                <input className="input flex-1" placeholder="Path to the track" value={audioFile ? audioFile.name : audioPath}
                  onChange={(e) => { setAudioPath(e.target.value); setAudioFile(null); }} />
                <button className="btn" onClick={() => void pick('audio')}>Browse…</button>
                <label className="btn cursor-pointer">
                  Upload
                  <input type="file" accept="audio/*" className="hidden" onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            </section>
            <section className="space-y-1">
              <div className="panel-title">Clips folder</div>
              <div className="flex gap-1">
                <input className="input flex-1" placeholder="Folder with the raw videos" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button className="btn" onClick={() => void pick('folder')}>Browse…</button>
              </div>
            </section>
            <section className="flex items-center gap-2">
              <div className="panel-title !mb-0 w-16">Length</div>
              {LENGTHS.map((l) => (
                <button key={l} className={`btn ${length === l ? 'border-rose-500 text-white' : ''}`} onClick={() => setLength(l)}>
                  {l} s
                </button>
              ))}
            </section>
            <section>
              <div className="panel-title">Type of video</div>
              <div className="grid grid-cols-2 gap-1">
                {VIDEO_TYPES.map((t) => (
                  <button key={t.id} onClick={() => setTypeId(t.id)}
                    className={`rounded border p-2 text-left ${typeId === t.id ? 'border-rose-500 bg-ink-700' : 'border-ink-600 hover:bg-ink-800'}`}>
                    <div className="font-semibold">{t.label}</div>
                    <div className="text-[10px] text-zinc-500">{t.hint}</div>
                  </button>
                ))}
              </div>
            </section>
            <section className="space-y-1">
              <div className="panel-title">Text (optional)</div>
              <input className="input w-full" placeholder="Event title, e.g. BAILE TRAMA w/ SANTANA LOUIS" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className="input w-full" placeholder="Hook words, comma separated: ATTENTION!, SOLD OUT" value={hooks} onChange={(e) => setHooks(e.target.value)} />
              <textarea className="input h-16 w-full font-mono" placeholder={'Dates, one per line: BERLIN + 09/10'} value={rows} onChange={(e) => setRows(e.target.value)} />
              <input className="input w-full" placeholder="Call to action: TICKETS · LINK IN BIO" value={cta} onChange={(e) => setCta(e.target.value)} />
            </section>
            <section className="space-y-1">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-rose-500" checked={newProject} onChange={(e) => setNewProject(e.target.checked)} />
                Build it in a new project
                <input className="input flex-1" disabled={!newProject} value={projectName} onChange={(e) => setProjectName(e.target.value)} />
              </label>
              {!newProject && <p className="text-[10px] text-amber-300">The open project's zones and Beat Cards will be replaced (Ctrl+Z undoes it).</p>}
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-rose-500" checked={exportWhenDone} onChange={(e) => setExportWhenDone(e.target.checked)} />
                Export the MP4 when it's ready
              </label>
              <label className="flex items-center gap-2" title="v2 checks each candidate frame by frame (shake, flicker, cuts, focus, sharpness); v1 is the quick keyframe-only pick">
                Harvest
                <select className="input" value={harvestVersion} onChange={(e) => setHarvestVersion(e.target.value === '1' ? 1 : 2)}>
                  <option value={2}>v2 (frame by frame)</option>
                  <option value={1}>v1 (keyframes only)</option>
                </select>
              </label>
            </section>
            {error && <pre className="whitespace-pre-wrap rounded bg-red-950 p-2 text-red-200">{error}</pre>}
          </div>
        ) : (
          <ol className="space-y-1.5 overflow-y-auto p-4">
            {steps.map((s, i) => {
              const current = running && i === steps.length - 1;
              return (
                <li key={s.name} className="flex gap-2">
                  <span className={current ? 'animate-pulse text-amber-300' : 'text-emerald-400'}>{current ? '●' : '✓'}</span>
                  <span className="w-40 text-zinc-200">{s.name}</span>
                  <span className="text-zinc-500">{s.detail}</span>
                </li>
              );
            })}
          </ol>
        )}

        <div className="flex items-center gap-2 border-t border-ink-700 px-4 py-3">
          {finished ? (
            <>
              {output && (
                <a className="btn" href={mediaUrl(output)} target="_blank" rel="noreferrer">
                  Open MP4
                </a>
              )}
              <button className="btn btn-primary ml-auto" onClick={onClose}>
                Done: show me the edit
              </button>
            </>
          ) : (
            <button className="btn btn-primary ml-auto" disabled={!canRun || running} onClick={() => void run()}>
              {running ? 'Working…' : error ? 'Try again' : 'Make my promo'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
