// The signaling server for meetings. Audio, video and screens go browser to browser (WebRTC, a full mesh: every
// person connects to every other one); this server only tells the people in a room about each other and passes
// the few setup messages between them, plus chat and each person's mic/camera/screen state. It keeps nothing on
// disk, and a room exists only while someone is in it.
//
//   attachRooms(httpServer)   adds the signaling on /ws to a Node HTTP server (ours, or Vite's in dev)
//
// Messages are JSON, { t: type, ... }:
//   from a browser  peek {room} · join {room, id, state, again} · signal {to, d} · state {state} · chat {text} ·
//                   leave · ping
//   to a browser    count {room, n, max} · welcome {id, peers: [{id, name, state}], max} · full {max} ·
//                   joined {peer, again} (someone came in or came back; `again`: after a network blip, so a
//                   connection to them that still works may be kept) · left {id} ·
//                   signal {from, d} · state {id, state} · chat {from, name, text, at} · error {message} · pong
//
// `id` is chosen by the browser (random, kept for the tab's life), so a reload or a dropped connection comes
// back as the same person: the new socket replaces the old one and the others are told `joined` again.

import { WebSocketServer } from "ws";

export const MAX_PEOPLE = 4;
const ROOM_RE = /^[a-z0-9]{3,8}(-[a-z0-9]{3,8}){0,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cleanState = (s) => ({
  name: clean(s?.name, 40) || "Guest",
  mic: !!s?.mic,
  cam: !!s?.cam,
  screen: !!s?.screen,
});

export function attachRooms(server, { max = MAX_PEOPLE } = {}) {
  /** room code -> Map(id -> {id, ws, state}) */
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== "/ws") return; // others (Vite's hot reload) are not ours
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const others = (room, id) => [...room].filter(([k]) => k !== id).map(([, p]) => p);

  wss.on("connection", (ws) => {
    let code = null, room = null, id = null;
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });

    const leave = () => {
      if (!room || room.get(id)?.ws !== ws) return;
      room.delete(id);
      for (const p of room.values()) send(p.ws, { t: "left", id });
      if (room.size === 0) rooms.delete(code);
      room = null;
    };

    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m.t !== "string") return;

      if (m.t === "ping") send(ws, { t: "pong" });
      else if (m.t === "peek") {
        const c = String(m.room ?? "");
        const r = rooms.get(c);
        send(ws, { t: "count", room: c, n: r?.size ?? 0, max, names: r ? [...r.values()].map((p) => p.state.name) : [] });
      } else if (m.t === "join" && !room) {
        const c = String(m.room ?? "");
        if (!ROOM_RE.test(c) || !ID_RE.test(String(m.id ?? ""))) return send(ws, { t: "error", message: "That isn't a meeting link." });
        const r = rooms.get(c) ?? new Map();
        const old = r.get(m.id);
        if (!old && r.size >= max) return send(ws, { t: "full", max });
        rooms.set(c, r);
        code = c; room = r; id = m.id;
        const state = cleanState(m.state);
        if (old) old.ws.close(4000, "replaced"); // the same person on a new connection (reload, network blip)
        r.set(id, { id, ws, state });
        send(ws, { t: "welcome", id, max, peers: others(r, id).map((p) => ({ id: p.id, ...p.state })) });
        for (const p of others(r, id)) send(p.ws, { t: "joined", peer: { id, ...state }, again: !!(old && m.again) });
      } else if (!room) {
        return;
      } else if (m.t === "signal") {
        const to = room.get(String(m.to));
        if (to && m.d && typeof m.d === "object") send(to.ws, { t: "signal", from: id, d: m.d });
      } else if (m.t === "state") {
        const me = room.get(id);
        me.state = cleanState(m.state);
        for (const p of others(room, id)) send(p.ws, { t: "state", id, state: me.state });
      } else if (m.t === "chat") {
        const text = String(m.text ?? "").slice(0, 2000).trim();
        if (!text) return;
        const msg = { t: "chat", from: id, name: room.get(id).state.name, text, at: Date.now() };
        for (const p of room.values()) send(p.ws, msg);
      } else if (m.t === "leave") {
        leave();
      }
    });

    ws.on("close", leave);
  });

  // A socket that stops answering pings (a laptop lid closed, a phone in a tunnel) is dropped, so the others see
  // the person leave instead of a frozen tile.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  beat.unref();

  return {
    rooms,
    close() { clearInterval(beat); for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}
