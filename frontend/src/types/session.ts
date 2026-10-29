// Shared `session.promo.json` contract. Mirrors backend/promo_server/models.py.

export type ClipMode = 'ANCHOR' | 'RANGE';
export type ZoneType = 'INTRO_STORY' | 'STUTTER_BUILD' | 'VOCAL_BREATHER' | 'HYBRID_DROP';
export type LayoutType = 'FULLSCREEN_VELOCITY' | 'STACK_3_ROW' | 'CENTER_PIP_PUNCH' | 'STROBE_MATRIX';
export type AnchorLock = 'DOWNBEAT' | 'MIDPOINT';
export type Transition = 'CUT' | 'CROSSFADE' | 'FLASH';
export type ProxyStatus = 'pending' | 'slicing' | 'ready' | 'error';
export type MatrixKind = '3x3' | '3x4' | '2x5';

export interface Clip {
  clip_id: string;
  source_path: string;
  proxy_path?: string | null;
  mode: ClipMode;
  in_sec: number;
  anchor_sec?: number | null;
  out_sec: number;
  /** 1 vibe, 2 groove, 3 peak, 4 continuous/breather (RANGE) */
  energy_tag: number;
  focus_xy: [number, number];
  /** Source time of the proxy's first frame (stream copy snaps to a keyframe). */
  proxy_start_sec?: number | null;
  proxy_status?: ProxyStatus;
  proxy_error?: string | null;
  /** Low-res short-GOP transcode on the proxy's timeline. */
  preview_path?: string | null;
  thumb_path?: string | null;
  source_duration_sec?: number | null;
}

export interface Zone {
  start_beat: number;
  end_beat: number;
  type: ZoneType;
}

export interface Cell {
  /** full | row0..row2 | pip | m0..m11 */
  region: string;
  clip_id: string;
  /** Beats relative to slot start. */
  start: number;
  /** null = until slot end */
  end?: number | null;
  slip_frames: number;
  anchor_lock: AnchorLock;
}

export interface SlotFx {
  bounce: boolean;
  rgb_split: boolean;
  glitch: boolean;
  speed_ramp: boolean;
  speed: number;
  transition: Transition;
}

export interface LayoutParams {
  matrix: MatrixKind;
  pip_aspect: '1:1' | '4:3';
  pip_background: 'FULLSCREEN' | 'STACK';
}

export interface Slot {
  slot_id: string;
  start_beat: number;
  duration_beats: number;
  zone_type: ZoneType;
  layout: LayoutType;
  layout_params: LayoutParams;
  locked: boolean;
  cells: Cell[];
  fx: SlotFx;
}

export interface Overlay {
  path?: string | null;
  motion: 'STATIC' | 'JITTER';
  width_frac: number;
}

export interface Style {
  bounce: boolean;
  rgb_split: boolean;
  vhs_glitch: boolean;
  layout_weights: Record<LayoutType, number>;
  overlay: Overlay;
}

export interface Sequence {
  audio_path?: string | null;
  bpm: number;
  beat_1_offset_sec: number;
  drop_beat_index: number;
  zones: Zone[];
  slots: Slot[];
  seed: number;
  style: Style;
}

export interface Session {
  project_id: string;
  target_aspect: string;
  resolution: [number, number];
  fps: number;
  clips: Clip[];
  sequence: Sequence;
  source_folders: string[];
}

export const LAYOUTS: LayoutType[] = ['FULLSCREEN_VELOCITY', 'STACK_3_ROW', 'CENTER_PIP_PUNCH', 'STROBE_MATRIX'];

export const DEFAULT_FX: SlotFx = {
  bounce: false,
  rgb_split: false,
  glitch: false,
  speed_ramp: true,
  speed: 1,
  transition: 'CUT',
};

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  matrix: '3x3',
  pip_aspect: '1:1',
  pip_background: 'FULLSCREEN',
};
