// One WebRTC connection to one other person in the meeting (a full mesh: everyone has one to everyone else).
//
// Who offers is fixed, so two offers never cross: the one whose id sorts first. The offerer makes three
// transceivers, always in this order: audio, camera, screen. They carry nothing until there is something to send;
// turning the mic, camera or a screen share on or off only swaps the track on its sender (replaceTrack), never a
// new offer. Each connection has an id (`c`): setup messages of an older one are dropped, and the answerer takes up
// a new one whenever an offer with a new id arrives. A connection that fails is made again from scratch (the
// answerer asks with `want`), a few times, further apart each time.

export type Slot = "audio" | "cam" | "screen";
export const SLOTS: Slot[] = ["audio", "cam", "screen"];

export type PeerSignal =
  | { want: true }
  | { c: string; description: RTCSessionDescriptionInit }
  | { c: string; candidate: RTCIceCandidateInit };

export type PeerStatus = "connecting" | "connected" | "failed";

/** Retries after a failed connection, in ms; then we give up until something new happens (a rejoin). */
const RETRY = [500, 2000, 5000, 10000];
/** A connection that hasn't connected in this long is treated as failed. */
const CONNECT_TIMEOUT = 20000;

export class Peer {
  status: PeerStatus = "connecting";
  /** What arrives from them, one stream per slot (replaced with every new connection). */
  streams: Record<Slot, MediaStream> | null = null;
  onChange: () => void = () => {};

  private pc: RTCPeerConnection | null = null;
  private c = "";
  private tx: Partial<Record<Slot, RTCRtpTransceiver>> = {};
  private pending: RTCIceCandidateInit[] = [];
  private queue = Promise.resolve();
  private tries = 0;
  private timer = 0;
  private closed = false;
  private bitrates: Partial<Record<Slot, number>> = {};

  constructor(
    readonly id: string,
    readonly offerer: boolean,
    private send: (d: PeerSignal) => void,
    private iceServers: RTCIceServer[],
    private local: () => Record<Slot, MediaStreamTrack | null>,
  ) {}

  /** A new connection (they just came, or reloaded): the offerer offers; the answerer drops any old one and waits. */
  start() {
    if (this.closed) return;
    this.tries = 0;
    if (this.offerer) { void this.offer(); return; }
    this.hangUp();
    this.setStatus("connecting");
    this.watch();
  }

  /** After a network blip: keep a connection that still works, else start a new one (the answerer asks for it). */
  ensure() {
    if (this.closed || this.status === "connected") return;
    this.tries = 0;
    this.renew();
  }

  /** A setup message from them, through the server. Handled one at a time, in order. */
  signal(d: PeerSignal) {
    this.queue = this.queue.then(() => this.handle(d)).catch((e) => console.info(`peer ${this.id}:`, e));
  }

  /** Our track for a slot changed (mic, camera or screen on, off or switched to another device). */
  setTrack(slot: Slot, track: MediaStreamTrack | null) {
    const t = this.tx[slot];
    if (t && this.pc && this.pc.connectionState !== "closed") void t.sender.replaceTrack(track).catch(() => {});
  }

  /** Caps on what we send them, in bits per second (fewer people: more each). */
  setBitrates(b: Partial<Record<Slot, number>>) {
    this.bitrates = b;
    void this.applyBitrates();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.hangUp();
  }

  /** For the browser tests and the connection info: bytes received per slot, and the route in use. */
  async stats() {
    const got: Record<string, number> = {};
    let route = "";
    if (this.pc) {
      const report = await this.pc.getStats();
      const mids = new Map(SLOTS.map((s) => [this.tx[s]?.mid, s]));
      report.forEach((r) => {
        if (r.type === "inbound-rtp") { const s = mids.get(r.mid) ?? r.kind; got[s] = (got[s] ?? 0) + (r.bytesReceived ?? 0); }
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
          const local = report.get(r.localCandidateId);
          route = local?.candidateType === "relay" ? "relay" : "direct";
        }
      });
    }
    return { status: this.status, c: this.c, got, route };
  }

  private renew() {
    clearTimeout(this.timer);
    if (this.offerer) void this.offer();
    else { this.hangUp(); this.setStatus("connecting"); this.send({ want: true }); this.watch(); }
  }

  private async offer() {
    const pc = this.open(Math.random().toString(36).slice(2, 10));
    const tracks = this.local();
    this.tx = {
      audio: pc.addTransceiver("audio", { direction: "sendrecv" }),
      cam: pc.addTransceiver("video", { direction: "sendrecv" }),
      screen: pc.addTransceiver("video", { direction: "sendrecv" }),
    };
    this.received();
    // Every await is a chance for this connection to be replaced or closed meanwhile (they left, a newer offer).
    try {
      for (const s of SLOTS) if (tracks[s]) await this.tx[s]!.sender.replaceTrack(tracks[s]);
      if (pc !== this.pc) return;
      const offer = await pc.createOffer();
      if (pc !== this.pc) return;
      await pc.setLocalDescription(offer);
      if (pc === this.pc) this.send({ c: this.c, description: pc.localDescription!.toJSON() });
    } catch (e) {
      if (pc === this.pc) console.info(`peer ${this.id}: offer`, e);
    }
  }

  private async handle(d: PeerSignal) {
    if (this.closed) return;
    if ("want" in d) {
      if (this.offerer) { this.tries = 0; await this.offer(); }
    } else if ("description" in d) {
      if (d.description.type === "offer" && !this.offerer) {
        const pc = d.c === this.c && this.pc ? this.pc : this.open(d.c);
        await pc.setRemoteDescription(d.description);
        const [audio, cam, screen] = pc.getTransceivers();
        this.tx = { audio, cam, screen };
        this.received();
        const tracks = this.local();
        for (const s of SLOTS) {
          const t = this.tx[s];
          if (!t) continue;
          t.direction = "sendrecv";
          if (tracks[s]) await t.sender.replaceTrack(tracks[s]);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc === this.pc) this.send({ c: this.c, description: pc.localDescription!.toJSON() });
        await this.flush();
      } else if (d.description.type === "answer" && this.offerer && d.c === this.c && this.pc?.signalingState === "have-local-offer") {
        await this.pc.setRemoteDescription(d.description);
        await this.flush();
      }
    } else if ("candidate" in d) {
      if (d.c !== this.c || !this.pc) return;
      if (!this.pc.remoteDescription) this.pending.push(d.candidate);
      else await this.pc.addIceCandidate(d.candidate).catch(() => {});
    }
  }

  private async flush() {
    const pc = this.pc;
    for (const c of this.pending.splice(0)) await pc?.addIceCandidate(c).catch(() => {});
  }

  /** The receivers' tracks exist as soon as the transceivers do: show them right away (they start with no frames). */
  private received() {
    const s = (slot: Slot) => new MediaStream(this.tx[slot] ? [this.tx[slot]!.receiver.track] : []);
    this.streams = { audio: s("audio"), cam: s("cam"), screen: s("screen") };
    this.onChange();
  }

  /** A new connection with this id, in place of any earlier one. */
  private open(c: string) {
    this.hangUp();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.c = c;
    this.setStatus("connecting");
    this.watch();
    pc.onicecandidate = (e) => { if (e.candidate && pc === this.pc) this.send({ c, candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      const s = pc.connectionState;
      if (s === "connected") {
        clearTimeout(this.timer);
        this.tries = 0;
        this.setStatus("connected");
        void this.applyBitrates();
      } else if (s === "failed") this.failed();
      else if (s === "disconnected") this.watch(); // often comes back on its own; if not, the timer gives up on it
    };
    return pc;
  }

  /** Give the current attempt CONNECT_TIMEOUT to connect. */
  private watch() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { if (this.pc?.connectionState !== "connected") this.failed(); }, CONNECT_TIMEOUT);
  }

  private failed() {
    clearTimeout(this.timer);
    this.hangUp();
    if (this.closed) return;
    if (this.tries >= RETRY.length) { this.setStatus("failed"); return; }
    this.setStatus("connecting");
    this.timer = window.setTimeout(() => this.renew(), RETRY[this.tries++]);
  }

  private async applyBitrates() {
    for (const s of SLOTS) {
      const sender = this.tx[s]?.sender, max = this.bitrates[s];
      if (!sender || !max) continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings?.length) continue; // not negotiated yet: applied again once connected
        if (p.encodings[0].maxBitrate === max) continue;
        p.encodings[0].maxBitrate = max;
        await sender.setParameters(p);
      } catch { /* some browsers refuse while renegotiating; the next change tries again */ }
    }
  }

  private setStatus(s: PeerStatus) {
    if (s === this.status) return;
    this.status = s;
    this.onChange();
  }

  private hangUp() {
    const pc = this.pc;
    this.pc = null;
    this.tx = {};
    this.pending.length = 0;
    pc?.close();
  }
}
