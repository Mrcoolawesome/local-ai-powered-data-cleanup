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

**Status: DONE. Ran against a real, live Zoom meeting — the bot joined, shared, and the project owner (present in the meeting) visually confirmed seeing the live-updating test page. This is the actual question the whole spike existed to answer, and it's answered: yes, this works.**

The Zoom Meeting SDK for Linux (`zoom-meeting-sdk-linux_x86_64-7.1.5.4432`) is in `zoom-sdk/` (gitignored — proprietary, ~330MB extracted). Everything here was written against its **real headers**, not guessed — see the comment block at the top of `zoom-sdk-integration/join_and_share.cpp` for exactly which header confirmed which API shape.

### The real run, end to end

1. `InitSDK` → `CreateAuthService` → JWT-signed `SDKAuth()` — **succeeded** with real SDK Key/Secret from the project owner's Zoom Marketplace app.
2. `Join()` with the real meeting number + passcode → `onMeetingStatusChanged` reported `MEETING_STATUS_INMEETING` — **the bot was a live participant in a real Zoom meeting.**
3. `GetMeetingShareController()->StartAppShare()` against the real X11 window handle (found live via `xdotool search` against the Xvfb display, see `run-integration-test.sh`):
   - First attempt: `SDKERR_NO_PERMISSION` — the meeting's "who can share" setting didn't allow a non-host participant to share. Fixed on the Zoom account side (Settings → In Meeting (Basic) → Screen sharing), not a code change.
   - After the fix: **`SDKERR_SUCCESS`**, `onSharingStatus` fired, and the project owner confirmed seeing the test page's clock/tick counter live and updating in the meeting.

### Two real, non-obvious build issues — worth knowing if this is ever rebuilt on different hardware

1. `libmeetingsdk.so`'s embedded `DT_SONAME` is `libmeetingsdk.so.1`, but the file Zoom ships is named `libmeetingsdk.so` (no version suffix) — the dynamic loader looks for the SONAME, not the filename. Fix: a symlink `libmeetingsdk.so.1 → libmeetingsdk.so` inside `zoom-sdk/` (not committed — recreate it if you re-extract the SDK: `ln -sf libmeetingsdk.so zoom-sdk/libmeetingsdk.so.1`).
2. Linking our own `QCoreApplication` against the **system** Qt6 while also loading `libmeetingsdk.so`'s **bundled** Qt6 caused `undefined symbol ... version Qt_6_PRIVATE_API` at runtime — two different Qt6 builds both claiming to provide `libQt6Core.so.6` in the same process, first-loaded-wins, and the bundled Qt6Gui/Qml/Quick/DBus libraries then can't find the private-ABI symbols they expect from *their own* Qt6Core build. Fixed by linking the SDK's own bundled `qt_libs/Qt/lib/libQt6Core.so.6` instead of system Qt6 (see `CMakeLists.txt` — system Qt6 *headers* are still fine to compile against; only the *linked runtime lib* had to match the SDK's bundle).
3. A handful of transitive runtime libs (`libatomic1`, `libxcb-cursor0`, `libxcb-xtest0`, `libxkbcommon-x11-0`, `libnss3`) aren't pulled in automatically and have to be installed explicitly — see `zoom-sdk-integration/Dockerfile.integration-test`, which is the known-working environment.

### Reproducing this run

```bash
cd zoom-sdk-integration
docker build -f Dockerfile.integration-test -t zoom-spike-integration .
docker run --rm --shm-size=512m -v "$(cd .. && pwd)":/work zoom-spike-integration \
  bash -c 'ln -sf libmeetingsdk.so ../zoom-sdk/libmeetingsdk.so.1 && bash ./run-integration-test.sh'
```

Needs a filled-in `zoom-sdk-integration/.env` (copy `.env.example` — real SDK Key/Secret from the Meeting SDK feature on your Zoom Marketplace app, not OAuth credentials) and a meeting you're actively hosting live, since `run-integration-test.sh` does a real join.

**Open item, not for this spike but for Phase 6 (production build-out):** the working config here relies on an anonymous `SDK_UT_WITHOUT_LOGIN` join plus a permissive account-wide screen-sharing setting. Decide then whether to keep that, or have the production bot join as an authenticated user with standing host/co-host privileges instead (more restrictive by default, doesn't depend on an account-wide setting staying correctly configured).

## Gitignored in this folder

`zoom-sdk/` (the proprietary SDK download — must never be committed, both for size and Zoom's own distribution terms), `zoom-sdk-integration/build/` and `.env` (build output and real credentials), and `output/` (spike screenshots — regenerable, not meaningful to keep in history).
