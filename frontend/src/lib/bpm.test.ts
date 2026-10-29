import { describe, expect, it } from 'vitest';
import { estimateTempo, onsetEnvelope, strongestOnsetNear, tapTempo } from './bpm';

function kickTrack(bpm: number, offset: number, seconds: number, sr = 22050): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const beat = 60 / bpm;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (t < offset) continue;
    const ph = (t - offset) % beat;
    const half = (t - offset + beat / 2) % beat;
    out[i] =
      0.9 * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-30 * ph)) * ph) * Math.exp(-9 * ph) +
      0.2 * noise() * Math.exp(-60 * half);
  }
  return out;
}

describe('tempo estimation', () => {
  for (const bpm of [100, 128, 135, 150, 174]) {
    it(`finds ${bpm} BPM and the beat phase`, () => {
      const sr = 22050;
      const est = estimateTempo(kickTrack(bpm, 0.37, 20, sr), sr);
      // 174 is commonly folded to half-time (87); either is a valid grid.
      const folded = Math.abs(est.bpm - bpm) < Math.abs(est.bpm * 2 - bpm) ? est.bpm : est.bpm * 2;
      expect(folded).toBeGreaterThan(bpm - 0.6);
      expect(folded).toBeLessThan(bpm + 0.6);
      const beat = 60 / bpm;
      const phaseErr = Math.abs(((est.firstBeatSec - 0.37) % beat + beat) % beat);
      expect(Math.min(phaseErr, beat - phaseErr)).toBeLessThan(0.025);
    });
  }

  it('snaps to the nearest kick', () => {
    const sr = 22050;
    const env = onsetEnvelope(kickTrack(128, 0.5, 6, sr), sr);
    const kick = 0.5 + 4 * (60 / 128);
    expect(Math.abs(strongestOnsetNear(env, kick + 0.08, 0.15) - kick)).toBeLessThan(0.015);
  });

  it('computes tap tempo from the median interval', () => {
    expect(tapTempo([0, 500, 1000, 1500, 2100])).toBe(120);
    expect(tapTempo([0, 500])).toBeNull();
  });
});
