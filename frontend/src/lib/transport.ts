// Playback clock for the generator. With a track loaded, the AudioContext clock
// is the master (sample-accurate); without one, a wall clock stands in.
//
// "Promo time" 0 is beat 0, which sits at `offsetSec` (beat_1_offset_sec) in the track.

export class Transport {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private startPromo = 0;
  private startClock = 0;
  private pausedAt = 0;
  private offsetSec = 0;

  get isPlaying() {
    return this.playing;
  }

  get audioBuffer() {
    return this.buffer;
  }

  async loadAudio(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load audio (${res.status})`);
    const data = await res.arrayBuffer();
    const ctx = this.context();
    const buffer = await ctx.decodeAudioData(data);
    const t = this.time();
    this.stopSource();
    this.buffer = buffer;
    if (this.playing) this.play(t);
    return buffer;
  }

  clearAudio() {
    const t = this.time();
    this.stopSource();
    this.buffer = null;
    if (this.playing) this.play(t);
  }

  setOffset(sec: number) {
    if (sec === this.offsetSec) return;
    const t = this.time();
    this.offsetSec = sec;
    if (this.playing) this.play(t);
  }

  /** Current promo time in seconds. */
  time(): number {
    if (!this.playing) return this.pausedAt;
    if (this.buffer && this.ctx) {
      // Output latency: the sample being heard now was scheduled this long ago.
      const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
      return Math.max(this.startPromo, this.startPromo + this.ctx.currentTime - this.startClock - latency);
    }
    return this.startPromo + performance.now() / 1000 - this.startClock;
  }

  play(fromPromo = this.time()) {
    this.stopSource();
    this.playing = true;
    this.startPromo = fromPromo;
    if (this.buffer) {
      const ctx = this.context();
      void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(ctx.destination);
      const audioPos = this.offsetSec + fromPromo;
      // Beat 0 before the track starts (negative offset): wait, then start at 0.
      if (audioPos >= 0) src.start(ctx.currentTime, audioPos);
      else src.start(ctx.currentTime - audioPos, 0);
      this.source = src;
      this.startClock = ctx.currentTime;
    } else {
      this.startClock = performance.now() / 1000;
    }
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time();
    this.playing = false;
    this.stopSource();
  }

  seek(promoSec: number) {
    const t = Math.max(0, promoSec);
    if (this.playing) this.play(t);
    else this.pausedAt = t;
  }

  dispose() {
    this.stopSource();
    void this.ctx?.close();
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    return this.ctx;
  }

  private stopSource() {
    if (!this.source) return;
    this.source.onended = null;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }
}
