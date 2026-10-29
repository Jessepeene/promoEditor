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
  deleteClipCache: (clipId: string) => fetch(`/api/clips/${clipId}/cache`, { method: 'DELETE' }).then(json),
  waveform: (path: string) => fetch(`/api/waveform?path=${encodeURIComponent(path)}`).then(json<WaveformData>),
  startExport: (s: Session) => fetch('/api/export', send('POST', s)).then(json<ExportStatus>),
  exportStatus: () => fetch('/api/export').then(json<ExportStatus>),
  cancelExport: () => fetch('/api/export/cancel', { method: 'POST' }).then(json<ExportStatus>),
};
