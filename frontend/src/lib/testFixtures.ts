// Shared test fixture: a complete, valid Session with sensible defaults.
import type { Sequence, Session, Style, TextConfig } from '../types/session';

export const TEST_TEXT: TextConfig = {
  style_preset: 'CLEAN_BOLD', accent: 'AUTO', intro_title: '', hook_words: [], info_rows: [], cta: '',
  title_anim: 'POP', hook_anim: 'SLAM', rows_anim: 'POP',
};

export const TEST_STYLE: Style = {
  bounce: true, rgb_split: true, vhs_glitch: false, logos: [], source_cooldown: 4, fx_intensity: 1,
  layout_weights: { FULLSCREEN_VELOCITY: 0.4, STACK_3_ROW: 0.25, CENTER_PIP_PUNCH: 0.2, STROBE_MATRIX: 0.15, SPLIT_2: 0 },
};

export function makeSession(over: Partial<Session> = {}, seq: Partial<Sequence> = {}): Session {
  return {
    project_id: 'p', target_aspect: '9:16', resolution: [1080, 1920], fps: 60, clips: [], source_folders: [],
    ...over,
    sequence: {
      bpm: 128, beat_1_offset_sec: 0, drop_beat_index: 16, zones: [], slots: [], seed: 1,
      style: TEST_STYLE, text_config: TEST_TEXT,
      ...seq,
    },
  };
}
