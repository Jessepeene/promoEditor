// One <video> element + GL texture per visible cell, kept in sync with the promo clock.

import { mediaUrl } from '../lib/api';
import { sourceRate, sourceTime } from '../lib/timing';
import type { Clip } from '../types/session';
import { slotAt, type Plan, type PlannedCell } from './plan';

interface Entry {
  video: HTMLVideoElement;
  tex: WebGLTexture;
  url: string;
  width: number;
  height: number;
  hasFrame: boolean;
  lastUploadTime: number;
  lastUsed: number;
}

const PREWARM_SEC = 1.0;
const DRIFT_SEC = 0.12;
const IDLE_EVICT_MS = 3000;
const MAX_ENTRIES = 48;

/**
 * Where to read a clip from and how source time maps onto that file.
 * Preview/proxy files start at `proxy_start_sec`; before slicing finishes we
 * fall back to the raw source, whose timeline is source time itself.
 */
function clipMedia(clip: Clip): { url: string; base: number } {
  const file = clip.preview_path ?? clip.proxy_path;
  if (clip.proxy_start_sec != null && file) {
    // proxy_start_sec doubles as a cache-buster: a re-slice rewrites the same path.
    return { url: mediaUrl(file, clip.proxy_start_sec), base: clip.proxy_start_sec };
  }
  return { url: mediaUrl(clip.source_path), base: 0 };
}

export class VideoPool {
  private entries = new Map<string, Entry>();
  /** Visible cells still waiting for their first decoded frame or a seek. */
  waiting = 0;

  constructor(private gl: WebGL2RenderingContext) {}

  get size() {
    return this.entries.size;
  }

  sync(plan: Plan, visible: PlannedCell[], frame: number, fps: number, playing: boolean) {
    const now = performance.now();
    this.waiting = 0;
    for (const pc of visible) {
      const e = this.ensure(pc, now);
      this.drive(e, pc, frame, fps, playing, true);
      this.upload(e, playing);
      if (!e.hasFrame || e.video.seeking) this.waiting++;
    }
    if (playing) {
      for (const pc of upcoming(plan, frame, fps)) this.drive(this.ensure(pc, now), pc, pc.timing.startFrame, fps, false, false);
    }
    this.evict(now);
  }

  texture(key: string): Entry | null {
    const e = this.entries.get(key);
    return e && e.hasFrame ? e : null;
  }

  private ensure(pc: PlannedCell, now: number): Entry {
    const { url } = clipMedia(pc.clip);
    let e = this.entries.get(pc.key);
    if (e && e.url !== url) {
      // A reroll or reslice put a different file behind this cell.
      e.video.src = url;
      e.url = url;
      e.hasFrame = false;
    }
    if (!e) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = url;
      const tex = this.gl.createTexture();
      if (!tex) throw new Error('Failed to allocate a WebGL texture');
      e = { video, tex, url, width: 0, height: 0, hasFrame: false, lastUploadTime: -1, lastUsed: now };
      this.entries.set(pc.key, e);
    }
    e.lastUsed = now;
    return e;
  }

  private drive(e: Entry, pc: PlannedCell, frame: number, fps: number, playing: boolean, active: boolean) {
    const v = e.video;
    if (v.readyState < 1) return; // no metadata yet; currentTime writes would be dropped
    const local = frame - pc.timing.startFrame;
    const src = sourceTime(pc.timing, local, fps);
    const target = Math.max(0, src - clipMedia(pc.clip).base);
    // Clamped to the logged window = freeze frame; a running video would fight the drift check.
    const frozen = src <= pc.timing.lo || src >= pc.timing.hi;
    if (active && playing && !frozen) {
      const rate = Math.min(16, Math.max(0.0625, sourceRate(pc.timing, local)));
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
      if (!v.seeking && Math.abs(v.currentTime - target) > DRIFT_SEC) v.currentTime = target;
      if (v.paused) {
        v.play().catch((err: DOMException) => {
          // A pause()/src change racing play() rejects with AbortError; anything else is real.
          if (err.name !== 'AbortError') console.warn('preview playback failed', pc.clip.clip_id, err);
        });
      }
    } else {
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - target) > 0.5 / fps) v.currentTime = target;
    }
  }

  private upload(e: Entry, playing: boolean) {
    const v = e.video;
    if (v.readyState < 2) return; // HAVE_CURRENT_DATA
    if (!playing && e.hasFrame && v.currentTime === e.lastUploadTime) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    if (!e.hasFrame) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    e.width = v.videoWidth;
    e.height = v.videoHeight;
    e.hasFrame = true;
    e.lastUploadTime = v.currentTime;
  }

  private evict(now: number) {
    const idle = [...this.entries].filter(([, e]) => now - e.lastUsed > IDLE_EVICT_MS);
    const over = Math.max(0, this.entries.size - MAX_ENTRIES);
    const lru = [...this.entries].filter(([, e]) => e.lastUsed < now).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of [...idle, ...lru.slice(0, over)]) {
      if (!this.entries.has(key)) continue;
      this.destroy(e);
      this.entries.delete(key);
    }
  }

  private destroy(e: Entry) {
    e.video.pause();
    // Dropping src and calling load() releases the decoder immediately.
    e.video.removeAttribute('src');
    e.video.load();
    this.gl.deleteTexture(e.tex);
  }

  dispose() {
    for (const e of this.entries.values()) this.destroy(e);
    this.entries.clear();
  }
}

/** Cells that start within the prewarm window after `frame`. */
function upcoming(plan: Plan, frame: number, fps: number): PlannedCell[] {
  const horizon = frame + PREWARM_SEC * fps;
  const out: PlannedCell[] = [];
  const cur = slotAt(plan, Math.floor(frame));
  let i = cur ? cur.index : plan.slots.findIndex((s) => s.startFrame > frame);
  if (i < 0) return out;
  for (; i < plan.slots.length && plan.slots[i].startFrame <= horizon; i++) {
    for (const pc of plan.slots[i].cells) {
      if (pc.timing.startFrame > frame && pc.timing.startFrame <= horizon) out.push(pc);
    }
  }
  return out;
}
