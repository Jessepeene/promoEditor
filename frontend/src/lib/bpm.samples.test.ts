// Regression: tempo + drop on the generated sample track (scripts/make_samples.py) must not
// depend on the decode sample rate. Skipped when the samples haven't been generated.
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { estimateTempo, findDrop } from './bpm';

function readWav(path: string): { data: Float32Array; rate: number } {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  let off = 12;
  while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const len = b.readUInt32LE(off + 4) / 2 / channels;
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) data[i] = b.readInt16LE(off + 8 + i * 2 * channels) / 32768;
  return { data, rate };
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to;
    const j = Math.floor(p);
    out[i] = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * (p - j);
  }
  return out;
}

const TRACK = '../samples/audio/track_128bpm.wav';

it.skipIf(!existsSync(TRACK))('finds 128 BPM and the drop at 15.5 s at 44.1 and 48 kHz', () => {
  const { data, rate } = readWav(TRACK);
  for (const sr of [rate, 48000]) {
    const x = sr === rate ? data : resample(data, rate, sr);
    const t = estimateTempo(x, sr);
    expect(t.bpm, `${sr} Hz`).toBeCloseTo(128, 1);
    expect(findDrop(x, sr, t.bpm, t.firstBeatSec)!, `${sr} Hz`).toBeCloseTo(15.5, 2);
  }
});
