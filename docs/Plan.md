# Meet: plan

Started 25 November 2026, after voice chat in Pool worked well browser to browser.

## Decisions

- **Mesh, at most 4 people.** Everyone connects to everyone; each person sends a copy of their camera to each
  other person. Fine for 4 on home connections (about 3 × 0.6–1.5 Mbit/s up). More people would need an SFU
  (e.g. LiveKit) on the VPS, and then the server carries the video. The 4 is `MAX_PEOPLE` in `server/rooms.mjs`.
- **A meeting is its link** (`meet.mkjems.dk/abcd-efgh`, 8 random characters). No accounts, nothing stored.
  Anyone with the link can join while there's room. The lobby shows who is already in.
- **The same person after a reload or network blip**: the browser picks its id (kept per tab), and the server
  swaps the new connection in. A blip keeps a media connection that still works.
- **Bitrate caps by size**: camera 1.5 / 0.9 / 0.6 Mbit/s per copy with 1 / 2 / 3 others; screen 2.5 / 1.8 / 1.2.
- **Chat goes through the server** (tiny, and reliable even if a media connection fails). No history: you see
  messages sent while you're in.
- Screen sharing is desktop only (phones' browsers can't).
- Visits counted in GoatCounter as `meet.mkjems.dk/` and `/room` only, never the meeting codes.

## Deploy (first time)

1. DNS: `meet.mkjems.dk A 178.105.241.87`.
2. Infrastructure repo: the route (port 8088), `/opt/meet` and the log are added locally (25 November, not
   committed or applied). Preview with `ansible-playbook -i inventory.yml setup-vps.yml --check --diff`, then apply.
3. Create the GitHub repository `mkjems/meet`, add the secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (as Pool).
4. On the VPS: copy `compose.yaml` to `/opt/meet/compose.yaml`.
5. Push to `main`; the workflow tests, builds, pushes the image and deploys.

## Steps

- [x] 1. Signaling server with rooms of 4, rejoin, chat, state; tests. (25 November)
- [x] 2. Peer connections (mesh, fixed transceivers, retries), local media, screen sharing. (25 November)
- [x] 3. UI: home, lobby (preview, devices, name, who's in), call (grid/stage, pin, full screen, speaking ring,
  chat, invite link, device settings), ended screen; phone layout. (25 November)
- [x] 4. Browser tests with fake devices: 8 scenarios. (25 November)
- [ ] 5. Deploy (above), then try it for real: two or three people on different networks, a phone on mobile data.
- [ ] 6. TURN, if step 5 shows people who can't connect ("Couldn't connect" on a tile). coturn in Docker on the
  VPS (needs UDP 3478 and a port range open in the firewall), or a hosted one; the server already hands out
  credentials when `TURN_URLS` and `TURN_SECRET` are set.

## Ideas, not done

- Raise hand / reactions; a "you're muted" hint when speaking while muted.
- Noise suppression beyond the browser's; background blur.
- Choose the speaker (output device) where browsers allow it.
- Connection quality per tile (from `getStats`).
