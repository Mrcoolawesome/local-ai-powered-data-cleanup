# Live Presentation Zoom Bot

**Status: fully validated. The bot joined a real, live Zoom meeting and natively shared the Xvfb/Chromium test page — a human in the meeting visually confirmed seeing it live and updating.** This was the highest-risk item in the whole spec and it's now closed. See "Phase 0 spike status" below for the actual run results.

## Why this is the risky one

- Native Zoom Meeting SDK for Linux + `Xvfb` + `startShareView` targeting a virtual display's window handle is a narrow, sparsely-documented integration path compared to the much more common browser-SDK or RTMP approaches.
- "100% free" needs verification against current Zoom App Marketplace terms for a Linux Meeting SDK app at whatever usage level this ends up at — sandbox/dev tiers and production usage limits are not the same thing.
- Headless Linux native SDK builds have historically been sensitive to specific GPU/driver/library versions. This needs to be proven on the actual target hardware, not assumed from documentation.

## Validated design

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

## Fallback plan (not needed — kept for reference)

The native path worked, so none of this was exercised. Keeping it recorded in case a future SDK upgrade or hosting environment change ever regresses native sharing:

- **Virtual webcam fallback:** render the same Xvfb/Chromium output through a virtual video device (e.g. `v4l2loopback`) and join Zoom as a participant sharing that as a camera feed, or via a more conventional screen-share permission flow instead of the native `startShareView` call.
- **Browser-SDK fallback:** if the Linux native SDK proves too fragile, the Zoom Web/Browser SDK running inside the same headless Chromium could join and share, trading "fully native" for "more proven path."

## Phase 0 spike status — RESULT: fully working, visually confirmed

Spike lives in [`/spikes/zoom-presentation-bot`](../spikes/zoom-presentation-bot/README.md). Both stages ran for real, against a live meeting the project owner hosted:

- **Stage 1 (Xvfb + Chromium render a live page headlessly) — done, passing.** Two screenshots a few seconds apart differed by ~2,000 pixels, confirming the page was live-updating, not a frozen frame.
- **Stage 2 (Zoom Linux Meeting SDK join + `StartAppShare`) — done, passing, visually confirmed.** `join_and_share.cpp`, written against the real SDK headers, ran the full pipeline against Zoom's production servers: `InitSDK` → JWT-signed `SDKAuth` → `Join` with a real meeting number + passcode → **`onMeetingStatusChanged` reported `MEETING_STATUS_INMEETING`** (the bot was a live participant) → `GetMeetingShareController()->StartAppShare()` against the real X11 window handle (found live via `xdotool` against the Xvfb display).
  - First attempt returned `SDKERR_NO_PERMISSION` (SDKError 12) — the meeting's "who can share" setting didn't allow a non-host participant to share. Not a code issue; fixed by the project owner adjusting the Zoom account's screen-sharing permission (Settings → In Meeting (Basic) → Screen sharing → "Who can share?").
  - Rerun after that fix: **`StartAppShare` returned `SDKERR_SUCCESS`**, `onSharingStatus` fired, and **the project owner, present in the meeting, confirmed seeing the live-updating test page (clock + tick counter) shared in real time.** This is the exact success criterion this whole spike existed to prove.

**Decision: proceed with the native design as specced.** No fallback needed.

**Two real build/runtime issues were found and fixed along the way** (documented in detail in `/spikes/zoom-presentation-bot/README.md` and `zoom-sdk-integration/CMakeLists.txt`), useful if this is ever rebuilt on different hardware: the SDK's shipped filename doesn't match its embedded `SONAME` (needs a symlink), and linking against the system's Qt6 instead of the SDK's bundled Qt6 causes a private-ABI symbol mismatch at runtime (must link the SDK's own bundled `libQt6Core.so.6`).

**Open item for Phase 6 (production build-out, not this spike):** the working join here uses an anonymous `SDK_UT_WITHOUT_LOGIN` join plus a permissive account-wide sharing setting. Decide then whether production should keep that account-wide permission change, or instead have the bot join as an authenticated user with standing host/co-host privileges — the latter is more restrictive-by-default and doesn't depend on a global account setting staying correctly configured.

## Phase 6 build status

**`/present/[sessionId]` route — built and tested end-to-end for real**, though not yet against the actual Zoom bot/live meeting (that needs the project owner's participation the same way the Phase 0 spike did — see below). `PresentationSession` (new Prisma model, `docs/02-data-model.md`) tracks what's live; the route reads it and renders either a `DATASET` view (parses the `Dataset`'s `cleaned.csv` with a small dependency-free CSV parser, `lib/csv.ts`, and renders a plain table) or an `ATTACHMENTS` view (an image/file grid, served through a new unauthenticated `app/api/attachments/[id]/route.ts`). Verified via Playwright driving headless system Chrome against the live Docker Compose stack: created a session through the new `/presentations` control UI, pointed it at a real dataset and a real scraper run's attachments in turn, and confirmed both renders — the CSV table showed the right headers/rows, the attachment endpoint served the right bytes with the right content-type for each file. Every `AuditLog` write (session create, each view switch) was confirmed in Postgres with the right `metadata`. All test data removed after.

**Route is deliberately unauthenticated** — both `/present/[sessionId]` and `/api/attachments/[id]` skip the normal `auth()` session check, since the Zoom bot's headless Chromium has no interactive login to present. The unguessable `cuid()` id itself is the route's authorization (same tradeoff as any capability-URL design); both routes are read-only, so the blast radius of an id leaking is "view one session's current slide" or "view one file," not broader account access. Documented here rather than left as an unexplained gap, since skipping auth on a route is exactly the kind of decision that needs its reasoning on record.

**Update, Phase 7:** the reload gap noted below is closed — see `docs/08-raspberry-pi-controller.md`'s "Build status." `/present/[sessionId]` now updates in place via `components/present-live-reload.tsx` subscribing to `ws-server.ts`, verified for real (Playwright: a control-page button tap updated the presentation tab's DOM with no navigation, same URL before/after).

**Also closed a pre-existing gap while here:** `AuditLog` was documented (`docs/02-data-model.md`) since Phase 1 as "every mutating action... writes here" but was never actually implemented in `schema.prisma` until this phase. It's implemented now and used by the new `PresentationSession` actions above; retrofitting every earlier phase's mutating action to also write here is real follow-up work, not done in this pass (scoped out to keep this phase bounded to what it actually needed — noted in the model's own doc comment in `schema.prisma`).

**Zoom Bot Service productionized — built and compiled for real against the actual proprietary SDK, full orchestration verified end-to-end except the live join itself.** Lives at `apps/zoom-bot-service/` (source adapted from the validated spike, logic unchanged — see the file's own header comment for exactly what did and didn't change). Key differences from the spike, everything else identical to the proven design:

- Chromium now loads a real, live `/present/[sessionId]` URL (`PRESENT_URL` env var) instead of the spike's static test page.
- Window-finding no longer matches a fixed page `<title>` (the real route has no unique per-session title) — `start.sh` finds "the one window on this X11 display" instead, which is more robust for production anyway since Chromium is deliberately the only GUI app running there.
- The proprietary SDK is bind-mounted at container runtime (`docker-compose.yml`'s `zoom-bot` service, `profiles: ["zoom-bot"]` so it never starts by default), not `COPY`ed into the image — keeps the "never redistribute" rule from `spikes/zoom-presentation-bot/README.md` intact even for a built image, at the cost of a few seconds' `cmake`/`make` on every container start (`start.sh`) rather than a pre-built binary.

**Verified for real, in this order:**
1. `docker compose --profile zoom-bot build zoom-bot` — image builds cleanly (OS deps, no SDK baked in).
2. Compiled `apps/zoom-bot-service` against the real bind-mounted SDK (`cmake`/`make` inside the built image) — links and produces a working binary, same as the spike's proven build.
3. Ran the compiled binary directly with dummy credentials — `InitSDK` → `CreateAuthService` → `SDKAuth()` all resolved and executed (proving the dynamic linking against `libmeetingsdk.so` + its bundled Qt6 works at *runtime*, not just link time — the exact thing the spike's two build issues were about), `onAuthenticationReturn` correctly fired with `AUTHRET_JWTTOKENWRONG` for the bad dummy key.
4. **Found a real bug this way, not assumed:** after logging the auth failure, the process **segfaulted** during shutdown (`QCoreApplication::exit(1)` unwinding `app.exec()`, falling off `main()`, then crashing in static/global destruction — inside the vendor SDK's own teardown, not this file's own state). This is a code path the original spike's live run never took, since that run authenticated successfully on the first real attempt. **Fixed** by calling `std::_Exit(1)` directly on both SDK-init-failure paths instead of the `QCoreApplication::exit()`-then-fall-off-`main()` route — skips C++ static destruction and any SDK `atexit` handlers entirely, deliberate for an already-erroring-out process. Rebuilt and reran with the same dummy credentials: **clean exit code 1, no crash.**
5. Ran the full `start.sh` orchestration (`docker compose --profile zoom-bot run --rm zoom-bot` with dummy Zoom credentials but a real `PRESENT_URL` pointed at the actual running `web` service over the compose network) end-to-end: Xvfb booted, Chromium loaded the real URL, `xdotool` found its window (`Window ID: 2097155`), the `ZOOM_SHARE_X_WINDOW_HANDLE` string was built correctly, the binary launched, attempted `SDKAuth()`, and exited cleanly on the expected bad-credential failure — no crash, no orphaned processes.

**Not yet done — needs the project owner, same as the Phase 0 spike did:** the actual "join a live meeting with real credentials and confirm the real presentation route shares correctly" validation step. Everything up to that point — build, compile, link, runtime SDK loading, the full Xvfb/Chromium/window-detection orchestration against a real live route — is now proven; only the live-meeting join itself remains, and that can't be run unattended the same way the original spike's final validation couldn't.

## Meeting ID/passcode moved to the UI, not .env

Originally `ZOOM_MEETING_NUMBER`/`ZOOM_MEETING_PASSWORD` were deployment env vars — wrong shape, since a meeting number is a per-presentation fact (a different meeting every time someone presents), not a deployment secret like `ZOOM_SDK_KEY`/`ZOOM_SDK_SECRET` (the same Marketplace app credentials for every meeting this app ever joins). Fixed:

- `PresentationSession.zoomMeetingId`/`zoomMeetingPassword` (new `zoomMeetingPassword` column, migration `20260810153946_presentation_session_zoom_meeting`) — set through a "Zoom meeting" form on `/presentations/[id]`. The meeting ID is validated as numeric before saving (`join_and_share.cpp` passes it straight to `std::stoull`, so a bad value would otherwise crash the bot instead of failing with a clear error at the point someone actually made the mistake).
- `GET /api/presentations/[id]/zoom-meeting` — unauthenticated like `/present`/`/control`/`/api/attachments` (same capability-token reasoning: the Zoom Bot Service has no login session either), returns `{meetingId, meetingPassword}` or a 422 `{error}` if no meeting ID has been set yet for that session.
- `start.sh` derives both the session id and the web app's base URL from `PRESENT_URL` itself (its own last path segment, and everything before `/present/`) — no new env var needed, since `PRESENT_URL` already has to name the session. Fetches the meeting ID/passcode from the endpoint above before building the SDK-auth JWT.

**Verified for real**, same rigor as the rest of this file: created a real `PresentationSession` and confirmed `GET .../zoom-meeting` returned a 422 with a clear error before any meeting ID was set; saved a meeting ID/passcode through the actual `/presentations/[id]` UI (Playwright) and confirmed it persisted across a reload and that the endpoint then returned it correctly; confirmed the non-numeric-meeting-ID validation actually rejects bad input. Ran `start.sh`'s exact fetch logic against the live `web` service over the real compose network and confirmed both the success and error paths.

**Found a real bug this way**, not assumed: the first version used `curl -f`, which suppresses the response body on a 4xx/5xx status — meaning the 422 `{"error": ...}` body (exactly the case worth surfacing to whoever's running the bot) was silently discarded, and `start.sh` would have printed a generic "could not reach the endpoint" instead of "no meeting ID set for this session." Fixed by dropping `-f` and checking the response is valid JSON instead (a transport-level failure still produces an empty/non-JSON body, still caught) — reran both the success and error paths afterward to confirm.
