import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ControlPanel } from "@/components/control-panel";

// Deliberately unauthenticated, same reasoning as app/present/[sessionId]/page.tsx
// — the Pi's kiosk-mode browser has no interactive login session either.
// The session id is the capability token; this route's only mutation path
// is "switch this session's active view," scoped through ws-server.ts's
// own ownership check on every SHOW_VIEW message, not through this page.
export default async function ControlPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;

  const session = await prisma.presentationSession.findUnique({ where: { id: sessionId } });
  if (!session) notFound();

  const [datasets, scraperRuns] = await Promise.all([
    prisma.dataset.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
    prisma.scraperRun.findMany({
      where: { scraperDefinition: { userId: session.userId }, status: "COMPLETED" },
      orderBy: { startedAt: "desc" },
      include: { scraperDefinition: { select: { platformName: true } } },
    }),
  ]);

  return (
    <ControlPanel
      sessionId={sessionId}
      wsPort={process.env.WEB_WS_PORT || "3001"}
      initialActiveViewKind={session.activeViewKind}
      initialActiveDatasetId={session.activeDatasetId}
      initialActiveScraperRunId={session.activeScraperRunId}
      datasets={datasets}
      scraperRuns={scraperRuns.map((r) => ({
        id: r.id,
        label: `${r.scraperDefinition.platformName} · ${r.startedAt.toLocaleDateString()}`,
      }))}
    />
  );
}
