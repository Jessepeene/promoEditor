import { describe, expect, it } from 'vitest';
import { estimateTempo, findDrop, onsetEnvelope, strongestOnsetNear, tapTempo } from './bpm';

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

/** Quiet intro (kick + hats), a bass-less build, then a full drop with bass at `dropBeat`. */
function songWithDrop(bpm: number, offset: number, dropBeat: number, beats: number, sr = 11025): Float32Array {
  const beat = 60 / bpm;
  const out = new Float32Array(Math.floor((offset + beats * beat) * sr));
  let seed = 3;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (t < offset) continue;
    const b = (t - offset) / beat;
    const ph = (t - offset) % beat;
    const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-30 * ph)) * ph) * Math.exp(-9 * ph);
    const hat = 0.25 * noise() * Math.exp(-60 * ((t - offset + beat / 2) % beat));
    const bass = 0.5 * Math.sin(2 * Math.PI * 55 * t) * (1 - Math.exp(-20 * ph));
    out[i] = b < dropBeat - 8 ? 0.5 * kick + hat : b < dropBeat ? 0.3 * kick + 0.2 * noise() * Math.exp(-35 * (ph % (beat / 4))) : kick + hat + bass;
  }
  return out;
}

describe('drop detection', () => {
  for (const [bpm, dropBeat] of [[128, 32], [140, 48], [124, 16], [128, 33], [150, 30]] as const) {
    it(`finds the drop at beat ${dropBeat} (${bpm} BPM)`, () => {
      const sr = 11025;
      const drop = findDrop(songWithDrop(bpm, 0.5, dropBeat, dropBeat + 32, sr), sr, bpm, 0.5);
      expect(drop).not.toBeNull();
      expect(Math.abs(drop! - (0.5 + dropBeat * (60 / bpm)))).toBeLessThan(0.01);
    });
  }

  it('returns null for a clip too short to judge', () => {
    expect(findDrop(new Float32Array(11025 * 3), 11025, 128, 0)).toBeNull();
  });
});
