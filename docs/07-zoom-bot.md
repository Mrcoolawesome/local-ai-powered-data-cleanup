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

**v1 gap, stated rather than silently deferred:** the route has no live-update mechanism of its own yet — switching the active view requires a reload to see it on `/present/[sessionId]`, which is exactly what docs/08's WebSocket layer (Phase 7) exists to replace, and is explicitly scoped to Phase 7 in `docs/09-roadmap.md`, not built early here.

**Also closed a pre-existing gap while here:** `AuditLog` was documented (`docs/02-data-model.md`) since Phase 1 as "every mutating action... writes here" but was never actually implemented in `schema.prisma` until this phase. It's implemented now and used by the new `PresentationSession` actions above; retrofitting every earlier phase's mutating action to also write here is real follow-up work, not done in this pass (scoped out to keep this phase bounded to what it actually needed — noted in the model's own doc comment in `schema.prisma`).

**Not yet done — needs the project owner, same as the Phase 0 spike did:** productionizing the Zoom Bot Service itself (pointing its Chromium at a real `/present/[sessionId]` URL instead of the spike's static test page, parameterizing the meeting/session config, packaging it as a restartable service) is next. The actual "join a live meeting and confirm the real presentation route shares correctly" validation step needs a live meeting the same way the original spike did — that can't be run unattended.
