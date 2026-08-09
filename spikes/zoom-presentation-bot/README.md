# Zoom Presentation Bot — Phase 0 Spike

Validates the design in [`/docs/07-zoom-bot.md`](../../docs/07-zoom-bot.md) before it's on the critical path. Two independent halves — build/test them separately, because they fail for completely different reasons.

## Stage 1 — Xvfb + Chromium render a live page headlessly

**Status: done, tested, passing.**

```bash
docker build -t zoom-spike-xvfb .
mkdir -p output
docker run --rm --shm-size=512m -v "$(pwd)/output:/app/output" zoom-spike-xvfb
```

What it does: boots `Xvfb :99`, serves `test-page/index.html` (a page with a live clock + tick counter, specifically so a frozen frame is visually obvious) over local HTTP, opens it in headless Chromium against the virtual display, and takes two screenshots a few seconds apart. It diffs them with ImageMagick's `compare -metric AE` — a nonzero pixel-difference count proves the page was actively re-rendering, not a static capture.

**Actual result from the last run:** `1961` differing pixels between the two captures — the clock/tick counter visibly advanced. `screenshot-1.png`/`screenshot-2.png` in `output/` are the real captures (gitignored — regenerate by rerunning, don't rely on stale screenshots).

This proves the presentation-route half of the design ([docs/01-architecture.md](../../docs/01-architecture.md)'s "live presentation" data flow) — headlessly rendering and continuously updating a web view — works on this hardware/software combination.

## Stage 2 — Zoom Linux Meeting SDK join + `startShareView` — NOT YET RUNNABLE

**Status: skeleton only. This is the part that actually answers "can we do this."**

I can't complete or run this stage myself: the Zoom Meeting SDK for Linux is a proprietary download gated behind an authenticated Zoom Marketplace developer account, and there's no public API to fetch it. This has to happen on your end.

### What you need to obtain

1. **A Zoom Marketplace "General App" with Meeting SDK enabled.** Sign in at [marketplace.zoom.us](https://marketplace.zoom.us) → Develop → Build App → General App → enable the "Meeting SDK" feature. This gives you an **SDK Key** and **SDK Secret**.
2. **The Linux Meeting SDK package itself**, downloaded from the same developer portal (Meeting SDK → Download → Linux). It ships as a `.tar.gz` containing `.so` libraries and C++ headers — there is no official Python/Node binding, so the join/share code has to be C++ (or wrapped via a thin C++ shim called from Python, if we want the rest of the bot service in Python to match the FastAPI stack).
3. A **test Zoom meeting** to join against (a personal meeting ID you control, so joining/leaving repeatedly doesn't bother anyone).

### What to do once you have those

1. Drop the extracted SDK into `zoom-sdk/` in this folder (gitignored — see below).
2. Fill in `zoom-sdk-integration/join_and_share.cpp` (skeleton below) with real `InitSDK` → `Auth` (JWT signed with your SDK key/secret) → `Join` → get the meeting's sharing controller → `startShareView` against the Xvfb display's window handle.
3. Build against the SDK's `CMakeLists.txt` pattern from Zoom's own Linux sample app (included in the SDK download — reuse its build setup rather than reinventing it).
4. Run stage 1's Xvfb+Chromium container, get its X11 socket exposed to the SDK build (same `DISPLAY`), run the join/share binary, and have a human sit in the test meeting to confirm the shared view is visible and live (same "does the clock keep advancing" check as stage 1).

### `zoom-sdk-integration/join_and_share.cpp` (skeleton, will not compile without the real SDK)

```cpp
// SKELETON — requires the real Zoom Linux Meeting SDK headers/libs, which are
// not present in this repo. Fill in against Zoom's own sample app patterns
// once the SDK tarball (see README "What you need to obtain") is available.
//
// #include "zoom_sdk.h"
// #include "meeting_service_interface.h"
// #include "meeting_share_interface.h"
//
// int main() {
//     // 1. InitSDK — one-time SDK initialization.
//     // 2. Auth — JWT signed with SDK key/secret from your Marketplace app.
//     // 3. Join — meeting number + password from the target meeting link.
//     // 4. Once IN_MEETING: get IMeetingShareController from the meeting
//     //    service, and call StartShareView (or the equivalent share-view
//     //    call in the SDK version you download — method names have
//     //    changed across SDK versions, verify against your copy's headers)
//     //    passing the Xvfb display's window handle (from stage 1's :99
///    //    display — use `xdotool search` or XQueryTree to get the actual
//     //    window ID of the Chromium window, not the whole display).
//     // 5. Watch for share-start/share-stop callbacks to confirm success
//     //    rather than assuming the call succeeded.
// }
```

### Success criteria for this stage

A human sitting in the test meeting sees the same live-updating test page from stage 1, shared continuously for several minutes, without the bot disconnecting or the share silently dropping. If that fails or proves unreliable, fall back per [docs/07-zoom-bot.md](../../docs/07-zoom-bot.md)'s fallback section (virtual webcam device, or the Zoom Browser SDK instead of native).

## Gitignored in this folder

`zoom-sdk/` (the proprietary SDK download itself — must never be committed, both for size and Zoom's own distribution terms) and `output/` (spike screenshots — regenerable, not meaningful to keep in history).
