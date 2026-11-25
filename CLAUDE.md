# Meet

Video calls for up to four people at `meet.mkjems.dk`: audio, video, screen sharing and chat. Media goes browser
to browser (WebRTC, a full mesh); the server only introduces people and passes setup messages and chat.
Decisions, deploy steps and what's left are in [docs/Plan.md](docs/Plan.md); keep it up to date.

## Working on the project

- `npm run dev`: the app on http://localhost:5173, with the signaling server inside Vite. Camera and mic need
  https or localhost, so a phone on the local network (http) can't use them; test phones on meet.mkjems.dk.
- `npm test`: the signaling server (Vitest).
- `npm run browser`: real meetings between headless Chromium pages with fake cameras and mics: four people,
  a fifth turned away, mute and camera state, screen sharing, chat, reload, leave and rejoin, phone layout.
  About 15 s. Run it after changing anything in `src/` or `server/`. Screenshots land in `tests/out/`.
- `npm run serve`: build, then the production server on port 8080.
- `?test` in the address exposes `window.__meet` (peers and their connection stats) for the browser tests.

## Layout

- `server/rooms.mjs`: signaling on `/ws`. Rooms of at most 4, kept in memory only while someone is in them.
  The message list is in its header comment.
- `server/server.mjs`: production server: `dist/`, `/ws`, and `/config` (ICE servers; TURN if `TURN_URLS`
  and `TURN_SECRET` are set).
- `src/peer.ts`: one RTCPeerConnection per other person. The lower id offers; three fixed transceivers
  (audio, camera, screen); turning things on/off is `replaceTrack`, never renegotiation.
- `src/media.ts`: our mic, camera and screen. `src/levels.ts`: speaking detection and join/leave chimes.
- `src/layout.ts`: grid and stage (screen or pinned tile big, the rest in a strip).
- `src/main.ts`: screens (home, lobby, call, ended), tiles, controls, chat.

## Rules of thumb

- Keep the server dumb: no media through it, nothing on disk.
- Commit locally; ask before pushing or creating the GitHub repository.
