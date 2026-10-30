import { create } from 'zustand';
import type { Clip, Session } from '../types/session';
import { api, type FileEntry } from './api';
import { Rng } from './rng';

export type View = 'logger' | 'generator';

interface State {
  session: Session | null;
  error: string | null;
  saving: boolean;
  /** When the session last reached the server (ms epoch); null until the first save. */
  lastSaved: number | null;
  view: View;
  /** Every video in the opened folder / upload. */
  folderFiles: FileEntry[];
  /** Duplicate file path → the path of the copy that is kept. */
  duplicateOf: Record<string, string>;
  hideDuplicates: boolean;
  /** Progress text while the duplicate scan runs. */
  dupeScan: string | null;
  /** Seed of the shuffled logger order; null = folder order. */
  shuffleSeed: number | null;
  /** What the logger plays: folderFiles, minus duplicates when hidden, shuffled if on. */
  playlist: FileEntry[];
  playlistIndex: number;
  undoStack: Session[];
  redoStack: Session[];

  load: () => Promise<void>;
  /** Apply an edit. `undoable` snapshots the previous session first. */
  update: (fn: (s: Session) => Session, undoable?: boolean) => void;
  undo: () => void;
  redo: () => void;
  setView: (v: View) => void;
  /** Replace the folder's files; resolves when the duplicate scan has finished. */
  setFolderFiles: (files: FileEntry[]) => Promise<void>;
  /** Open a folder of raw clips (registers it with the server) and make it the playlist. */
  openFolder: (folder: string) => Promise<{ folder: string; files: FileEntry[] }>;
  setHideDuplicates: (hide: boolean) => void;
  /** Random logger order on/off; turning it on draws a fresh order. */
  setShuffle: (on: boolean) => void;
  setPlaylistIndex: (i: number) => void;
  setError: (e: string | null) => void;
}

type PlaylistInputs = Pick<State, 'folderFiles' | 'duplicateOf' | 'hideDuplicates' | 'shuffleSeed'>;

/** The logger playlist for these settings, keeping `current` selected if it's still in it. */
function visible(st: PlaylistInputs, current?: string) {
  let playlist = st.hideDuplicates ? st.folderFiles.filter((f) => !st.duplicateOf[f.path]) : st.folderFiles;
  if (st.shuffleSeed != null) playlist = new Rng(st.shuffleSeed).shuffle(playlist);
  const index = Math.max(0, playlist.findIndex((f) => f.path === current));
  return { playlist, playlistIndex: index };
}

const UNDO_LIMIT = 60;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<State>((set, get) => ({
  session: null,
  error: null,
  saving: false,
  lastSaved: null,
  view: 'logger',
  folderFiles: [],
  duplicateOf: {},
  hideDuplicates: true,
  dupeScan: null,
  shuffleSeed: null,
  playlist: [],
  playlistIndex: 0,
  undoStack: [],
  redoStack: [],

  load: async () => {
    try {
      const session = await api.getSession();
      set({ session, error: null });
      // Restore the logger playlist from the last opened folder.
      const last = session.source_folders.at(-1);
      if (last) {
        const { files } = await api.openFolder(last).catch(() => ({ files: [] as FileEntry[] }));
        get().setFolderFiles(files);
      }
      schedulePoll();
    } catch (e) {
      set({ error: `Backend unreachable: ${(e as Error).message}` });
    }
  },

  update: (fn, undoable = false) => {
    const prev = get().session;
    if (!prev) return;
    let next = fn(prev);
    if (next === prev) return;
    const highest = maxClipNumber(next);
    if (highest > (next.clip_seq ?? 0)) next = { ...next, clip_seq: highest };
    set((st) => ({
      session: next,
      undoStack: undoable ? [...st.undoStack.slice(-UNDO_LIMIT + 1), prev] : st.undoStack,
      redoStack: undoable ? [] : st.redoStack,
    }));
    scheduleSave();
    schedulePoll();
  },

  undo: () => {
    const { undoStack, session } = get();
    const prev = undoStack.at(-1);
    if (!prev || !session) return;
    set((st) => ({ session: prev, undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, session] }));
    scheduleSave();
  },

  redo: () => {
    const { redoStack, session } = get();
    const next = redoStack.at(-1);
    if (!next || !session) return;
    set((st) => ({ session: next, redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, session] }));
    scheduleSave();
  },

  setView: (view) => set({ view }),
  setFolderFiles: (files) => {
    const next = { ...get(), folderFiles: files, duplicateOf: {} };
    set({ folderFiles: files, duplicateOf: {}, ...visible(next) });
    return files.length > 1 ? scanDuplicates(files) : Promise.resolve();
  },
  openFolder: async (folder) => {
    const res = await api.openFolder(folder);
    // The server added the folder to the saved manifest (media from it is allowed only then);
    // take its list so our next autosave doesn't drop it again.
    const fresh = await api.getSession();
    set((st) => (st.session ? { session: { ...st.session, source_folders: fresh.source_folders } } : {}));
    void get().setFolderFiles(res.files);
    return res;
  },
  setHideDuplicates: (hide) => {
    const st = get();
    set({ hideDuplicates: hide, ...visible({ ...st, hideDuplicates: hide }, st.playlist[st.playlistIndex]?.path) });
  },
  setShuffle: (on) => {
    const st = get();
    const shuffleSeed = on ? Math.floor(Math.random() * 2 ** 31) : null;
    set({ shuffleSeed, ...visible({ ...st, shuffleSeed }, st.playlist[st.playlistIndex]?.path) });
  },
  setPlaylistIndex: (playlistIndex) => set({ playlistIndex }),
  setError: (error) => set({ error }),
}));

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 400);
}

/**
 * Save now. Needed before requesting media the server only serves once the
 * manifest references it (e.g. an audio file picked outside the workspace).
 */
export async function flushSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const s = useStore.getState().session;
  if (!s) return;
  useStore.setState({ saving: true });
  try {
    await api.putSession(s);
    useStore.setState({ lastSaved: Date.now() });
  } catch (e) {
    useStore.setState({ error: `Save failed: ${(e as Error).message}` });
    throw e;
  } finally {
    useStore.setState({ saving: false });
  }
}

const needsPoll = (c: Clip) =>
  c.proxy_status === 'pending' || c.proxy_status === 'slicing' || c.proxy_status == null ||
  // Preview transcode and colour analysis finish after the slice ("unknown" = analysis failed).
  (c.proxy_status === 'ready' && (!c.preview_path || !c.color_tag));

/** Merge slicer results (proxy, keyframe offset, preview, thumbnail) into the session. */
function schedulePoll() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const s = useStore.getState().session;
    if (!s || !s.clips.some(needsPoll)) return;
    try {
      // Status is keyed off the saved manifest; a clip logged moments ago shows up once the
      // debounced save (400ms) lands, i.e. by the next poll.
      const status = await api.clipStatus();
      const current = useStore.getState().session;
      if (!current) return;
      let changed = false;
      const clips = current.clips.map((c) => {
        const st = status[c.clip_id];
        if (!st) return c;
        const merged = { ...c, ...st, thumb_path: c.thumb_path ?? st.thumb_path };
        if (JSON.stringify(merged) === JSON.stringify(c)) return c;
        changed = true;
        return merged;
      });
      if (changed) useStore.setState({ session: { ...current, clips } });
    } catch {
      /* backend restarting; try again */
    }
    schedulePoll();
  }, 700);
}

const DUPE_POLL_MS = 800;

/** Scan `files` for duplicates and apply the result if they're still the open folder. */
async function scanDuplicates(files: FileEntry[]): Promise<void> {
  const paths = files.map((f) => f.path);
  const stillCurrent = () => useStore.getState().folderFiles === files;
  const wait = () => new Promise((r) => setTimeout(r, DUPE_POLL_MS));
  try {
    // A scan for a previous folder may still be running: wait for it, then start ours.
    // (The 409 retry covers the small race where another scan starts in between.)
    for (;;) {
      if ((await api.dupeStatus()).state === 'running') {
        await wait();
        if (!stillCurrent()) return;
        continue;
      }
      try {
        await api.startDupeScan(paths);
        break;
      } catch (e) {
        if (!(e as Error).message.includes('already running')) throw e;
      }
    }
    for (;;) {
      await wait();
      if (!stillCurrent()) return;
      const st = await api.dupeStatus();
      if (st.state === 'running') {
        useStore.setState({ dupeScan: `Checking for duplicates ${st.done}/${st.total}…` });
        continue;
      }
      if (st.state === 'error') throw new Error(st.error ?? 'scan failed');
      const duplicateOf: Record<string, string> = {};
      for (const [keep, ...dups] of st.groups ?? []) for (const d of dups) duplicateOf[d] = keep;
      const cur = useStore.getState();
      useStore.setState({
        duplicateOf,
        dupeScan: null,
        ...visible({ ...cur, folderFiles: files, duplicateOf }, cur.playlist[cur.playlistIndex]?.path),
      });
      return;
    }
  } catch (e) {
    useStore.setState({ dupeScan: null, error: `Duplicate check failed: ${(e as Error).message}` });
  }
}

/**
 * Remove a clip from the pool and from every Beat Card using it. Its cached proxy files
 * are kept on purpose so Ctrl+Z restores a fully working clip.
 */
export function removeClip(clipId: string): void {
  useStore.getState().update(
    (s) => ({
      ...s,
      clips: s.clips.filter((c) => c.clip_id !== clipId),
      sequence: {
        ...s.sequence,
        slots: s.sequence.slots.map((sl) => ({ ...sl, cells: sl.cells.filter((c) => c.clip_id !== clipId) })),
      },
    }),
    true,
  );
}

function maxClipNumber(session: Session): number {
  return session.clips.reduce((m, c) => Math.max(m, Number(/(\d+)$/.exec(c.clip_id)?.[1] ?? 0)), 0);
}

/** Ids are never reused (see Session.clip_seq), so a deleted clip's cached slices stay its own. */
/**
 * Switch projects: save the current one, let the server switch, then start the UI fresh
 * (session, logger playlist, undo history all belong to the old project).
 */
export async function switchProject(run: () => Promise<unknown>): Promise<void> {
  await flushSave();
  await run();
  useStore.setState({
    session: null, folderFiles: [], duplicateOf: {}, playlist: [], playlistIndex: 0, dupeScan: null,
    undoStack: [], redoStack: [], lastSaved: null,
  });
  await useStore.getState().load();
}

export function nextClipId(session: Session): string {
  return `c_${String(Math.max(maxClipNumber(session), session.clip_seq ?? 0) + 1).padStart(3, '0')}`;
}
