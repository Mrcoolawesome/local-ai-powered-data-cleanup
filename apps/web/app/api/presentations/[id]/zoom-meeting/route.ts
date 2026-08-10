import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Deliberately unauthenticated, same reasoning as app/present/[sessionId]/page.tsx
// and app/api/attachments/[id]/route.ts — the Zoom Bot Service's start.sh
// (docs/07-zoom-bot.md) calls this at container startup with no interactive
// login session to present, and the session id is already the capability
// token used everywhere else this app is reached without one. This is the
// one exception among those routes in that it returns a secret (the
// meeting passcode) rather than just view content — still fine under the
// same threat model (docs/06-security-sandboxing.md): this is an internal
// tool, the id is an unguessable cuid never listed publicly, and the value
// returned is a Zoom meeting passcode, not an account credential.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await prisma.presentationSession.findUnique({
    where: { id },
    select: { zoomMeetingId: true, zoomMeetingPassword: true },
  });
  if (!session) return new NextResponse("Not found", { status: 404 });

  if (!session.zoomMeetingId) {
    return NextResponse.json(
      { error: "No Zoom meeting ID set for this session — set one at /presentations/[id] first." },
      { status: 422 }
    );
  }

  return NextResponse.json({
    meetingId: session.zoomMeetingId,
    meetingPassword: session.zoomMeetingPassword ?? "",
  });
}
