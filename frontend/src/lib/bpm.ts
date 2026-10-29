// Tempo + onset analysis on decoded PCM (Web Audio AudioBuffer channel data).

export const ENV_RATE = 200; // onset-envelope samples per second

/**
 * Half-wave-rectified log-energy flux, with a low band (kick) weighted in.
 * Returns one value per 1/ENV_RATE seconds.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / ENV_RATE));
  const n = Math.floor(samples.length / hop);
  const env = new Float32Array(n);
  // One-pole low-pass (~150 Hz) isolates kicks; full band catches snares/hats.
  const a = Math.exp((-2 * Math.PI * 150) / sampleRate);
  let lp = 0;
  let prevFull = 0;
  let prevLow = 0;
  for (let i = 0; i < n; i++) {
    let full = 0;
    let low = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      const x = samples[j];
      lp = a * lp + (1 - a) * x;
      full += x * x;
      low += lp * lp;
    }
    const lf = Math.log1p(1000 * (full / hop));
    const ll = Math.log1p(1000 * (low / hop));
    env[i] = Math.max(lf - prevFull, 0) + 2 * Math.max(ll - prevLow, 0);
    prevFull = lf;
    prevLow = ll;
  }
  return env;
}

export interface TempoEstimate {
  bpm: number;
  /** Time of a beat (seconds) — the phase of the grid. */
  firstBeatSec: number;
  confidence: number;
}

export function estimateTempo(samples: Float32Array, sampleRate: number, minBpm = 70, maxBpm = 180): TempoEstimate {
  const env = onsetEnvelope(samples, sampleRate);
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(env.length, 1);
  const centered = env.map((v) => v - mean);
  const minLag = Math.floor((60 / maxBpm) * ENV_RATE);
  const maxLag = Math.ceil((60 / minBpm) * ENV_RATE);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i++) sum += centered[i] * centered[i + lag];
    ac[lag] = sum / (centered.length - lag);
  }
  // Score each lag with its multiples (beat, 2 beats, bar) and a mild prior around 125 BPM.
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * ENV_RATE) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.6) ** 2);
    let score = ac[lag];
    for (const k of [2, 4]) {
      const l = lag * k;
      if (l < centered.length / 2) {
        let s = 0;
        for (let i = 0; i + l < centered.length; i++) s += centered[i] * centered[i + l];
        score += (0.5 * s) / (centered.length - l);
      }
    }
    score *= prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement around the peak for sub-sample tempo precision.
  const y0 = ac[best - 1];
  const y1 = ac[best];
  const y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const coarse = (60 * ENV_RATE) / (best + delta);

  // Joint BPM/phase refinement: the grid whose beat comb collects the most onset
  // energy. A small tempo error drifts the phase across a long track, so both
  // are searched together.
  let bpm = coarse;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let cand = coarse - 0.6; cand <= coarse + 0.6; cand += 0.02) {
    const { phase, sum } = bestCombPhase(env, 60 / cand);
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
      bpm = cand;
    }
  }
  const acMax = Math.max(...Array.from(ac.slice(minLag, maxLag + 1)));
  return {
    bpm: Math.round(bpm * 100) / 100,
    firstBeatSec: bestPhase,
    confidence: acMax > 0 ? Math.min(1, y1 / acMax) : 0,
  };
}

function bestCombPhase(env: Float32Array, periodSec: number): { phase: number; sum: number } {
  const steps = 120;
  let phase = 0;
  let best = -Infinity;
  for (let k = 0; k < steps; k++) {
    const p = (k / steps) * periodSec;
    let sum = 0;
    for (let t = p; t * ENV_RATE < env.length - 1; t += periodSec) {
      // Linear interpolation keeps sub-sample phase information.
      const x = t * ENV_RATE;
      const i = Math.floor(x);
      sum += env[i] + (env[i + 1] - env[i]) * (x - i);
    }
    if (sum > best) {
      best = sum;
      phase = p;
    }
  }
  return { phase, sum: best };
}

/** Strongest onset (seconds) within ±window of `t` — used to snap the DROP marker onto the kick. */
export function strongestOnsetNear(env: Float32Array, t: number, window: number): number {
  const a = Math.max(0, Math.floor((t - window) * ENV_RATE));
  const b = Math.min(env.length - 1, Math.ceil((t + window) * ENV_RATE));
  let best = Math.round(t * ENV_RATE);
  let bestV = -Infinity;
  for (let i = a; i <= b; i++) {
    if (env[i] > bestV) {
      bestV = env[i];
      best = i;
    }
  }
  return best / ENV_RATE;
}

export function mixToMono(buffer: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Tap-tempo: BPM from a list of tap timestamps (ms), ignoring stale taps. */
export function tapTempo(tapsMs: number[]): number | null {
  if (tapsMs.length < 3) return null;
  const intervals = tapsMs.slice(1).map((t, i) => t - tapsMs[i]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.round((60000 / median) * 10) / 10;
}
