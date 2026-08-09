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
