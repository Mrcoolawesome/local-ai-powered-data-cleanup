# Live Presentation Zoom Bot

**Status: spiked end-to-end against a real, live Zoom meeting. The native join+share mechanism is proven to work — the only remaining item is a Zoom account/meeting permission setting, not a technical blocker.** See "Phase 0 spike status" below for the actual run results.

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

## Phase 0 spike status — RESULT: native join+share works; sharing is blocked by a Zoom permission setting

Spike lives in [`/spikes/zoom-presentation-bot`](../spikes/zoom-presentation-bot/README.md). Both stages ran for real, against a live meeting the project owner hosted:

- **Stage 1 (Xvfb + Chromium render a live page headlessly) — done, passing.** Two screenshots a few seconds apart differed by ~2,000 pixels, confirming the page was live-updating, not a frozen frame.
- **Stage 2 (Zoom Linux Meeting SDK join + `StartAppShare`) — the bot actually joined a real, live meeting.** `join_and_share.cpp`, written against the real SDK headers, ran the full pipeline against Zoom's production servers: `InitSDK` → JWT-signed `SDKAuth` (succeeded with real SDK Key/Secret) → `Join` with the real meeting number + passcode → **`onMeetingStatusChanged` reported `MEETING_STATUS_INMEETING`** — i.e. the bot was a live participant in a real Zoom meeting. It then called `GetMeetingShareController()->StartAppShare()` against the real X11 window handle (found live via `xdotool` against the Xvfb display) and got back **`SDKERR_NO_PERMISSION`** (SDKError 12, per `zoom_sdk_def.h`'s own `SDKError` enum) — the meeting's "who can share" setting doesn't currently allow this anonymous, not-logged-in bot participant to share.

**This is not a technical blocker.** Every mechanical piece — SDK init, auth, live network join, finding the right window, calling the share API with the correctly-formatted handle — works. What's needed to close this out:
- Set the meeting/account's screen-share permission (Zoom web portal → Settings → In Meeting (Basic) → Screen sharing → "Who can share?") to allow participants, not just the host, **or**
- Have the bot join as an authenticated user with host/co-host privileges instead of the current anonymous `SDK_UT_WITHOUT_LOGIN` join, **or**
- Have the meeting host manually promote the bot to co-host after it joins (impractical for unattended production use, fine for finishing this spike).

Once one of those is in place, rerun `spikes/zoom-presentation-bot/zoom-sdk-integration/run-integration-test.sh` (or the Docker-wrapped version in its README) against a live meeting — success criteria: a human in the meeting sees the live-updating test page shared continuously for several minutes without the bot disconnecting or the share dropping.

**Two real build/runtime issues were found and fixed along the way** (documented in detail in `/spikes/zoom-presentation-bot/README.md` and `zoom-sdk-integration/CMakeLists.txt`), useful if this is ever rebuilt on different hardware: the SDK's shipped filename doesn't match its embedded `SONAME` (needs a symlink), and linking against the system's Qt6 instead of the SDK's bundled Qt6 causes a private-ABI symbol mismatch at runtime (must link the SDK's own bundled `libQt6Core.so.6`).
