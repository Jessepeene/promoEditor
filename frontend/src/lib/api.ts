import type { Clip, Session } from '../types/session';

export interface FileEntry {
  name: string;
  path: string;
  size: number;
}

export interface WaveformData {
  duration: number;
  peaks_per_sec: number;
  peaks: number[];
  rms: number[];
}

export interface ExportStatus {
  state: 'idle' | 'planning' | 'rendering' | 'finalizing' | 'done' | 'error' | 'cancelled';
  progress?: number;
  message?: string;
  output?: string | null;
  error?: string | null;
  segments?: number;
  segments_done?: number;
}

export type GlanceStatus =
  | { status: 'pending' }
  | { status: 'error'; error: string }
  | { status: 'ready'; glance_path: string; start_sec: number; length_sec: number; source_duration_sec: number };

export interface HarvestClip {
  source_path: string;
  mode: 'ANCHOR' | 'RANGE';
  energy_tag: number;
  anchor_sec: number | null;
  in_sec: number;
  out_sec: number;
}

export interface HarvestStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  done?: number;
  total?: number;
  skipped?: number;
  clips?: HarvestClip[] | null;
  error?: string | null;
}

export interface BrollStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  done?: number;
  total?: number;
  /** Project-relative folder with the clips, the reel and index.txt. */
  folder?: string | null;
  reel?: string | null;
  error?: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  clips: number;
  updated: string | null;
}

export interface ProjectList {
  current: string;
  projects: ProjectInfo[];
}

export interface DupeStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  done?: number;
  total?: number;
  /** Groups of duplicate file paths; the first of each group is the one to keep. */
  groups?: string[][] | null;
  error?: string | null;
}

export interface TextSpan {
  file: string;
  start: number;
  end: number;
}

/** Mirrors backend TextTrack: the browser-rendered text layer sent for export. */
export interface TextTrackManifest {
  fps: number;
  width: number;
  height: number;
  total_frames: number;
  spans: TextSpan[];
}

export type ClipStatusMap = Record<string, Partial<Clip>>;

export const mediaUrl = (path: string, version?: string | number | null) =>
  `/media?path=${encodeURIComponent(path)}${version != null ? `&v=${encodeURIComponent(String(version))}` : ''}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: () => fetch('/api/health').then(json<{ workspace: string; ffmpeg: string; encoder: string }>),
  getSession: () => fetch('/api/session').then(json<Session>),
  projects: () => fetch('/api/projects').then(json<ProjectList>),
  createProject: (name: string, copyCurrent: boolean) =>
    fetch('/api/projects', send('POST', { name, copy_current: copyCurrent })).then(json<ProjectList>),
  openProject: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}/open`, { method: 'POST' }).then(json<ProjectList>),
  putSession: (s: Session) => fetch('/api/session', send('PUT', s)).then(json<Session>),
  openFolder: (path: string) =>
    fetch('/api/folders', send('POST', { path })).then(json<{ folder: string; files: FileEntry[] }>),
  pick: (kind: 'folder' | 'audio' | 'image') =>
    fetch(`/api/pick?kind=${kind}`, { method: 'POST' }).then(json<{ path: string | null }>),
  upload: async (files: File[], kind: 'raw' | 'audio' | 'assets') => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    return fetch(`/api/upload?kind=${kind}`, { method: 'POST', body: form }).then(json<{ files: FileEntry[] }>);
  },
  slice: (clip: Clip) => fetch('/api/slice', send('POST', clip)).then(json<{ clip_id: string }>),
  clipStatus: () => fetch('/api/clips/status').then(json<ClipStatusMap>),
  uploadThumb: (clipId: string, blob: Blob) =>
    fetch(`/api/clips/${clipId}/thumb`, { method: 'POST', body: blob }).then(json<{ thumb_path: string }>),
  waveform: (path: string) => fetch(`/api/waveform?path=${encodeURIComponent(path)}`).then(json<WaveformData>),
  startExport: (session: Session, textTrackId: string | null) =>
    fetch('/api/export', send('POST', { session, text_track_id: textTrackId })).then(json<ExportStatus>),
  uploadTextTrack: (manifest: TextTrackManifest, files: File[]) => {
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    for (const f of files) form.append('files', f, f.name);
    return fetch('/api/text-track', { method: 'POST', body: form }).then(json<{ text_track_id: string }>);
  },
  glance: (paths: string[]) => fetch('/api/glance', send('POST', { paths })).then(json<Record<string, GlanceStatus>>),
  startHarvest: (paths: string[], count: number, breathers: number) =>
    fetch('/api/auto-harvest', send('POST', { paths, count, breathers })).then(json<HarvestStatus>),
  harvestStatus: () => fetch('/api/auto-harvest').then(json<HarvestStatus>),
  startBrollPack: () => fetch('/api/broll-pack', { method: 'POST' }).then(json<BrollStatus>),
  brollStatus: () => fetch('/api/broll-pack').then(json<BrollStatus>),
  startDupeScan: (paths: string[]) => fetch('/api/dupes', send('POST', { paths })).then(json<DupeStatus>),
  dupeStatus: () => fetch('/api/dupes').then(json<DupeStatus>),
  exportStatus: () => fetch('/api/export').then(json<ExportStatus>),
  cancelExport: () => fetch('/api/export/cancel', { method: 'POST' }).then(json<ExportStatus>),
};
