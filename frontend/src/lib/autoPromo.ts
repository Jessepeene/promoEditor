// Auto promo: turn "song + clips + length + type" into a ready-to-roll sequence.
// planPromo is the pure part (tested); runAutoPromo orchestrates the app around it.

import type { InfoRow, LayoutType, Sequence, Style, TextConfig, TextStyle, Zone } from '../types/session';
import { api, mediaUrl } from './api';
import { estimateTempo, findDrop, mixToMono } from './bpm';
import { renderGraphicsTrack } from './graphicsLayer';
import { harvestClips } from './harvest';
import { LAYOUT_PRESETS, solve } from './solver';
import { flushSave, switchProject, useStore } from './store';

export type VideoTypeId = 'RAVE_COLLAGE' | 'CAR_VELOCITY' | 'DANCER_STORY' | 'TEASER';

export interface VideoType {
  id: VideoTypeId;
  label: string;
  hint: string;
  /** Beats wanted before the drop, as [intro, build, breather]; trimmed if the song can't fit them. */
  pre: { intro: number | 'third'; build: number; breather: number };
  layouts: Record<LayoutType, number>;
  fx_intensity: number;
  vhs_glitch: boolean;
  text_style: TextStyle | 'AUTO';
}

const preset = (id: string) => (LAYOUT_PRESETS.find((p) => p.id === id) ?? LAYOUT_PRESETS[2]).weights;

export const VIDEO_TYPES: VideoType[] = [
  {
    id: 'RAVE_COLLAGE', label: 'Rave collage', hint: 'Grids and split screens, VHS glitch, mono type',
    pre: { intro: 0, build: 4, breather: 4 }, layouts: preset('COLLAGE'), fx_intensity: 1.5, vhs_glitch: true, text_style: 'RAVE_MONO',
  },
  {
    id: 'CAR_VELOCITY', label: 'Car / velocity', hint: 'Fullscreen speed-ramped hits, chrome type',
    pre: { intro: 8, build: 4, breather: 4 }, layouts: preset('VELOCITY'), fx_intensity: 1, vhs_glitch: false, text_style: 'CHROME_Y2K',
  },
  {
    id: 'DANCER_STORY', label: 'Story / dancer', hint: 'Slow story intro with the title, then a hybrid drop',
    pre: { intro: 'third', build: 0, breather: 4 }, layouts: preset('HYBRID'), fx_intensity: 1, vhs_glitch: false, text_style: 'CLEAN_BOLD',
  },
  {
    id: 'TEASER', label: 'Hook-first teaser', hint: 'Straight into the energy; a new text look every roll',
    pre: { intro: 0, build: 4, breather: 0 }, layouts: preset('HYBRID'), fx_intensity: 1.25, vhs_glitch: false, text_style: 'AUTO',
  },
];

const OUTRO_BEATS = 8;
const MIN_DROP_BEATS = 8;

export interface PromoPlan {
  zones: Zone[];
  drop_beat_index: number;
  beat_1_offset_sec: number;
  total_beats: number;
}

/**
 * Lay out zones for a promo of about `lengthSec`, with the drop at `dropTimeSec` in a song
 * of `songSec`. Lengths snap to whole bars; the intro/build/breather shrink when the drop
 * comes early in the song, and the drop shrinks when the song ends soon after it.
 */
export function planPromo(type: VideoType, lengthSec: number, bpm: number, dropTimeSec: number, songSec: number): PromoPlan {
  const bd = 60 / bpm;
  const bar = (beats: number) => Math.max(0, Math.floor(beats / 4) * 4);
  const total = Math.max(16, Math.round(lengthSec / bd / 4) * 4);
  const outro = total >= 24 ? OUTRO_BEATS : 4;
  const intro = type.pre.intro === 'third' ? bar(total / 3) : type.pre.intro;

  // Shrink the run-up to what the song has before its drop (breather first kept, intro cut first).
  let room = bar(dropTimeSec / bd);
  room = Math.min(room, total - outro - MIN_DROP_BEATS);
  const breather = Math.min(type.pre.breather, room);
  const build = Math.min(type.pre.build, room - breather);
  const introBeats = Math.min(intro, room - breather - build);
  const pre = introBeats + build + breather;

  // The drop runs to the outro, but never past the end of the song.
  const songAfter = bar((songSec - dropTimeSec) / bd);
  const dropBeats = Math.max(MIN_DROP_BEATS, Math.min(total - pre - outro, songAfter - outro));
  const zones: Zone[] = [];
  let t = 0;
  const add = (len: number, type: Zone['type']) => {
    if (len > 0) zones.push({ start_beat: t, end_beat: t + len, type });
    t += len;
  };
  add(introBeats, 'INTRO_STORY');
  add(build, 'STUTTER_BUILD');
  add(breather, 'VOCAL_BREATHER');
  add(dropBeats, 'HYBRID_DROP');
  add(Math.max(0, Math.min(outro, songAfter - dropBeats)), 'OUTRO');
  return { zones, drop_beat_index: pre, beat_1_offset_sec: Math.round((dropTimeSec - pre * bd) * 1000) / 1000, total_beats: t };
}

/** The style / text settings a video type applies on top of the user's own text. */
export function typeSettings(type: VideoType, style: Style, text: TextConfig): Pick<Sequence, 'style' | 'text_config'> {
  return {
    style: { ...style, layout_weights: type.layouts, fx_intensity: type.fx_intensity, vhs_glitch: type.vhs_glitch, bounce: true, rgb_split: true },
    text_config: { ...text, style_preset: type.text_style, title_anim: 'AUTO', hook_anim: 'AUTO', rows_anim: 'AUTO' },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AutoPromoOptions {
  /** Create and open a new project with this name first; null = build in the open project. */
  projectName: string | null;
  folder: string;
  audio: { path: string } | { file: File };
  lengthSec: number;
  typeId: VideoTypeId;
  text: { title: string; hooks: string[]; rows: InfoRow[]; cta: string };
  exportWhenDone: boolean;
}

export type StepReporter = (step: string, detail?: string) => void;

const SLICE_TIMEOUT_MS = 10 * 60 * 1000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve once every clip has finished slicing (or failed) and has its colour tag. */
async function waitForClips(onStep: StepReporter): Promise<void> {
  const deadline = Date.now() + SLICE_TIMEOUT_MS;
  for (;;) {
    const clips = useStore.getState().session?.clips ?? [];
    const done = clips.filter((c) => c.proxy_status === 'error' || (c.proxy_status === 'ready' && c.color_tag));
    onStep('Slicing clips', `${done.length}/${clips.length}`);
    if (done.length === clips.length) return;
    if (Date.now() > deadline) throw new Error('Slicing is taking more than 10 minutes; check the clip list for errors.');
    await wait(800);
  }
}

export async function runAutoPromo(opts: AutoPromoOptions, onStep: StepReporter): Promise<string | null> {
  const type = VIDEO_TYPES.find((t) => t.id === opts.typeId);
  if (!type) throw new Error(`Unknown video type ${opts.typeId}`);
  const store = useStore.getState;

  if (opts.projectName) {
    onStep('Creating project', opts.projectName);
    const name = opts.projectName;
    await switchProject(() => api.createProject(name, false));
  }

  onStep('Opening clips', opts.folder);
  const { files } = await store().openFolder(opts.folder);
  if (files.length === 0) throw new Error(`No video files in ${opts.folder}`);
  onStep('Checking for duplicates');
  await store().setFolderFiles(files);
  const paths = store().folderFiles.map((f) => f.path).filter((p) => !store().duplicateOf[p]);

  onStep('Harvesting moments', `${paths.length} files`);
  const count = Math.min(80, Math.max(20, Math.round(opts.lengthSec * 1.4)));
  const { added } = await harvestClips(paths, count, 4, (done, total) => onStep('Harvesting moments', `${done}/${total} files`));
  if ((store().session?.clips.length ?? 0) === 0) throw new Error('No usable moments found in those files.');
  onStep('Harvesting moments', `${added} clips added`);
  await waitForClips(onStep);

  onStep('Analysing the song');
  const audioPath = 'file' in opts.audio ? (await api.upload([opts.audio.file], 'audio')).files[0].path : opts.audio.path;
  store().update((s) => ({ ...s, sequence: { ...s.sequence, audio_path: audioPath } }));
  await flushSave(); // the server only serves media the saved project references
  const res = await fetch(mediaUrl(audioPath));
  if (!res.ok) throw new Error(`Could not read the song (${res.status})`);
  const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await res.arrayBuffer());
  const mono = mixToMono(buffer);
  const tempo = estimateTempo(mono, buffer.sampleRate);
  let dropTime = findDrop(mono, buffer.sampleRate, tempo.bpm, tempo.firstBeatSec);
  let note = '';
  if (dropTime == null) {
    dropTime = tempo.firstBeatSec + Math.round((buffer.duration * 0.3 - tempo.firstBeatSec) / (60 / tempo.bpm)) * (60 / tempo.bpm);
    note = ' (no clear drop: guessed; drag the waveform to fix)';
  }
  onStep('Analysing the song', `${tempo.bpm} BPM, drop at ${dropTime.toFixed(2)} s${note}`);

  onStep('Building the edit', type.label);
  const plan = planPromo(type, opts.lengthSec, tempo.bpm, dropTime, buffer.duration);
  store().update((s) => {
    const text: TextConfig = {
      ...s.sequence.text_config,
      intro_title: opts.text.title || s.sequence.text_config.intro_title,
      hook_words: opts.text.hooks.length ? opts.text.hooks : s.sequence.text_config.hook_words,
      info_rows: opts.text.rows.length ? opts.text.rows : s.sequence.text_config.info_rows,
      cta: opts.text.cta || s.sequence.text_config.cta,
    };
    const seq: Sequence = {
      ...s.sequence,
      ...typeSettings(type, s.sequence.style, text),
      bpm: tempo.bpm,
      beat_1_offset_sec: plan.beat_1_offset_sec,
      drop_beat_index: plan.drop_beat_index,
      zones: plan.zones,
      slots: [],
      seed: Math.floor(Math.random() * 1e6),
    };
    const next = { ...s, sequence: seq };
    return { ...next, sequence: { ...seq, slots: solve(next) } };
  }, true);
  store().setView('generator');
  await flushSave();

  if (!opts.exportWhenDone) {
    onStep('Done', 'press Space to preview, R to reroll');
    return null;
  }
  onStep('Exporting', 'rendering text & logos');
  const session = store().session;
  if (!session) throw new Error('No session to export');
  const track = await renderGraphicsTrack(session);
  const trackId = track ? (await api.uploadTextTrack(track.manifest, track.files)).text_track_id : null;
  await api.startExport(session, trackId);
  for (;;) {
    await wait(1000);
    const st = await api.exportStatus();
    if (st.state === 'error') throw new Error(st.error ?? 'export failed');
    if (st.state === 'done' && st.output) {
      onStep('Done', st.output);
      return st.output;
    }
    onStep('Exporting', st.message ?? st.state);
  }
}
