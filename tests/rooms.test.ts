// The signaling server: who is told what when people join, talk, change state, drop out and come back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
// @ts-expect-error: plain JavaScript module
import { start, iceServers } from "../server/server.mjs";

type Msg = { t: string; [k: string]: any };
let srv: { port: number; rooms: Map<string, Map<string, unknown>>; close(): Promise<void> };

beforeEach(async () => { srv = await start({ port: 0 }); });
afterEach(async () => { await srv.close(); });

/** A test client: sends JSON, and waits for the next message of a type. */
async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const inbox: Msg[] = [];
  const waiters: { t: string; done: (m: Msg) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    const w = waiters.findIndex((w) => w.t === m.t);
    if (w >= 0) waiters.splice(w, 1)[0].done(m);
    else inbox.push(m);
  });
  await new Promise((ok) => ws.once("open", ok));
  return {
    ws,
    inbox,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    next(t: string, ms = 2000): Promise<Msg> {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no ${t}`)), ms);
        waiters.push({ t, done: (m) => { clearTimeout(timer); done(m); } });
      });
    },
  };
}
const quiet = () => new Promise((r) => setTimeout(r, 100));
const state = (name: string) => ({ name, mic: true, cam: true, screen: false });

describe("rooms", () => {
  it("tells a newcomer who is there, and the others that someone came", async () => {
    const a = await client(), b = await client();
    a.send({ t: "join", room: "abcd-efgh", id: "aaaaaaaa", state: state("Anna") });
    expect((await a.next("welcome")).peers).toEqual([]);
    b.send({ t: "join", room: "abcd-efgh", id: "bbbbbbbb", state: state("Bo") });
    const w = await b.next("welcome");
    expect(w.peers).toEqual([{ id: "aaaaaaaa", name: "Anna", mic: true, cam: true, screen: false }]);
    expect((await a.next("joined")).peer.id).toBe("bbbbbbbb");
  });

  it("passes signals only to the one they are for", async () => {
    const [a, b, c] = [await client(), await client(), await client()];
    for (const [x, id] of [[a, "aaaaaaaa"], [b, "bbbbbbbb"], [c, "cccccccc"]] as const) {
      x.send({ t: "join", room: "room1", id, state: state(id) });
      await x.next("welcome");
    }
    a.send({ t: "signal", to: "bbbbbbbb", d: { hello: 1 } });
    expect(await b.next("signal")).toEqual({ t: "signal", from: "aaaaaaaa", d: { hello: 1 } });
    await quiet();
    expect(c.inbox.filter((m) => m.t === "signal")).toEqual([]);
    expect(a.inbox.filter((m) => m.t === "signal")).toEqual([]);
  });

  it("lets four in and turns the fifth away", async () => {
    for (let i = 0; i < 4; i++) {
      const x = await client();
      x.send({ t: "join", room: "full-room", id: `person${i}x`, state: state(`P${i}`) });
      await x.next("welcome");
    }
    const e = await client();
    e.send({ t: "peek", room: "full-room" });
    expect(await e.next("count")).toMatchObject({ n: 4, max: 4 });
    e.send({ t: "join", room: "full-room", id: "person4x", state: state("P4") });
    expect(await e.next("full")).toMatchObject({ max: 4 });
  });

  it("sends chat to everyone (the sender too) and state to the others", async () => {
    const a = await client(), b = await client();
    a.send({ t: "join", room: "chat", id: "aaaaaaaa", state: state("Anna") }); await a.next("welcome");
    b.send({ t: "join", room: "chat", id: "bbbbbbbb", state: state("Bo") }); await b.next("welcome");
    a.send({ t: "chat", text: "  hi  " });
    expect(await a.next("chat")).toMatchObject({ from: "aaaaaaaa", name: "Anna", text: "hi" });
    expect(await b.next("chat")).toMatchObject({ from: "aaaaaaaa", name: "Anna", text: "hi" });
    a.send({ t: "state", state: { name: "Anna", mic: false, cam: true, screen: true } });
    expect(await b.next("state")).toEqual({ t: "state", id: "aaaaaaaa", state: { name: "Anna", mic: false, cam: true, screen: true } });
  });

  it("says when someone leaves, and forgets an empty room", async () => {
    const a = await client(), b = await client();
    a.send({ t: "join", room: "bye", id: "aaaaaaaa", state: state("Anna") }); await a.next("welcome");
    b.send({ t: "join", room: "bye", id: "bbbbbbbb", state: state("Bo") }); await b.next("welcome");
    b.ws.close();
    expect(await a.next("left")).toEqual({ t: "left", id: "bbbbbbbb" });
    a.send({ t: "leave" });
    await quiet();
    expect(srv.rooms.has("bye")).toBe(false);
  });

  it("takes someone back on a new connection, as the same person", async () => {
    const a = await client(), b = await client();
    a.send({ t: "join", room: "again", id: "aaaaaaaa", state: state("Anna") }); await a.next("welcome");
    b.send({ t: "join", room: "again", id: "bbbbbbbb", state: state("Bo") }); await b.next("welcome");
    await a.next("joined");
    const b2 = await client();
    b2.send({ t: "join", room: "again", id: "bbbbbbbb", state: state("Bo") });
    expect((await b2.next("welcome")).peers.map((p: Msg) => p.id)).toEqual(["aaaaaaaa"]);
    expect((await a.next("joined")).peer.id).toBe("bbbbbbbb");
    await quiet();
    // The old socket was closed by the server, and that is not a leave.
    expect(b.ws.readyState).toBe(WebSocket.CLOSED);
    expect(a.inbox.filter((m) => m.t === "left")).toEqual([]);
    expect(srv.rooms.get("again")!.size).toBe(2);
  });

  it("refuses room codes and ids that are not ours", async () => {
    const a = await client();
    a.send({ t: "join", room: "../etc", id: "aaaaaaaa", state: state("Anna") });
    expect((await a.next("error")).message).toMatch(/meeting link/);
  });
});

describe("ICE servers", () => {
  it("is STUN only without TURN settings", () => {
    expect(iceServers({}, 0)).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
  });
  it("gives TURN credentials that expire, signed with the shared secret", () => {
    const list = iceServers({ TURN_URLS: "turn:t.example:3478", TURN_SECRET: "s3cret" }, 1_000_000_000);
    expect(list[1]).toMatchObject({ urls: ["turn:t.example:3478"], username: `${1_000_000 + 43200}:meet` });
    expect(list[1].credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
