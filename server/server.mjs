// Meet's server in production: the built app (dist/), the signaling on /ws, and /config (the ICE servers).
//
//   node server/server.mjs      serves dist/ on port 8080 (PORT and SITE override)
//
// TURN (optional, for people whose networks block browser-to-browser connections): set TURN_URLS (comma
// separated, e.g. "turn:turn.mkjems.dk:3478,turns:turn.mkjems.dk:5349") and TURN_SECRET (coturn's
// static-auth-secret). Each browser then gets credentials valid for 12 hours (coturn's "TURN REST API").

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachRooms } from "./rooms.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json",
};

/** The ICE servers browsers use to find a way to each other. */
export function iceServers(env = process.env, now = Date.now()) {
  const list = [{ urls: (env.STUN_URLS || "stun:stun.l.google.com:19302").split(",") }];
  if (env.TURN_URLS && env.TURN_SECRET) {
    const username = `${Math.floor(now / 1000) + 12 * 3600}:meet`;
    const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
    list.push({ urls: env.TURN_URLS.split(","), username, credential });
  }
  return list;
}

const CODE_RE = /^[a-z0-9]{3,8}(-[a-z0-9]{3,8}){0,3}$/; // as in src/main.ts

/** The meeting code in a page's path ("/abcd-efgh"), or null for the home page and anything else. */
export function codeIn(pathname) {
  const s = pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  return CODE_RE.test(s) ? s : null;
}

/**
 * index.html as a meeting link's page: its own title, address and picture, so a link preview (iMessage, Slack...)
 * shows an invitation to that meeting rather than the home page. Link previews read og:url (and the canonical
 * link) as the page's real address, so those must not point at the home page.
 */
export function meetingPage(html, code) {
  const meta = (prop, value) => (s) => s.replace(new RegExp(`(<meta property="${prop}"\\s+content=")[^"]*"`), `$1${value}"`);
  const edits = [
    (s) => s.replace(/<title>[^<]*<\/title>/, `<title>Join the call ${code} – Meet</title>`),
    (s) => s.replace(/\s*<link rel="canonical"[^>]*>/, ""),
    meta("og:title", `Join the call · ${code}`),
    meta("og:description", "You’re invited to a video call on Meet. Open the link to join, no sign-up."),
    (s) => s.replace(/(<meta property="og:url" content="[^"]*\/)"/, `$1${code}"`),
    (s) => s.replace(/(<meta property="og:image" content="[^"]*\/)og\.jpg"/, `$1og-join.jpg"`),
    meta("og:image:alt", "Meet: a video call with four smiling people in a grid, and the words: You’re invited to a call. Tap to join."),
  ];
  return edits.reduce((s, edit) => edit(s), html);
}

export function start({ port = 8080, site = fileURLToPath(new URL("../dist/", import.meta.url)) } = {}) {
  const root = resolve(site);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/config") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ iceServers: iceServers() }));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname));
    // A meeting link (/abcd-efgh) is the app's page; only paths with an extension are files.
    if (path.endsWith("/") || !extname(path)) path = "/index.html";
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error("not a file");
      const type = TYPES[extname(file)] || "application/octet-stream";
      // Built assets have hashed names and never change; the page itself must always be fresh.
      const cache = type.startsWith("text/html") ? "no-cache" : path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
      const code = path === "/index.html" ? codeIn(url.pathname) : null;
      const body = code ? Buffer.from(meetingPage(await readFile(file, "utf8"), code)) : await readFile(file);
      res.writeHead(200, {
        "content-type": type, "content-length": body.length, "cache-control": cache,
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        // Only the home page belongs in search results; meeting links (/abcd-efgh) are private.
        ...(type.startsWith("text/html") && url.pathname !== "/" ? { "x-robots-tag": "noindex" } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  });
  const rooms = attachRooms(server);
  return new Promise((done) => server.listen(port, () => done({
    port: server.address().port,
    rooms: rooms.rooms,
    close: () => new Promise((closed) => { rooms.close(); server.close(() => closed()); }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await start({ port: Number(process.env.PORT) || 8080, site: process.env.SITE || undefined });
  console.log(`Meet on http://localhost:${s.port}`);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => s.close().then(() => process.exit(0))); // docker stop
}
