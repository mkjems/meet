// Who is speaking: the loudness of each audio track, for the ring around their tile.

export class Levels {
  private ctx: AudioContext | null = null;
  private meters = new Map<string, { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; held: number }>();

  /** Call from a click (browsers start audio only after one). */
  start() {
    if (this.ctx) return;
    try { this.ctx = new AudioContext(); } catch { return; }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Measure this track under this key (null: stop). Nothing happens if it's the track already measured. */
  watch(key: string, track: MediaStreamTrack | null) {
    const m = this.meters.get(key);
    if (m && m.track === track) return;
    if (m) { m.src.disconnect(); this.meters.delete(key); }
    if (!track || !this.ctx) return;
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    this.meters.set(key, { track, src, an, buf: new Float32Array(an.fftSize), held: 0 });
  }

  /** Loudness now, 0 to about 1 (RMS). */
  level(key: string) {
    const m = this.meters.get(key);
    if (!m) return 0;
    m.an.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) sum += v * v;
    return Math.sqrt(sum / m.buf.length);
  }

  /** Is this key speaking now? (Held for a moment, so the ring doesn't flicker between words.) */
  speaking(key: string, now = performance.now()) {
    const m = this.meters.get(key);
    if (!m) return false;
    if (this.level(key) > 0.02) m.held = now + 350;
    return now < m.held;
  }

  /** A soft two-note chime: up when someone joins, down when someone leaves. */
  chime(up: boolean) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const notes = up ? [660, 880] : [880, 587];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.12;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  }

  close() {
    for (const m of this.meters.values()) m.src.disconnect();
    this.meters.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
