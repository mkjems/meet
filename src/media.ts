// Our own microphone, camera and screen.
//
// Muting the mic only disables its track (it stays open, so unmuting is instant). Turning the camera off stops
// it, so the camera's light goes out. The chosen devices are remembered in this browser.

import type { Slot } from "./peer";

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" };

export class LocalMedia {
  mic: MediaStreamTrack | null = null;
  cam: MediaStreamTrack | null = null;
  screen: MediaStreamTrack | null = null;
  micId = store.get("meet-mic") ?? "";
  camId = store.get("meet-cam") ?? "";
  /** Why the mic or camera isn't available, for the lobby. */
  micError = "";
  camError = "";
  /** A track changed: send the new one to everyone. */
  onTrack: (slot: Slot, track: MediaStreamTrack | null) => void = () => {};
  onChange: () => void = () => {};

  get micOn() { return !!this.mic && this.mic.enabled; }
  get camOn() { return !!this.cam; }
  get screenOn() { return !!this.screen; }
  get tracks(): Record<Slot, MediaStreamTrack | null> {
    return { audio: this.mic, cam: this.cam, screen: this.screen };
  }

  static canShareScreen() {
    return !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices && !/Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  /** The lobby: ask for both at once (one permission prompt), falling back to what we can get. */
  async start(wantMic = true, wantCam = true) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micError = this.camError = "This page needs https for the camera and microphone.";
      this.onChange();
      return;
    }
    if (wantMic && wantCam) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioC(), video: this.videoC() });
        this.setMic(s.getAudioTracks()[0] ?? null);
        this.setCam(s.getVideoTracks()[0] ?? null);
        this.onChange();
        return;
      } catch { /* try them one at a time, to tell which one is the problem */ }
    }
    if (wantMic) await this.openMic();
    if (wantCam) await this.openCam();
    this.onChange();
  }

  async setMicOn(on: boolean) {
    if (on && !this.mic) await this.openMic();
    else if (this.mic) this.mic.enabled = on;
    this.onTrack("audio", this.mic);
    this.onChange();
  }

  async setCamOn(on: boolean) {
    if (on === this.camOn) return;
    if (on) await this.openCam();
    else { this.cam?.stop(); this.setCam(null); }
    this.onChange();
  }

  async useMic(id: string) {
    this.micId = id;
    store.set("meet-mic", id);
    const wasOn = this.micOn;
    this.mic?.stop();
    this.mic = null;
    await this.openMic();
    const mic = this.mic as MediaStreamTrack | null; // (TypeScript thinks it's still null after the await)
    if (mic && !wasOn) mic.enabled = false;
    this.onChange();
  }

  async useCam(id: string) {
    this.camId = id;
    store.set("meet-cam", id);
    if (!this.cam) return;
    this.cam.stop();
    this.setCam(null);
    await this.openCam();
    this.onChange();
  }

  /** Share a screen, a window or a tab. Throws nothing: a cancelled picker just leaves sharing off. */
  async shareScreen() {
    if (this.screen) return;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const t = s.getVideoTracks()[0];
      t.contentHint = "detail"; // text stays sharp; the frame rate drops instead
      t.addEventListener("ended", () => this.stopScreen()); // the browser's own "Stop sharing" button
      this.screen = t;
      this.onTrack("screen", t);
    } catch { /* cancelled */ }
    this.onChange();
  }

  stopScreen() {
    if (!this.screen) return;
    this.screen.stop();
    this.screen = null;
    this.onTrack("screen", null);
    this.onChange();
  }

  stopAll() {
    for (const t of [this.mic, this.cam, this.screen]) t?.stop();
    this.mic = this.cam = this.screen = null;
  }

  async devices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return { mics: all.filter((d) => d.kind === "audioinput"), cams: all.filter((d) => d.kind === "videoinput") };
    } catch { return { mics: [], cams: [] }; }
  }

  private audioC(): MediaTrackConstraints { return this.micId ? { ...AUDIO, deviceId: { exact: this.micId } } : AUDIO; }
  private videoC(): MediaTrackConstraints { return this.camId ? { ...VIDEO, deviceId: { exact: this.camId } } : VIDEO; }

  private async openMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioC() }).catch((e) => {
        // A remembered device that's gone (unplugged headset): fall back to the default one.
        if (this.micId && e?.name === "OverconstrainedError") { this.micId = ""; return navigator.mediaDevices.getUserMedia({ audio: AUDIO }); }
        throw e;
      });
      this.setMic(s.getAudioTracks()[0]);
      this.micError = "";
    } catch (e) {
      this.micError = explain(e, "microphone");
    }
  }

  private async openCam() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoC() }).catch((e) => {
        if (this.camId && e?.name === "OverconstrainedError") { this.camId = ""; return navigator.mediaDevices.getUserMedia({ video: VIDEO }); }
        throw e;
      });
      this.setCam(s.getVideoTracks()[0]);
      this.camError = "";
    } catch (e) {
      this.camError = explain(e, "camera");
    }
  }

  private setMic(t: MediaStreamTrack | null) {
    this.mic = t;
    if (t) t.addEventListener("ended", () => { if (this.mic === t) { this.mic = null; this.onTrack("audio", null); this.onChange(); } });
    this.onTrack("audio", t);
  }

  private setCam(t: MediaStreamTrack | null) {
    this.cam = t;
    if (t) {
      t.contentHint = "motion";
      t.addEventListener("ended", () => { if (this.cam === t) { this.cam = null; this.onTrack("cam", null); this.onChange(); } });
    }
    this.onTrack("cam", t);
  }
}

function explain(e: unknown, what: string) {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return `The ${what} is blocked. Allow it in the browser's site settings.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${what} found.`;
  if (name === "NotReadableError") return `The ${what} is in use by another app.`;
  return `The ${what} couldn't start.`;
}
