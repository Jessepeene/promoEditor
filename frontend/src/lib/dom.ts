/** True when a key event should go to a form field instead of a global hotkey. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button'].includes(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** Energy tiers: 0 breather (RANGE clip), 1–4 anchor energy from vibe to peak. */
export const TIERS = [0, 1, 2, 3, 4] as const;

export const TAG_COLORS: Record<number, string> = {
  0: '#a855f7',
  1: '#3b82f6',
  2: '#f59e0b',
  3: '#f97316',
  4: '#ef4444',
};

export const TAG_NAMES: Record<number, string> = {
  0: 'Breather',
  1: 'Vibe',
  2: 'Groove',
  3: 'Hype',
  4: 'Peak',
};

/** Swatch colour for a clip's dominant-look tag. */
export const LOOK_COLORS: Record<string, string> = {
  dark_ambient: '#27272a',
  neutral: '#d4d4d8',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  magenta: '#d946ef',
};
