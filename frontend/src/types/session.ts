// Shared `session.promo.json` contract. Mirrors backend/promo_server/models.py.

export type ClipMode = 'ANCHOR' | 'RANGE';
export type ZoneType = 'INTRO_STORY' | 'STUTTER_BUILD' | 'VOCAL_BREATHER' | 'HYBRID_DROP' | 'OUTRO';
export type LayoutType = 'FULLSCREEN_VELOCITY' | 'STACK_3_ROW' | 'CENTER_PIP_PUNCH' | 'STROBE_MATRIX' | 'SPLIT_2';
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
  /** 0 breather (always RANGE); 1 vibe, 2 groove, 3 hype, 4 peak (ANCHOR) */
  energy_tag: number;
  focus_xy: [number, number];
  /** Dominant look at the anchor: dark_ambient | neutral | red | orange | … | 'unknown'. */
  color_tag?: string | null;
  color_rgb?: [number, number, number] | null;
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
  push: 'NONE' | 'IN' | 'OUT';
  shake: boolean;
  invert: boolean;
  strobe: boolean;
  mirror: boolean;
  echo: boolean;
  dim: boolean;
}

export interface LayoutParams {
  matrix: MatrixKind;
  pip_aspect: '1:1' | '4:3';
  pip_background: 'FULLSCREEN' | 'STACK';
  split: 'ROWS' | 'COLS';
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

export type LogoPlacement = 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'CENTER' | 'LOWER_THIRD' | 'CUSTOM';
export type LogoWhen = 'ALWAYS' | 'INTRO' | 'DROP' | 'OUTRO';
export type LogoMotion = 'STATIC' | 'PULSE' | 'JITTER' | 'FADE';

export interface Logo {
  path: string;
  placement: LogoPlacement;
  /** Centre as canvas fractions when dragged into place (placement CUSTOM). */
  x?: number | null;
  y?: number | null;
  /** Logo width as a fraction of the canvas width. */
  width_frac: number;
  when: LogoWhen;
  motion: LogoMotion;
}

export interface Style {
  bounce: boolean;
  rgb_split: boolean;
  vhs_glitch: boolean;
  layout_weights: Record<LayoutType, number>;
  logos: Logo[];
  /** Minimum number of cards between two clips from the same source file. */
  source_cooldown: number;
  /** How often the solver uses the optional effects: 0 none, 1 default, 2 wild. */
  fx_intensity: number;
}

export type TextStyle = 'RAVE_MONO' | 'CHROME_Y2K' | 'CLEAN_BOLD' | 'OUTLINE_STACK' | 'TAPE_LABEL' | 'NEON' | 'GRADIENT_POP' | 'MINIMAL';
export type TextAnim = 'AUTO' | 'POP' | 'TYPEWRITER' | 'WORDS' | 'SLIDE' | 'SLAM' | 'GLITCH' | 'FLICKER' | 'ZOOM' | 'LETTERS';

export interface InfoRow {
  left: string;
  right: string;
}

export interface TextConfig {
  /** AUTO picks a style per roll. */
  style_preset: TextStyle | 'AUTO';
  /** Accent colour for tape / neon / gradient styles: '#rrggbb' or AUTO (per roll). */
  accent: string;
  intro_title: string;
  hook_words: string[];
  info_rows: InfoRow[];
  /** End-card call to action, e.g. "TICKETS · LINK IN BIO". */
  cta: string;
  title_anim: TextAnim;
  hook_anim: TextAnim;
  rows_anim: TextAnim;
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
  text_config: TextConfig;
}

export interface Session {
  project_id: string;
  target_aspect: string;
  resolution: [number, number];
  fps: number;
  clips: Clip[];
  sequence: Sequence;
  source_folders: string[];
  /** Highest clip number ever issued (ids are never reused). Missing in older sessions. */
  clip_seq?: number;
}

export const LAYOUTS: LayoutType[] = ['FULLSCREEN_VELOCITY', 'STACK_3_ROW', 'CENTER_PIP_PUNCH', 'STROBE_MATRIX', 'SPLIT_2'];

export const DEFAULT_FX: SlotFx = {
  bounce: false,
  rgb_split: false,
  glitch: false,
  speed_ramp: true,
  speed: 1,
  transition: 'CUT',
  push: 'NONE',
  shake: false,
  invert: false,
  strobe: false,
  mirror: false,
  echo: false,
  dim: false,
};

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  matrix: '3x3',
  pip_aspect: '1:1',
  pip_background: 'FULLSCREEN',
  split: 'ROWS',
};
