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
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
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
      res.writeHead(200, {
        "content-type": type, "content-length": s.size, "cache-control": cache,
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
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
