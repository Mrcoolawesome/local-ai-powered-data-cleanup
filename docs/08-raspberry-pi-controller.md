# Raspberry Pi Touchscreen Controller

## Hardware

3x4 inch touchscreen — small enough that this is a purpose-built control surface, not a scaled-down version of the main app. Design the UI for a handful of large, unambiguous touch targets, not a dense dashboard.

## UI

A minimal React app (served from the Pi, or served by the main Next.js app and just displayed full-screen in a kiosk-mode browser on the Pi — prefer this so there's one codebase, not two React apps to maintain) showing buttons for the views operators actually switch between during a live presentation: e.g. "Contacts," "Invoices," specific job photo sets. The exact button set is driven by whatever `Dataset`s/`Attachment` groups exist for the active `PresentationSession` — not hardcoded, since which sheets/photos matter varies per presentation.

## Realtime control protocol

A single WebSocket connection from the Pi to the server. Message shape:

```json
{ "type": "SHOW_VIEW", "target": { "kind": "dataset", "id": "..." } }
{ "type": "SHOW_VIEW", "target": { "kind": "attachments", "id": "..." } }
```

Server-side, this:
1. Updates `PresentationSession.activeView`.
2. Broadcasts the change over the same WebSocket channel to any subscribed presentation route ([07-zoom-bot.md](./07-zoom-bot.md)'s `/present/[sessionId]`), which updates its DOM in place.
3. Writes an `AuditLog` entry (who switched what view, when — useful if a presentation needs to be reconstructed later).

## Where the WebSocket server lives

Host it in the Next.js app (a custom server, or a dedicated small WS service alongside it) rather than in FastAPI — this is UI state synchronization, not an AI operation, and keeping it next to the Prisma-backed `PresentationSession` model avoids a cross-service round trip on every button press. Latency matters here: a Pi button press should reach the shared screen with no perceptible delay.

## Failure handling

- If the Pi loses connection, the presentation route keeps showing whatever was last active — it doesn't blank out.
- Reconnect logic on the Pi client (standard exponential backoff) so a brief network hiccup during a live meeting doesn't require physically restarting the Pi.

## Build status

**WS server + live presentation updates — built and tested end-to-end for real.** `apps/web/ws-server.ts` runs as a second process alongside Next (`docker-entrypoint.sh`), not inside the Next.js request cycle — the generated production server isn't something this app's own source controls, so splicing a WebSocket upgrade handler into it wasn't practical. Both processes are deliberately co-located in the *same* container (not a separate compose service) so a client always reaches the WS server at the same hostname it reached the page on, just a different port (3001 vs 3000) — see `ws-server.ts`'s own header comment for why a separate `ws-server` service would have broken this for the Zoom bot's Chromium specifically (compose-internal DNS only resolves a service's own name, and the Zoom bot loads the page via the `web` hostname, not a name a sibling service could share safely).

`app/control/[sessionId]/page.tsx` + `components/control-panel.tsx` is the touchscreen UI itself — a server-fetched list of the session owner's `Dataset`s and completed `ScraperRun`s rendered as large buttons, each sending `SHOW_VIEW` over the WS connection on tap. `components/present-live-reload.tsx` is the presentation route's half: a side-effect-only client component that calls `router.refresh()` on any `STATE` message, closing the Phase 6 gap where a view switch needed a manual reload. Both routes are unauthenticated, same reasoning and same capability-token pattern as `/present/[sessionId]` itself (docs/07-zoom-bot.md) — the Pi's kiosk browser has no login session either.

**Verified for real**, via Playwright driving headless system Chrome against the live Docker Compose stack: opened `/present/[id]` (showing the idle placeholder) and `/control/[id]` (showing "connected") in two separate tabs, tapped a dataset button on the control tab, and confirmed the presentation tab's table appeared **without any navigation** — same URL before and after, DOM updated in place via `router.refresh()`. Confirmed the resulting `AuditLog` row in Postgres (`metadata: {"via": "websocket"}`, distinguishing it from Phase 6's manual Server-Action-triggered switches). All test data removed after.

**Real infra/build issues found and fixed while wiring this up**, not assumed:
1. Co-locating `ws-server.ts` with Next meant `tsx`/`ws` needed to be present at container *runtime*, which the app's existing `output: "standalone"` build (a pruned bundle tracing only what Next's own request handling imports) doesn't include. Fix: dropped `output: "standalone"` and switched the Docker runner stage to ship the full `node_modules` from the `builder` stage instead — see `docs/11-deployment.md`'s updated `web` service description for the tradeoff.
2. The container ran out of disk (`ENOSPC`) partway through this work — a genuine host-level issue (Docker had accumulated ~56GB of dangling images/build cache across other projects on the same machine), not a bug in this app; resolved with `docker image prune`/`docker builder prune` after checking with the project owner first, since pruning affects the whole host, not just this project.
3. `docker-entrypoint.sh` initially ran `pnpm exec next start`/`pnpm exec tsx ws-server.ts`. `pnpm exec` runs pnpm's own dependency-status check first, which tries to write temp files into `/app` — but `/app` is root-owned (created during the Dockerfile's `COPY` steps, which run as root at build time) while the container itself runs as a non-root uid (`docker-compose.yml`'s `user:`), so every start failed with `EACCES` before either process actually launched. Fixed by invoking `node_modules/.bin/next`/`node_modules/.bin/tsx` directly, bypassing pnpm entirely at runtime — restores the same "no package-manager involvement at container startup" property the old `node server.js` entrypoint had.
4. `tsx`'s `@/*` path-alias resolution (used by `lib/prisma.ts`) needs `tsconfig.json` present at runtime — missed on the first pass of trimming down what the Dockerfile's runner stage copies; added back once the resulting `MODULE_NOT_FOUND` traced to it being absent.

**Not yet built:** the actual physical Raspberry Pi kiosk setup (pointing a real Pi's browser at `/control/[sessionId]` in kiosk mode) — the web-side control surface is done and proven; wiring an actual physical Pi is a deployment/hardware step, not a code one, and hasn't been done since there's no Pi attached to this dev environment.
