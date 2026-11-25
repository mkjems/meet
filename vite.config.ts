import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
// @ts-expect-error: plain JavaScript module, shared with the production server
import { attachRooms } from "./server/rooms.mjs";
// @ts-expect-error: plain JavaScript module, shared with the production server
import { iceServers } from "./server/server.mjs";

const config: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url !== "/config") return next();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ iceServers: iceServers() }));
};

/** The signaling on /ws and the ICE config on /config, inside Vite's own server (dev and preview), as in production. */
function signaling(): Plugin {
  return {
    name: "meet-signaling",
    configureServer(server) {
      if (server.httpServer) attachRooms(server.httpServer);
      server.middlewares.use(config);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attachRooms(server.httpServer);
      server.middlewares.use(config);
    },
  };
}

export default defineConfig({
  plugins: [signaling()],
  // Meeting links (/abcd-efgh) are served the app's page, in dev too.
  appType: "spa",
  build: { target: "es2022" },
  test: { include: ["tests/**/*.test.ts"] },
});
