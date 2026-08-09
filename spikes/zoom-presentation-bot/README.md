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

## Stage 2 — Zoom Linux Meeting SDK join + `StartAppShare`

**Status: compiles, links, and runs against the real SDK. `InitSDK` → `CreateAuthService` → JWT-signed `SDKAuth()` all verified working end-to-end against Zoom's actual auth servers (see "What's been proven" below). Only real credentials + a real test meeting are needed to get past auth and prove the actual join+share.**

The Zoom Meeting SDK for Linux (`zoom-meeting-sdk-linux_x86_64-7.1.5.4432`) is now in `zoom-sdk/` (gitignored — proprietary, ~330MB extracted). Everything in this section was written against its **real headers**, not guessed — see the comment block at the top of `zoom-sdk-integration/join_and_share.cpp` for exactly which header confirmed which API shape.

### What's been proven, concretely

- `join_and_share.cpp` **compiles and links** against the real SDK headers/libs (`cmake --build build` succeeds).
- **Two real, non-obvious build issues were hit and fixed** — worth knowing if this build ever needs redoing on different hardware:
  1. `libmeetingsdk.so`'s embedded `DT_SONAME` is `libmeetingsdk.so.1`, but the file Zoom ships is named `libmeetingsdk.so` (no version suffix) — the dynamic loader looks for the SONAME, not the filename. Fix: a symlink `libmeetingsdk.so.1 → libmeetingsdk.so` inside `zoom-sdk/` (not committed — recreate it if you re-extract the SDK: `ln -sf libmeetingsdk.so zoom-sdk/libmeetingsdk.so.1`).
  2. Linking our own `QCoreApplication` against the **system** Qt6 (6.10.2 here) while also loading `libmeetingsdk.so`'s **bundled** Qt6 caused `undefined symbol ... version Qt_6_PRIVATE_API` at runtime — two different Qt6 builds both claiming to provide `libQt6Core.so.6` in the same process, first-loaded-wins, and the bundled Qt6Gui/Qml/Quick/DBus libraries then can't find the private-ABI symbols they expect from *their own* Qt6Core build. Fixed by linking the SDK's own bundled `qt_libs/Qt/lib/libQt6Core.so.6` instead of system Qt6 (see `CMakeLists.txt` — we still use system Qt6 *headers* to compile against, since `QCoreApplication`'s public API is stable across Qt6 minor versions; only the *linked runtime lib* had to match the SDK's bundle).
- **Ran it.** With placeholder (non-real) credentials: `InitSDK` succeeded, `CreateAuthService` succeeded, the hand-rolled JWT builder (HMAC-SHA256 per `auth_service_interface.h`'s documented `{appKey, iat, exp, tokenExp}` payload) produced a request Zoom's real auth backend accepted and evaluated, and the async callback correctly reported `AUTHRET_JWTTOKENWRONG` — the *correct* rejection for a bad key, not a crash, timeout, or malformed-request error. That confirms the entire pipeline up to the auth boundary: SDK init, event-loop wiring, JWT construction, and live network round-trip to Zoom, all work on this hardware.

### What's still needed — from you, not me

1. **Real SDK Key + SDK Secret.** On your app's Zoom Marketplace dashboard, find "App Credentials" under the **Meeting SDK** feature (not the OAuth Client ID/Secret — those are a different feature and won't work here). Put them in `zoom-sdk-integration/.env` (copy `.env.example`, gitignored, never paste real values into chat).
2. **A test meeting number + password** you control.
3. **The actual window handle to share** — start stage 1's Xvfb (`./start-xvfb-chromium.sh`, or the container), then run `DISPLAY=:99 xdotool search --name Chromium` (or whatever the window title is) to get a real window ID, and format it per `.env.example`'s `ZOOM_SHARE_X_WINDOW_HANDLE`.

### Running it once you have those

```bash
cd zoom-sdk-integration
cmake -S . -B build && cmake --build build
set -a; source .env; set +a   # loads ZOOM_SDK_KEY etc. into the environment
./build/zoom_join_and_share
```

Have a human sit in the test meeting. Success criteria: they see the shared view live and updating, continuously, for several minutes, without the bot disconnecting or the share silently dropping. If that fails or proves unreliable, fall back per [docs/07-zoom-bot.md](../../docs/07-zoom-bot.md)'s fallback section (virtual webcam device, or the Zoom Browser SDK instead of native).

## Gitignored in this folder

`zoom-sdk/` (the proprietary SDK download — must never be committed, both for size and Zoom's own distribution terms), `zoom-sdk-integration/build/` and `.env` (build output and real credentials), and `output/` (spike screenshots — regenerable, not meaningful to keep in history).
