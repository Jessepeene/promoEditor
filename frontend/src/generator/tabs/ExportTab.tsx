import { useEffect, useState } from 'react';
import { api, mediaUrl, type BrollStatus, type ExportStatus } from '../../lib/api';
import { renderGraphicsTrack } from '../../lib/graphicsLayer';
import { useStore } from '../../lib/store';
import type { Session } from '../../types/session';

export default function ExportTab({ session }: { session: Session }) {
  const setError = useStore((s) => s.setError);
  const [status, setStatus] = useState<ExportStatus>({ state: 'idle' });
  const [encoder, setEncoder] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const running = ['planning', 'rendering', 'finalizing'].includes(status.state);

  useEffect(() => {
    api.health().then((h) => setEncoder(h.encoder), (e: Error) => setError(e.message));
    api.exportStatus().then(setStatus, (e: Error) => setError(e.message));
  }, [setError]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      api.exportStatus().then(setStatus, (e: Error) => setError(`Export status: ${e.message}`));
    }, 500);
    return () => clearInterval(id);
  }, [running, setError]);

  const start = async () => {
    try {
      // Text and logos are rasterized here so the MP4 uses exactly the preview's fonts and styling.
      setPreparing('Rendering text & logos…');
      const track = await renderGraphicsTrack(session, (done, total) =>
        setPreparing(`Rendering text & logos… ${Math.round((100 * done) / total)}%`),
      );
      let trackId: string | null = null;
      if (track) {
        setPreparing(`Uploading ${track.files.length} graphics frame(s)…`);
        trackId = (await api.uploadTextTrack(track.manifest, track.files)).text_track_id;
      }
      setStatus(await api.startExport(session, trackId));
    } catch (e) {
      setError(`Export failed to start: ${(e as Error).message}`);
    } finally {
      setPreparing(null);
    }
  };

  const unsliced = session.clips.filter((c) => c.proxy_status !== 'ready').length;
  const [w, h] = session.resolution;
  return (
    <section className="space-y-3">
      <div className="panel-title">Export MP4</div>
      <div className="text-zinc-400">
        {w}×{h} · {session.fps} fps · H.264 18 Mb/s · AAC 320k
        <br />
        Encoder: {encoder ?? '…'}
      </div>
      {session.sequence.slots.length === 0 && <p className="text-amber-300">Roll some Beat Cards first.</p>}
      {unsliced > 0 && <p className="text-amber-300">{unsliced} clip(s) aren't sliced yet; they'll be read from the raw source (slower).</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={running || preparing != null || session.sequence.slots.length === 0} onClick={() => void start()}>
          Export MP4
        </button>
        {preparing && <span className="self-center text-zinc-400">{preparing}</span>}
        {running && (
          <button className="btn" onClick={() => api.cancelExport().then(setStatus, (e: Error) => setError(e.message))}>
            Cancel
          </button>
        )}
      </div>
      <BrollPack session={session} />
      {status.state !== 'idle' && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-ink-700">
            <div className="h-full bg-rose-500 transition-all" style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
          </div>
          <div className="text-zinc-400">
            {status.message}
            {status.state === 'rendering' && ` (${status.segments_done ?? 0}/${status.segments})`}
          </div>
          {status.state === 'error' && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-950 p-2 text-[10px] text-red-200">{status.error}</pre>}
          {status.state === 'done' && status.output && (
            <div className="space-y-1">
              <a className="btn" href={mediaUrl(status.output)} target="_blank" rel="noreferrer">
                Open {status.output.split('/').pop()}
              </a>
              <div className="break-all text-[10px] text-zinc-500">project{status.output}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Every breather (range) clip delivered as a folder: native-size cuts with sound, a vertical reel, an index. */
function BrollPack({ session }: { session: Session }) {
  const setError = useStore((s) => s.setError);
  const [st, setSt] = useState<BrollStatus>({ state: 'idle' });
  const count = session.clips.filter((c) => c.mode === 'RANGE').length;

  useEffect(() => {
    if (st.state !== 'running') return;
    const id = setInterval(() => api.brollStatus().then(setSt, (e: Error) => setError(`B-roll pack: ${e.message}`)), 700);
    return () => clearInterval(id);
  }, [st.state, setError]);

  return (
    <div className="space-y-1 rounded border border-ink-700 p-2">
      <div className="flex items-center gap-2">
        <button
          className="btn"
          disabled={count === 0 || st.state === 'running'}
          onClick={() => api.startBrollPack().then(setSt, (e: Error) => setError(`B-roll pack: ${e.message}`))}
        >
          🎞 Export B-roll pack ({count})
        </button>
        {st.state === 'running' && <span className="text-zinc-400">{st.done}/{st.total}…</span>}
      </div>
      <p className="text-[10px] text-zinc-600">
        All range shots (tier 0) as separate files at original size with sound, plus one vertical reel and an index.
        {count === 0 && ' Hold 0 in the Logger or use “Harvest B-roll” to collect some.'}
      </p>
      {st.state === 'error' && <p className="text-red-300">{st.error}</p>}
      {st.state === 'done' && st.reel && (
        <div className="space-y-1">
          <a className="btn" href={mediaUrl(st.reel)} target="_blank" rel="noreferrer">
            Open B-roll reel
          </a>
          <div className="break-all text-[10px] text-zinc-500">project{st.folder}</div>
        </div>
      )}
    </div>
  );
}
