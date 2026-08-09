# Live Presentation Zoom Bot

**Status: highest-risk module in this spec. Treat everything below as a design to validate with a spike (Phase 0), not a confirmed working plan.** See [00-overview.md](./00-overview.md) for why.

## Why this is the risky one

- Native Zoom Meeting SDK for Linux + `Xvfb` + `startShareView` targeting a virtual display's window handle is a narrow, sparsely-documented integration path compared to the much more common browser-SDK or RTMP approaches.
- "100% free" needs verification against current Zoom App Marketplace terms for a Linux Meeting SDK app at whatever usage level this ends up at — sandbox/dev tiers and production usage limits are not the same thing.
- Headless Linux native SDK builds have historically been sensitive to specific GPU/driver/library versions. This needs to be proven on the actual target hardware, not assumed from documentation.

## Intended design (pending spike validation)

```
Zoom Bot Service (Linux, on the AI server or a dedicated box)
  │
  ├─ Xvfb :99                          — virtual framebuffer
  ├─ Chromium --display=:99            — loads /present/[sessionId] (Next.js route)
  └─ Zoom Linux Meeting SDK
        │
        ├─ join(meetingLink)           — joins as a silent participant
        └─ startShareView(xvfbHandle)  — shares the Xvfb display natively
```

- The presentation route (`/present/[sessionId]`) is a minimal, chrome-less Next.js page — no nav, no auth chrome, just the active `Dataset`/`Attachment` view. It subscribes to the same WebSocket channel the Raspberry Pi controller publishes to ([08-raspberry-pi-controller.md](./08-raspberry-pi-controller.md)), so DOM updates happen in place without a page reload — a reload would drop or visibly glitch the native share.
- The Zoom Bot Service is a distinct process/service from the FastAPI AI orchestration service — different lifecycle (long-running, holds a meeting connection), different failure modes (should be independently restartable without affecting the cleaning/audit pipeline).

## Fallback plan if native `startShareView` doesn't pan out

If the spike shows the native window-handle share path is unreliable on this hardware/SDK version:

- **Virtual webcam fallback:** render the same Xvfb/Chromium output through a virtual video device (e.g. `v4l2loopback`) and join Zoom as a participant sharing that as a camera feed, or via a more conventional screen-share permission flow instead of the native `startShareView` call.
- **Browser-SDK fallback:** if the Linux native SDK proves too fragile, the Zoom Web/Browser SDK running inside the same headless Chromium could join and share, trading "fully native" for "more proven path."

Either fallback keeps the rest of the architecture (presentation route, WebSocket-driven view switching) unchanged — only the join/share mechanism changes. This is why the presentation route and the Zoom-joining mechanism are kept as separate concerns above.

## Phase 0 spike scope

A minimal standalone script (not integrated into the main app) that: starts `Xvfb`, opens a static test page in Chromium against it, joins a real (test) Zoom meeting via the Linux Meeting SDK, and calls `startShareView` against the Xvfb handle. Success criteria: a human in the test meeting sees the static page shared continuously for several minutes without the bot disconnecting or the share dropping. This determines whether the rest of this document's design proceeds as written or moves to a fallback.
