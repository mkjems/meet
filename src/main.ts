// The app: home (start or join a meeting), the lobby (camera, mic and name), the meeting, and the screen after it.
// A meeting is its link: /abcd-efgh. Everyone in it connects to everyone else (src/peer.ts); the server
// (server/rooms.mjs) introduces them and passes chat and who has their mic, camera or screen on.

import "./style.css";
import { icons } from "./icons";
import { grid, stage, type Rect } from "./layout";
import { Levels } from "./levels";
import { LocalMedia } from "./media";
import { Peer, SLOTS, type PeerSignal } from "./peer";
import { Signal, type ServerMsg } from "./signal";

type State = { name: string; mic: boolean; cam: boolean; screen: boolean };
type Person = { id: string; state: State; peer: Peer; audio: HTMLAudioElement };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------------------------------------------------------
// Meeting codes and our id

const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/i/l: codes can be read aloud
const CODE_RE = /^[a-z0-9]{3,8}(-[a-z0-9]{3,8}){0,3}$/;

function randomString(n: number) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}
function newCode() { const s = randomString(8); return `${s.slice(0, 4)}-${s.slice(4)}`; }
/** A code from what someone typed or pasted: the code itself, or a whole link. */
function codeFrom(input: string) {
  let s = input.trim().toLowerCase();
  try { if (/^https?:/.test(s)) s = new URL(s).pathname; } catch { /* not a link */ }
  s = s.replace(/^\/+|\/+$/g, "").replace(/\s+/g, "");
  return CODE_RE.test(s) ? s : null;
}
/** Our id in a meeting, kept for this tab, so a reload comes back as the same person. */
function idFor(code: string, fresh = false) {
  const k = `meet-id:${code}`;
  let id = fresh ? null : sessionStorage.getItem(k);
  if (!id) { id = randomString(16); sessionStorage.setItem(k, id); }
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// State

const media = new LocalMedia();
const levels = new Levels();
const people = new Map<string, Person>();
let room = "";
let myId = "";
let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
let signal: Signal | null = null;
let inCall = false;
let joinedAt = 0;
let pinned: string | null = null;
let chatOpen = false;
let unread = 0;
let sentState = "";
let wakeLock: { release(): Promise<void> } | null = null;

const myName = () => ($<HTMLInputElement>("name").value.trim() || "Guest").slice(0, 40);
const myState = (): State => ({ name: myName(), mic: media.micOn, cam: media.camOn, screen: media.screenOn });
const link = () => `${location.origin}/${room}`;

// ---------------------------------------------------------------------------------------------------------------
// Screens and routing

type ScreenName = "home" | "lobby" | "call" | "ended";
function show(name: ScreenName) {
  for (const s of ["home", "lobby", "call", "ended"] as const) $(s).hidden = s !== name;
  document.body.dataset.screen = name;
}

function route() {
  const code = codeFrom(location.pathname);
  if (inCall) leave();
  if (code) enterLobby(code);
  else { closeSignal(); stopPreview(); show("home"); document.title = "Meet: video calls with friends, no sign-up"; }
}
window.addEventListener("popstate", route);

function go(code: string) {
  history.pushState(null, "", `/${code}`);
  route();
}

$("b-new").onclick = () => go(newCode());
$("f-join").onsubmit = (e) => {
  e.preventDefault();
  const code = codeFrom($<HTMLInputElement>("join-code").value);
  if (code) go(code);
  else toast("That doesn't look like a meeting code or link.");
};

// ---------------------------------------------------------------------------------------------------------------
// Lobby

async function enterLobby(code: string) {
  room = code;
  myId = idFor(code);
  show("lobby");
  document.title = `Meet · ${code}`;
  $<HTMLInputElement>("lobby-link").value = link();
  $<HTMLInputElement>("name").value = store.get("meet-name") ?? "";
  $("lobby-error").hidden = true;
  $("lobby-who").textContent = " ";
  updateInitials();
  levels.start(); // allowed when we came here by a click; otherwise it starts at the first click

  openSignal();
  void fetch("/config").then((r) => r.json()).then((c) => { if (Array.isArray(c.iceServers)) iceServers = c.iceServers; }).catch(() => {});
  if (!media.mic && !media.cam) {
    await media.start(store.get("meet-mic-on") !== "0", store.get("meet-cam-on") !== "0");
  }
  renderLobby();
  void fillDevices();
}

function renderLobby() {
  const v = $<HTMLVideoElement>("lobby-video");
  setVideo(v, media.cam);
  v.parentElement!.classList.toggle("no-video", !media.cam);
  setRound($("lb-mic"), media.micOn, icons.mic, icons.micOff, "Microphone");
  setRound($("lb-cam"), media.camOn, icons.cam, icons.camOff, "Camera");
  const err = [media.micError, media.camError].filter(Boolean).join(" ");
  $("lobby-error").hidden = !err;
  $("lobby-error").textContent = err;
  levels.watch("me", media.mic);
}

function stopPreview() {
  if (inCall) return;
  media.stopAll();
  levels.watch("me", null);
  setVideo($<HTMLVideoElement>("lobby-video"), null);
}

function updateInitials() { $("lobby-initials").textContent = initials(myName()); }
$("name").addEventListener("input", () => { updateInitials(); });
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

$("lb-mic").onclick = async () => {
  await media.setMicOn(!media.micOn);
  store.set("meet-mic-on", media.micOn ? "1" : "0");
  renderLobby();
};
$("lb-cam").onclick = async () => {
  await media.setCamOn(!media.camOn);
  store.set("meet-cam-on", media.camOn ? "1" : "0");
  renderLobby();
};
$("b-lobby-copy").onclick = () => copyLink();
$("b-join").onclick = () => join();

async function fillDevices() {
  const { mics, cams } = await media.devices();
  for (const [ids, list, current] of [[["sel-mic", "set-mic"], mics, media.mic], [["sel-cam", "set-cam"], cams, media.cam]] as const) {
    const now = current?.getSettings().deviceId ?? "";
    for (const id of ids) {
      const sel = $<HTMLSelectElement>(id);
      sel.replaceChildren(...list.map((d, i) => new Option(d.label || `${d.kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`, d.deviceId, false, d.deviceId === now)));
      sel.disabled = list.length === 0;
      if (!list.length) sel.replaceChildren(new Option("None found", ""));
    }
  }
}
for (const id of ["sel-mic", "set-mic"]) $<HTMLSelectElement>(id).onchange = async (e) => { await media.useMic((e.target as HTMLSelectElement).value); renderLobby(); void fillDevices(); };
for (const id of ["sel-cam", "set-cam"]) $<HTMLSelectElement>(id).onchange = async (e) => { await media.useCam((e.target as HTMLSelectElement).value); renderLobby(); void fillDevices(); };
navigator.mediaDevices?.addEventListener?.("devicechange", () => void fillDevices());

// ---------------------------------------------------------------------------------------------------------------
// The server

function openSignal() {
  if (signal) { if (signal.open) signal.send({ t: "peek", room }); return; }
  const s = new Signal();
  signal = s;
  s.onOpen = (again) => {
    if (inCall) s.send({ t: "join", room, id: myId, state: myState(), again });
    else s.send({ t: "peek", room });
  };
  s.onStatus = (online) => { $("offline").hidden = online || !inCall; };
  s.onReplaced = () => { signal = null; end("You opened this meeting in another tab", "This tab has left the meeting.", true); };
  s.onMessage = onServer;
  s.connect();
}

function closeSignal() {
  signal?.close();
  signal = null;
}

// Who is in the lobby's meeting, every few seconds.
setInterval(() => { if (!inCall && !$("lobby").hidden && signal?.open) signal.send({ t: "peek", room }); }, 4000);

function onServer(m: ServerMsg) {
  switch (m.t) {
    case "count": {
      if (inCall || m.room !== room) return;
      const names: string[] = m.names ?? [];
      $("lobby-who").textContent = m.n === 0 ? "No one else is here yet." :
        m.n >= m.max ? `This meeting is full (${m.max} people).` :
        `${listNames(names)} ${m.n === 1 ? "is" : "are"} in the meeting.`;
      break;
    }
    case "full":
      inCall = false;
      show("lobby");
      $("lobby-error").hidden = false;
      $("lobby-error").textContent = `This meeting is full: it has room for ${m.max} people. Try again when someone leaves.`;
      break;
    case "error":
      if (!inCall) { $("lobby-error").hidden = false; $("lobby-error").textContent = m.message; }
      else toast(m.message);
      break;
    case "welcome": {
      if (!inCall) return;
      const here = new Set<string>();
      for (const p of m.peers as (State & { id: string })[]) {
        here.add(p.id);
        const known = people.get(p.id);
        if (known) { known.state = pickState(p); known.peer.ensure(); }
        else addPerson(p.id, pickState(p)).peer.start();
      }
      for (const id of [...people.keys()]) if (!here.has(id)) removePerson(id);
      render();
      break;
    }
    case "joined": {
      if (!inCall) return;
      const p = m.peer as State & { id: string };
      const known = people.get(p.id);
      if (known) {
        known.state = pickState(p);
        if (m.again) known.peer.ensure(); else known.peer.start();
      } else {
        addPerson(p.id, pickState(p)).peer.start();
        toast(`${p.name} joined`);
        levels.chime(true);
      }
      render();
      break;
    }
    case "left": {
      const p = people.get(m.id);
      if (!p) return;
      removePerson(m.id);
      toast(`${p.state.name} left`);
      levels.chime(false);
      render();
      break;
    }
    case "signal":
      people.get(m.from)?.peer.signal(m.d as PeerSignal);
      break;
    case "state": {
      const p = people.get(m.id);
      if (!p) return;
      const wasSharing = p.state.screen;
      p.state = pickState(m.state);
      if (p.state.screen && !wasSharing) toast(`${p.state.name} is sharing their screen`);
      render();
      break;
    }
    case "chat":
      addChat(m.from === myId ? "You" : m.name, m.text, m.at, m.from === myId);
      break;
  }
}

const pickState = (s: Partial<State>): State => ({ name: s.name || "Guest", mic: !!s.mic, cam: !!s.cam, screen: !!s.screen });

// ---------------------------------------------------------------------------------------------------------------
// Joining and leaving

function join() {
  if (inCall || !room) return;
  store.set("meet-name", $<HTMLInputElement>("name").value.trim());
  levels.start();
  inCall = true;
  joinedAt = Date.now();
  pinned = null;
  sentState = JSON.stringify(myState());
  openSignal();
  if (signal!.open) signal!.send({ t: "join", room, id: myId, state: myState(), again: false });
  show("call");
  $("offline").hidden = true;
  resetChat();
  updateControls();
  render();
  void keepAwake();
}

function leave(tell = true) {
  if (!inCall) return;
  inCall = false;
  if (tell) signal?.send({ t: "leave" });
  for (const id of [...people.keys()]) removePerson(id);
  media.stopAll();
  levels.watch("me", null);
  for (const t of tiles.values()) t.el.remove();
  tiles.clear();
  $("settings").hidden = true;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function end(title: string, text: string, freshId = false) {
  leave(!freshId);
  closeSignal();
  $("ended-title").textContent = title;
  $("ended-text").textContent = text;
  if (freshId) myId = idFor(room, true);
  show("ended");
}

$("b-leave").onclick = () => end("You left the meeting", "Rejoin with the same link, or start a new meeting.");
$("b-rejoin").onclick = () => enterLobby(room);
$("b-home").onclick = () => go(newCode());

function addPerson(id: string, state: State): Person {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  document.body.append(audio);
  const peer = new Peer(id, myId < id, (d) => signal?.send({ t: "signal", to: id, d }), iceServers, () => media.tracks);
  const person: Person = { id, state, peer, audio };
  peer.onChange = () => {
    const a = peer.streams?.audio ?? null;
    if (audio.srcObject !== a) { audio.srcObject = a; audio.play().catch(() => {}); }
    levels.watch(id, a?.getAudioTracks()[0] ?? null);
    render();
  };
  people.set(id, person);
  updateBitrates();
  return person;
}

function removePerson(id: string) {
  const p = people.get(id);
  if (!p) return;
  p.peer.close();
  p.audio.srcObject = null;
  p.audio.remove();
  levels.watch(id, null);
  people.delete(id);
  if (pinned?.endsWith(`:${id}`)) pinned = null;
  updateBitrates();
}

/** Each of us sends a copy to everyone else: the more people, the less each copy may use. */
function updateBitrates() {
  const n = people.size;
  const cam = [1_500_000, 1_500_000, 900_000, 600_000][Math.min(n, 3)];
  const screen = [2_500_000, 2_500_000, 1_800_000, 1_200_000][Math.min(n, 3)];
  for (const p of people.values()) p.peer.setBitrates({ cam, screen });
}

media.onTrack = (slot, track) => {
  for (const p of people.values()) p.peer.setTrack(slot, track);
  if (slot === "audio") levels.watch("me", track);
};
media.onChange = () => {
  if (inCall) { updateControls(); sendState(); render(); }
  else if (!$("lobby").hidden) renderLobby();
};

function sendState() {
  const s = JSON.stringify(myState());
  if (s === sentState) return;
  sentState = s;
  signal?.send({ t: "state", state: myState() });
}

async function keepAwake() {
  try { wakeLock = await (navigator as any).wakeLock?.request("screen") ?? null; } catch { /* not supported, or the page is hidden */ }
}
document.addEventListener("visibilitychange", () => { if (inCall && document.visibilityState === "visible" && !wakeLock) void keepAwake(); });

// ---------------------------------------------------------------------------------------------------------------
// Controls

function setRound(b: HTMLElement, on: boolean, onIcon: string, offIcon: string, what: string) {
  const badge = b.querySelector(".badge");
  b.innerHTML = on ? onIcon : offIcon;
  if (badge) b.append(badge);
  b.classList.toggle("off", !on);
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", `${what} ${on ? "on" : "off"}`);
}

const unreadBadge = $("unread"); // kept here: the chat button's contents are replaced on every update

function updateControls() {
  setRound($("b-mic"), media.micOn, icons.mic, icons.micOff, "Microphone");
  setRound($("b-cam"), media.camOn, icons.cam, icons.camOff, "Camera");
  const sb = $("b-screen");
  sb.hidden = !LocalMedia.canShareScreen();
  sb.innerHTML = media.screenOn ? icons.screenOff : icons.screen;
  sb.classList.toggle("active", media.screenOn);
  sb.title = media.screenOn ? "Stop sharing" : "Share your screen";
  sb.setAttribute("aria-label", sb.title);
  const cb = $("b-chat");
  cb.innerHTML = icons.chat;
  cb.append(unreadBadge);
  cb.classList.toggle("active", chatOpen);
  unreadBadge.hidden = unread === 0;
  unreadBadge.textContent = unread > 9 ? "9+" : String(unread);
  $("b-invite").innerHTML = icons.link;
  $("b-settings").innerHTML = icons.settings;
  $("b-leave").innerHTML = icons.leave;
  $("b-chat-close").innerHTML = icons.close;
  $("b-send").innerHTML = icons.send;
  $("people").innerHTML = `${icons.people}<span>${people.size + 1} / 4</span>`;
  document.title = `${people.size ? `(${people.size + 1}) ` : ""}Meet · ${room}`;
}

$("b-mic").onclick = () => void media.setMicOn(!media.micOn);
$("b-cam").onclick = () => void media.setCamOn(!media.camOn);
$("b-screen").onclick = () => { if (media.screenOn) media.stopScreen(); else void media.shareScreen(); };
$("b-chat").onclick = () => setChat(!chatOpen);
$("b-chat-close").onclick = () => setChat(false);
$("b-invite").onclick = () => copyLink();
$("b-settings").onclick = (e) => {
  e.stopPropagation();
  const p = $("settings");
  p.hidden = !p.hidden;
  if (!p.hidden) void fillDevices();
};
document.addEventListener("click", (e) => {
  const p = $("settings");
  if (!p.hidden && !p.contains(e.target as Node)) p.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (!inCall || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select")) return;
  if (e.key === "m" || e.key === "M") { e.preventDefault(); void media.setMicOn(!media.micOn); }
  else if (e.key === "v" || e.key === "V") { e.preventDefault(); void media.setCamOn(!media.camOn); }
  else if (e.key === "Escape") { $("settings").hidden = true; if (pinned) { pinned = null; render(); } }
});

async function copyLink() {
  const url = link();
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: "Join my meeting", url }); return; } catch { /* cancelled: copy instead */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    toast(url, 8000);
  }
}

setInterval(() => {
  if (!inCall) return;
  const s = Math.floor((Date.now() - joinedAt) / 1000);
  const h = Math.floor(s / 3600), mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, "0"), ss = String(s % 60).padStart(2, "0");
  $("clock").textContent = `${h ? `${h}:` : ""}${mm}:${ss}`;
}, 1000);

// ---------------------------------------------------------------------------------------------------------------
// Tiles

type Tile = { el: HTMLElement; video: HTMLVideoElement; key: string };
const tiles = new Map<string, Tile>();

function makeTile(key: string): Tile {
  const el = document.createElement("div");
  el.className = "tile";
  el.dataset.key = key;
  el.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="avatar"><span></span></div>
    <div class="status"></div>
    <div class="label"><span class="mic-off" hidden>${icons.micOff}</span><span class="name"></span></div>
    <div class="tools">
      <button class="pin" title="Pin">${icons.pin}</button>
      <button class="fs" title="Full screen">${icons.full}</button>
    </div>
    <button class="stop-share" hidden>Stop sharing</button>`;
  const video = el.querySelector("video")!;
  el.querySelector<HTMLButtonElement>(".pin")!.onclick = () => { pinned = pinned === key ? null : key; render(); };
  el.querySelector<HTMLButtonElement>(".fs")!.onclick = () => fullscreen(el);
  el.querySelector<HTMLButtonElement>(".stop-share")!.onclick = () => media.stopScreen();
  el.ondblclick = () => fullscreen(el);
  $("tiles").append(el);
  const t = { el, video, key };
  tiles.set(key, t);
  return t;
}

function fullscreen(el: HTMLElement) {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.().catch(() => {});
}

type TileSpec = {
  key: string; name: string; video: MediaStreamTrack | MediaStream | null; showVideo: boolean;
  screen: boolean; self: boolean; micOff: boolean; status: string; speakKey: string | null;
};

function specs(): TileSpec[] {
  const me = myState();
  const out: TileSpec[] = [{
    key: "cam:me", name: `${me.name} (you)`, video: media.cam, showVideo: !!media.cam, screen: false, self: true,
    micOff: !media.micOn, status: "", speakKey: media.micOn ? "me" : null,
  }];
  if (media.screen) out.push({ key: "screen:me", name: "Your screen", video: media.screen, showVideo: true, screen: true, self: true, micOff: false, status: "", speakKey: null });
  for (const p of people.values()) {
    const up = p.peer.status === "connected";
    const status = p.peer.status === "failed" ? "Couldn't connect" : up ? "" : "Connecting…";
    out.push({
      key: `cam:${p.id}`, name: p.state.name, video: p.peer.streams?.cam ?? null, showVideo: up && p.state.cam,
      screen: false, self: false, micOff: !p.state.mic, status, speakKey: p.id,
    });
    if (p.state.screen) out.push({
      key: `screen:${p.id}`, name: `${p.state.name}'s screen`, video: p.peer.streams?.screen ?? null, showVideo: up,
      screen: true, self: false, micOff: false, status, speakKey: null,
    });
  }
  return out;
}

let rendering = false;
function render() {
  if (rendering) return;
  rendering = true;
  requestAnimationFrame(() => { rendering = false; draw(); });
}

function draw() {
  if (!inCall) return;
  updateControls();
  const list = specs();
  const keys = new Set(list.map((s) => s.key));
  for (const [k, t] of tiles) if (!keys.has(k)) { t.el.remove(); tiles.delete(k); }
  for (const s of list) {
    const t = tiles.get(s.key) ?? makeTile(s.key);
    const el = t.el;
    setVideo(t.video, s.showVideo ? s.video : null);
    el.classList.toggle("no-video", !s.showVideo);
    el.classList.toggle("screen", s.screen);
    el.classList.toggle("self", s.self && !s.screen);
    el.dataset.speak = s.speakKey ?? "";
    el.querySelector(".name")!.textContent = s.name;
    el.querySelector<HTMLElement>(".mic-off")!.hidden = !s.micOff;
    el.querySelector(".avatar span")!.textContent = initials(s.name.replace(" (you)", ""));
    el.querySelector<HTMLElement>(".avatar")!.style.setProperty("--hue", String(hue(s.key)));
    const st = el.querySelector<HTMLElement>(".status")!;
    st.textContent = s.status;
    st.hidden = !s.status;
    el.querySelector<HTMLElement>(".stop-share")!.hidden = s.key !== "screen:me";
    const pin = el.querySelector<HTMLElement>(".pin")!;
    pin.innerHTML = pinned === s.key ? icons.unpin : icons.pin;
    pin.title = pinned === s.key ? "Unpin" : "Pin";
  }
  placeTiles(list);
  $("waiting").hidden = people.size > 0;
}

/** The big tile: a pinned one, else someone else's shared screen. */
function focusKey(list: TileSpec[]) {
  if (pinned && list.some((s) => s.key === pinned)) return pinned;
  return list.find((s) => s.screen && !s.self)?.key ?? null;
}

function placeTiles(list: TileSpec[]) {
  const box = $("tiles");
  const W = box.clientWidth, H = box.clientHeight, gap = W < 600 ? 6 : 10;
  const focus = list.length > 1 ? focusKey(list) : null;
  const rects = new Map<string, Rect>();
  if (focus) {
    const rest = list.filter((s) => s.key !== focus);
    const { main, strip } = stage(rest.length, W, H, gap);
    rects.set(focus, main);
    rest.forEach((s, i) => rects.set(s.key, strip[i]));
  } else {
    grid(list.length, W, H, gap).forEach((r, i) => rects.set(list[i].key, r));
  }
  for (const s of list) {
    const r = rects.get(s.key)!, el = tiles.get(s.key)!.el;
    const first = !el.dataset.placed; // a new tile appears where it belongs; only later moves slide
    if (first) el.style.transition = "none";
    el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    if (first) { void el.offsetWidth; el.style.transition = ""; el.dataset.placed = "1"; }
    el.classList.toggle("focus", s.key === focus);
    el.classList.toggle("small", r.w < 220);
  }
}
new ResizeObserver(() => render()).observe($("tiles"));

// A card in the grid while no one else is here.
const waiting = document.createElement("div");
waiting.id = "waiting";
waiting.className = "waiting";
waiting.innerHTML = `<p>Waiting for others to join</p><button class="primary">${icons.link}<span>Copy invite link</span></button>`;
waiting.querySelector("button")!.onclick = () => copyLink();
$("tiles").after(waiting);

/** Show a track or stream in a video element, touching it only when it changes (no flicker). */
function setVideo(v: HTMLVideoElement, src: MediaStreamTrack | MediaStream | null) {
  const cur = v.srcObject as MediaStream | null;
  if (!src) { if (cur) v.srcObject = null; return; }
  if (src instanceof MediaStream) { if (cur !== src) { v.srcObject = src; v.play().catch(() => {}); } return; }
  if (cur?.getVideoTracks()[0] === src) return;
  v.srcObject = new MediaStream([src]);
  v.play().catch(() => {});
}

// Who is speaking: a ring around their tile; and the lobby's mic meter.
setInterval(() => {
  const now = performance.now();
  if (inCall) for (const t of tiles.values()) {
    const k = t.el.dataset.speak;
    t.el.classList.toggle("speaking", !!k && levels.speaking(k, now));
  }
  else if (!$("lobby").hidden) {
    const l = media.micOn ? Math.min(1, levels.level("me") * 6) : 0;
    $("lobby-meter").style.transform = `scaleX(${l})`;
  }
}, 100);

// ---------------------------------------------------------------------------------------------------------------
// Chat

function setChat(open: boolean) {
  chatOpen = open;
  $("chat").hidden = !open;
  document.body.classList.toggle("chat-open", open);
  if (open) { unread = 0; $<HTMLTextAreaElement>("chat-input").focus(); scrollChat(); }
  updateControls();
  render();
}

function resetChat() {
  $("chat-list").replaceChildren();
  unread = 0;
  setChat(false);
}

function addChat(name: string, text: string, at: number, mine: boolean) {
  const li = document.createElement("li");
  li.className = mine ? "mine" : "";
  const head = document.createElement("div");
  head.className = "head";
  head.append(Object.assign(document.createElement("b"), { textContent: name }), Object.assign(document.createElement("time"), {
    textContent: new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }));
  const body = document.createElement("p");
  // Links become clickable; everything else stays plain text.
  for (const part of text.split(/(https?:\/\/[^\s<>"]+)/g)) {
    if (/^https?:\/\//.test(part)) body.append(Object.assign(document.createElement("a"), { href: part, textContent: part, target: "_blank", rel: "noopener noreferrer" }));
    else if (part) body.append(part);
  }
  li.append(head, body);
  $("chat-list").append(li);
  scrollChat();
  if (!chatOpen && !mine) {
    unread++;
    updateControls();
    toast(`${name}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
  }
}

function scrollChat() { const l = $("chat-list"); l.scrollTop = l.scrollHeight; }

$("f-chat").onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;
  signal?.send({ t: "chat", text });
  input.value = "";
  input.style.height = "";
};
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $<HTMLFormElement>("f-chat").requestSubmit(); }
});
$("chat-input").addEventListener("input", (e) => {
  const t = e.target as HTMLTextAreaElement;
  t.style.height = "";
  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
});

// ---------------------------------------------------------------------------------------------------------------
// Little things

function toast(text: string, ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? [...parts[0]].slice(0, 2).join("") : [...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase();
}

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "Someone";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// For the browser tests (tests/browser.mjs): what this page sees of the meeting.
if (new URLSearchParams(location.search).has("test")) {
  (window as any).__meet = {
    id: () => myId,
    async peers() {
      const out: Record<string, unknown> = {};
      for (const p of people.values()) out[p.state.name] = { ...(await p.peer.stats()), state: p.state };
      return out;
    },
    local: () => ({ mic: media.micOn, cam: media.camOn, screen: media.screenOn }),
    slots: SLOTS,
  };
}

route();
