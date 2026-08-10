// Realtime control server for the Pi controller + presentation route
// (docs/08-raspberry-pi-controller.md). Runs as a second process alongside
// `node server.js` in the same container (docker-entrypoint.sh) rather
// than in the Next.js request/response cycle itself — Next's generated
// standalone server.js isn't something this app owns the source of, so
// splicing a WebSocket upgrade handler into it isn't practical. Runs on
// its own port (WS_PORT), always co-located with `web` in the same
// container/hostname on purpose: both a host browser (via the published
// port) and the Zoom bot's Chromium (via compose-internal DNS to the
// `web` hostname) reach this the same way they reach Next itself — same
// hostname, different port — which only works because this is the SAME
// container, not a separate one on its own service name.
//
// Protocol: connect to ws://<host>:<port>/ws/<presentationSessionId>.
// Any connected client (Pi controller or presentation route) may send:
//   { "type": "SHOW_VIEW", "target": { "kind": "dataset" | "attachments", "id": "..." } }
// which updates PresentationSession, writes an AuditLog entry, and
// broadcasts the new state to every client on that session's channel:
//   { "type": "STATE", "activeViewKind": ..., "activeDatasetId": ..., "activeScraperRunId": ... }
// The presentation route (app/present/[sessionId]/page.tsx's client
// wrapper) treats any STATE message as "something changed, re-render";
// the Pi controller UI uses it to highlight which view is currently live.
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage } from "http";
import { prisma } from "./lib/prisma";

const PORT = Number(process.env.WS_PORT || 3001);

const channels = new Map<string, Set<WebSocket>>();

function broadcast(sessionId: string, message: unknown) {
  const clients = channels.get(sessionId);
  if (!clients) return;
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

const httpServer = createServer();
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const match = (req.url || "").match(/^\/ws\/([^/?]+)/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, match[1]);
  });
});

wss.on("connection", async (ws: WebSocket, _req: IncomingMessage, sessionId: string) => {
  // The session id itself is the capability token here, same reasoning as
  // app/present/[sessionId]/page.tsx and app/api/attachments/[id]/route.ts
  // — no interactive login to check for either audience (Pi kiosk browser,
  // Zoom bot's headless Chromium).
  const session = await prisma.presentationSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    ws.close(4004, "Unknown presentation session");
    return;
  }

  if (!channels.has(sessionId)) channels.set(sessionId, new Set());
  channels.get(sessionId)!.add(ws);
  console.log(`[ws] connected to session ${sessionId} (${channels.get(sessionId)!.size} client(s))`);

  ws.send(
    JSON.stringify({
      type: "STATE",
      activeViewKind: session.activeViewKind,
      activeDatasetId: session.activeDatasetId,
      activeScraperRunId: session.activeScraperRunId,
    })
  );

  ws.on("message", async (raw) => {
    let msg: { type?: string; target?: { kind?: string; id?: string } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "SHOW_VIEW" || !msg.target?.kind || !msg.target?.id) return;

    const { kind, id } = msg.target;
    const current = await prisma.presentationSession.findUnique({ where: { id: sessionId } });
    if (!current) return;

    if (kind === "dataset") {
      // Scope by the session's own owning user — the target id came over
      // the wire from a client, not derived server-side, so it needs the
      // same ownership check the Server Action version (app/presentations/[id]/page.tsx)
      // applies.
      const dataset = await prisma.dataset.findFirst({ where: { id, userId: current.userId } });
      if (!dataset) return;
      await prisma.presentationSession.update({
        where: { id: sessionId },
        data: { activeViewKind: "DATASET", activeDatasetId: id, activeScraperRunId: null },
      });
    } else if (kind === "attachments") {
      const run = await prisma.scraperRun.findFirst({
        where: { id, scraperDefinition: { userId: current.userId } },
      });
      if (!run) return;
      await prisma.presentationSession.update({
        where: { id: sessionId },
        data: { activeViewKind: "ATTACHMENTS", activeScraperRunId: id, activeDatasetId: null },
      });
    } else {
      return;
    }

    await prisma.auditLog.create({
      data: {
        userId: current.userId,
        action: "presentation_session.show_view",
        entityType: "PresentationSession",
        entityId: sessionId,
        metadata: { kind, id, via: "websocket" },
      },
    });

    const updated = await prisma.presentationSession.findUnique({ where: { id: sessionId } });
    broadcast(sessionId, {
      type: "STATE",
      activeViewKind: updated?.activeViewKind,
      activeDatasetId: updated?.activeDatasetId,
      activeScraperRunId: updated?.activeScraperRunId,
    });
  });

  ws.on("close", () => {
    channels.get(sessionId)?.delete(ws);
    console.log(`[ws] disconnected from session ${sessionId}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[ws] listening on :${PORT}`);
});
