// Zoom Linux Meeting SDK join + native screen-share skeleton.
//
// This will NOT compile as-is — it needs the real Zoom Linux Meeting SDK
// headers/libs, which are a proprietary download gated behind an
// authenticated Zoom Marketplace developer account. See ../README.md
// ("What you need to obtain") for how to get them and what to fill in here.
//
// Fill this in against the sample app bundled with the SDK download —
// method names and callback signatures have changed across SDK versions,
// so treat this file as a checklist of steps, not a source of truth for
// exact API calls.

// #include "zoom_sdk.h"
// #include "auth_service_interface.h"
// #include "meeting_service_interface.h"
// #include "meeting_share_interface.h"

// TODO(step 1): InitSDK — one-time SDK initialization. Do this once at
// process startup, not per meeting.

// TODO(step 2): Auth — build a JWT signed with the SDK Key/Secret from the
// Zoom Marketplace app (docs/07-zoom-bot.md's "General App" setup), call
// the SDK's Auth() with it, and wait for the auth-success callback before
// attempting to join anything.

// TODO(step 3): Join — parse the meeting number + password out of the Zoom
// meeting link the app receives, call the SDK's Join() with them. Join as
// a silent participant (camera/mic off) per docs/01-architecture.md's
// "live presentation" flow.

// TODO(step 4): Once the meeting-status callback reports IN_MEETING, get
// the IMeetingShareController from the meeting service and start sharing
// the Xvfb display's window. This is the actual unknown this spike exists
// to answer — do NOT assume the window handle format; get the real window
// ID of the Chromium window on :99 via `xdotool search --name <title>` or
// XQueryTree, not the raw X11 display number.

// TODO(step 5): Register for the share-start/share-stop callbacks and log
// them — don't assume the share call succeeding means the share is actually
// visible to meeting participants. Have a human in the test meeting confirm.

int main() {
    // See TODOs above — this is intentionally unimplemented until the real
    // SDK is available locally.
    return 1;
}
