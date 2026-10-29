import { create } from 'zustand';
import type { Clip, Session } from '../types/session';
import { api, type FileEntry } from './api';

export type View = 'logger' | 'generator';

interface State {
  session: Session | null;
  error: string | null;
  saving: boolean;
  view: View;
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
  setPlaylist: (files: FileEntry[], index?: number) => void;
  setPlaylistIndex: (i: number) => void;
  setError: (e: string | null) => void;
}

const UNDO_LIMIT = 60;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<State>((set, get) => ({
  session: null,
  error: null,
  saving: false,
  view: 'logger',
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
        set({ playlist: files, playlistIndex: 0 });
      }
      schedulePoll();
    } catch (e) {
      set({ error: `Backend unreachable: ${(e as Error).message}` });
    }
  },

  update: (fn, undoable = false) => {
    const prev = get().session;
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
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
  setPlaylist: (playlist, index = 0) => set({ playlist, playlistIndex: index }),
  setPlaylistIndex: (playlistIndex) => set({ playlistIndex }),
  setError: (error) => set({ error }),
}));

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const s = useStore.getState().session;
    if (!s) return;
    useStore.setState({ saving: true });
    try {
      await api.putSession(s);
    } catch (e) {
      useStore.setState({ error: `Save failed: ${(e as Error).message}` });
    } finally {
      useStore.setState({ saving: false });
    }
  }, 400);
}

const needsPoll = (c: Clip) =>
  c.proxy_status === 'pending' || c.proxy_status === 'slicing' || c.proxy_status == null ||
  (c.proxy_status === 'ready' && !c.preview_path);

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

export function nextClipId(session: Session): string {
  const max = session.clips.reduce((m, c) => Math.max(m, Number(/(\d+)$/.exec(c.clip_id)?.[1] ?? 0)), 0);
  return `c_${String(max + 1).padStart(3, '0')}`;
}
