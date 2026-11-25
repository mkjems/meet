// The connection to the signaling server (server/rooms.mjs), reconnecting on its own when it drops.

export type ServerMsg = { t: string; [k: string]: any };

export class Signal {
  onMessage: (m: ServerMsg) => void = () => {};
  /** Connected (again): the caller (re)joins here. */
  onOpen: (again: boolean) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  /** The server closed us because the same person opened the meeting on another connection (another tab). */
  onReplaced: () => void = () => {};

  private ws: WebSocket | null = null;
  private closed = false;
  private opened = false;
  private delay = 500;
  private timer = 0;
  private outbox: string[] = [];

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      const again = this.opened;
      this.opened = true;
      this.onStatus(true);
      this.onOpen(again);
      for (const m of this.outbox.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.closed) return;
      if (e.code === 4000) { this.closed = true; this.onReplaced(); return; }
      this.onStatus(false);
      this.timer = window.setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 8000);
    };
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  send(m: ServerMsg) {
    const s = JSON.stringify(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (m.t !== "signal") this.outbox.push(s); // setup messages are stale by then; the reconnect starts over
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
