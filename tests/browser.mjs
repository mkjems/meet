// Browser tests: real meetings between several headless Chromium pages, each with a fake camera and mic (a test
// pattern and a beep), through a Vite server with the signaling in it. Each page is a separate browser context,
// like a separate person's browser.
//
//   npm run browser            all scenarios
//   npm run browser -- screen  only scenarios whose name contains "screen"

import { createServer } from "vite";
import { chromium } from "playwright";

const only = process.argv[2];
const vite = await createServer({ server: { port: 5391, host: "127.0.0.1" }, logLevel: "error" });
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    // Screen sharing picks the current tab without asking.
    "--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen",
  ],
});

let failed = 0;
const check = (ok, what, detail = "") => { if (!ok) throw new Error(`${what}${detail ? `: ${detail}` : ""}`); };
let n = 0;
const code = () => `test-${Date.now().toString(36).slice(-4)}${n++}`;

/** A person: their own browser context, in the lobby of a meeting, then joined with a name. */
async function person(room, name, { join = true, viewport = { width: 1100, height: 700 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|stats\.mkjems|goatcounter|WebSocket/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`${origin}/${room}?test`);
  await page.waitForFunction(() => window.__meet && document.body.dataset.screen === "lobby");
  if (join) await joinAs(page, name);
  return page;
}
async function joinAs(page, name) {
  await page.fill("#name", name);
  await page.click("#b-join");
  await page.waitForFunction(() => document.body.dataset.screen === "call");
}

/** Until this page is connected to everyone named, receiving their audio and video. */
async function connected(page, names, timeout = 20000) {
  await page.waitForFunction(async (names) => {
    const p = await window.__meet.peers();
    return Object.keys(p).length === names.length && names.every((n) => p[n]?.status === "connected" && (p[n].got.audio ?? 0) > 500 && (p[n].got.cam ?? 0) > 5000);
  }, names, { timeout, polling: 250 });
}

async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  const pages = [];
  const t0 = Date.now();
  try {
    await fn(async (...a) => { const p = await person(...a); pages.push(p); return p; });
    const errs = pages.flatMap((p) => p.errors);
    check(errs.length === 0, "errors in the page", errs.join(" | "));
    console.log(`  ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  } finally {
    for (const p of pages) await p.context().close().catch(() => {});
  }
}

await scenario("two people see and hear each other", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo");
  await connected(a, ["Bo"]);
  await connected(b, ["Anna"]);
  await a.waitForFunction(() => document.querySelectorAll("#tiles .tile").length === 2);
  await a.waitForFunction(() => document.querySelector("#tiles .tile:not(.self) video")?.videoWidth > 0, null, { timeout: 5000 });
});

await scenario("four people, everyone connected to everyone; a fifth is turned away", async (open) => {
  const room = code();
  const names = ["Anna", "Bo", "Cai", "Dee"];
  const pages = [];
  for (const nm of names) pages.push(await open(room, nm));
  for (const [i, p] of pages.entries()) await connected(p, names.filter((_, j) => j !== i));
  await pages[0].waitForFunction(() => document.querySelectorAll("#tiles .tile").length === 4);
  const e = await open(room, "Eve", { join: false });
  await e.waitForFunction(() => /full/.test(document.querySelector("#lobby-who").textContent));
  await e.click("#b-join");
  await e.waitForFunction(() => !document.querySelector("#lobby-error").hidden && /full/.test(document.querySelector("#lobby-error").textContent));
  check(await e.evaluate(() => document.body.dataset.screen) === "lobby", "Eve stays in the lobby");
});

await scenario("mic and camera off show at the others", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo");
  await connected(a, ["Bo"]);
  await b.keyboard.press("m");
  await b.click("#b-cam");
  await a.waitForFunction(async () => { const p = (await window.__meet.peers()).Bo; return p && !p.state.mic && !p.state.cam; });
  const tile = a.locator('.tile[data-key^="cam:"]:not(.self)');
  await a.waitForFunction(() => document.querySelector('.tile:not(.self) .label .mic-off')?.hidden === false);
  check(await tile.evaluate((t) => t.classList.contains("no-video")), "Bo's tile shows the avatar");
  check(await b.evaluate(() => window.__meet.local().cam === false), "Bo's camera is off");
  await b.click("#b-cam");
  await a.waitForFunction(async () => (await window.__meet.peers()).Bo?.state.cam === true);
});

await scenario("screen sharing: the others get the screen on the big tile", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo");
  await connected(a, ["Bo"]);
  await b.click("#b-screen");
  await b.waitForFunction(() => window.__meet.local().screen, null, { timeout: 5000 }).catch(() => { throw new Error("getDisplayMedia didn't start in headless Chromium"); });
  await a.waitForFunction(async () => ((await window.__meet.peers()).Bo?.got.screen ?? 0) > 5000, null, { timeout: 15000 });
  await a.waitForFunction(() => document.querySelector('.tile.focus')?.dataset.key.startsWith("screen:"));
  await a.waitForFunction(() => document.querySelector(".tile.focus video")?.videoWidth > 0, null, { timeout: 5000 });
  await b.click("#b-screen");
  await a.waitForFunction(() => !document.querySelector('.tile[data-key^="screen:"]'));
});

await scenario("chat reaches everyone, with an unread count", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo");
  await connected(a, ["Bo"]);
  await a.click("#b-chat");
  await a.fill("#chat-input", "hello https://example.com");
  await a.press("#chat-input", "Enter");
  await b.waitForFunction(() => document.querySelector("#unread").textContent === "1");
  await b.click("#b-chat");
  const text = await b.locator("#chat-list li").first().textContent();
  check(/Anna/.test(text) && /hello/.test(text), "Bo sees Anna's message", text);
  check(await b.locator("#chat-list a").getAttribute("href") === "https://example.com", "the link is a link");
});

await scenario("a reload comes back into the meeting as the same person", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo");
  await connected(a, ["Bo"]);
  const id = await b.evaluate(() => window.__meet.id());
  await b.reload();
  await b.waitForFunction(() => window.__meet && document.body.dataset.screen === "lobby");
  check(await b.evaluate(() => window.__meet.id()) === id, "same id after the reload");
  await b.click("#b-join");
  await connected(b, ["Anna"]);
  await connected(a, ["Bo"]);
  await a.waitForFunction(() => document.querySelectorAll("#tiles .tile").length === 2, null, { timeout: 5000 });
  await a.waitForFunction(() => document.querySelector("#tiles .tile:not(.self) video")?.videoWidth > 0, null, { timeout: 5000 });
});

await scenario("leaving: the others see it, and can carry on", async (open) => {
  const room = code();
  const a = await open(room, "Anna"), b = await open(room, "Bo"), c = await open(room, "Cai");
  await connected(a, ["Bo", "Cai"]);
  await c.click("#b-leave");
  await a.waitForFunction(async () => Object.keys(await window.__meet.peers()).length === 1);
  await connected(a, ["Bo"]);
  check(await c.evaluate(() => document.body.dataset.screen) === "ended", "Cai sees the ended screen");
  await c.click("#b-rejoin");
  await c.waitForFunction(() => document.body.dataset.screen === "lobby");
  await c.click("#b-join");
  await connected(c, ["Anna", "Bo"]);
});

await scenario("phone size: four people fit, controls fit", async (open) => {
  const room = code();
  const vp = { width: 390, height: 780 };
  const pages = [];
  for (const nm of ["Anna", "Bo", "Cai", "Dee"]) pages.push(await open(room, nm, { viewport: vp }));
  await connected(pages[0], ["Bo", "Cai", "Dee"]);
  const out = await pages[0].evaluate(() => [...document.querySelectorAll("#tiles .tile, .controls button:not([hidden])")].filter((e) => {
    const r = e.getBoundingClientRect();
    return getComputedStyle(e).display !== "none" && (r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1);
  }).map((e) => e.className || e.id));
  check(out.length === 0, "everything on screen", out.join(", "));
  await pages[0].waitForTimeout(400); // the tiles' slide
  await pages[0].screenshot({ path: "tests/out/phone-4.png" });
});

await browser.close();
await vite.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
