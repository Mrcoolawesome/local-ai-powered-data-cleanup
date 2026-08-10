import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { readStorageFileText } from "@/lib/storage";
import { parseCsv } from "@/lib/csv";

// Deliberately unauthenticated (docs/07-zoom-bot.md) — this route is
// rendered inside the Zoom Bot Service's headless Chromium, which has no
// interactive login session to present. The PresentationSession id itself
// (an unguessable cuid, never exposed in any list the general app UI
// shows to other users) is the route's authorization — same pattern as
// app/api/attachments/[id]/route.ts. Read-only: this route never mutates
// anything, so the tradeoff is "knowing a session id shows its current
// view," not broader account access. No revalidation loop of its own yet
// — Phase 7's WebSocket layer (docs/08-raspberry-pi-controller.md) is what
// replaces "reload to see a view change" with a live in-place update; this
// phase's route intentionally still needs a reload to pick up a new
// activeView, stated here rather than silently assumed away.
export default async function PresentPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;

  const session = await prisma.presentationSession.findUnique({
    where: { id: sessionId },
    include: {
      activeDataset: true,
      activeScraperRun: { include: { attachments: { orderBy: { createdAt: "desc" } } } },
    },
  });
  if (!session) notFound();

  return (
    <main className="h-dvh w-dvw overflow-auto bg-white p-6 text-black">
      {session.activeViewKind === "DATASET" && session.activeDataset && (
        <DatasetView datasetId={session.activeDataset.id} filePath={session.activeDataset.filePath} name={session.activeDataset.name} />
      )}

      {session.activeViewKind === "ATTACHMENTS" && session.activeScraperRun && (
        <AttachmentsView attachments={session.activeScraperRun.attachments} />
      )}

      {!session.activeViewKind && (
        <div className="flex h-full items-center justify-center text-2xl text-gray-400">
          Waiting for a view to be selected&hellip;
        </div>
      )}
    </main>
  );
}

async function DatasetView({ filePath, name }: { datasetId: string; filePath: string | null; name: string }) {
  if (!filePath) {
    return <div className="text-2xl text-gray-400">{name} hasn&apos;t been cleaned yet.</div>;
  }

  const text = await readStorageFileText(filePath);
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header) return <div className="text-2xl text-gray-400">{name} is empty.</div>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold">{name}</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {header.map((col, i) => (
              <th key={i} className="border-b-2 border-gray-300 px-3 py-2 text-left font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i} className="odd:bg-gray-50">
              {row.map((cell, j) => (
                <td key={j} className="border-b border-gray-200 px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttachmentsView({
  attachments,
}: {
  attachments: { id: string; filePath: string; jobId: string | null; customerId: string | null }[];
}) {
  if (attachments.length === 0) {
    return <div className="text-2xl text-gray-400">No attachments in this run.</div>;
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      {attachments.map((a) => (
        <div key={a.id} className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from a local Node route, not next/image's remote optimizer */}
          <img src={`/api/attachments/${a.id}`} alt={a.filePath} className="aspect-square w-full rounded-md object-cover" />
          <p className="truncate text-xs text-gray-500">{a.jobId || a.customerId || a.filePath}</p>
        </div>
      ))}
    </div>
  );
}
