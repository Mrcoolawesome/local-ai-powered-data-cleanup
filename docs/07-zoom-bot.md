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

## Phase 0 spike status

Spike lives in [`/spikes/zoom-presentation-bot`](../spikes/zoom-presentation-bot/README.md), split into two stages that fail for different reasons:

- **Stage 1 (Xvfb + Chromium render a live page headlessly) — done, tested, passing.** Built and actually run in a Docker container: two screenshots taken a few seconds apart differed by ~2,000 pixels, confirming the page was live-updating (a clock/tick counter), not a frozen frame. This validates the presentation-route half of the design.
- **Stage 2 (Zoom Linux Meeting SDK join + `startShareView`) — blocked on credentials only the project owner can obtain.** The Linux Meeting SDK is a proprietary download gated behind an authenticated Zoom Marketplace developer account (a "General App" with Meeting SDK enabled, giving an SDK Key/Secret, plus the SDK tarball itself). A C++ skeleton with the exact join/auth/share steps is in place at `zoom-sdk-integration/`, but it cannot compile or run until that SDK is downloaded and dropped in. **This is the actual open question this spike exists to answer** — proceed with native design vs. fall back — and it's still open pending that download.

Success criteria for stage 2, once runnable: a human in a real test meeting sees the same live-updating test page shared continuously for several minutes without the bot disconnecting or the share dropping.
