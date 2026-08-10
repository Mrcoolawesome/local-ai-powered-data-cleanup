"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Target = { kind: "dataset" | "attachments"; id: string; label: string };

// Large, unambiguous touch targets per docs/08-raspberry-pi-controller.md's
// "3x4 inch touchscreen ... not a dense dashboard" — a handful of big
// buttons, not a scaled-down version of the main app's UI.
export function ControlPanel({
  sessionId,
  initialActiveViewKind,
  initialActiveDatasetId,
  initialActiveScraperRunId,
  datasets,
  scraperRuns,
}: {
  sessionId: string;
  initialActiveViewKind: string | null;
  initialActiveDatasetId: string | null;
  initialActiveScraperRunId: string | null;
  datasets: { id: string; name: string }[];
  scraperRuns: { id: string; label: string }[];
}) {
  const [activeViewKind, setActiveViewKind] = useState(initialActiveViewKind);
  const [activeDatasetId, setActiveDatasetId] = useState(initialActiveDatasetId);
  const [activeScraperRunId, setActiveScraperRunId] = useState(initialActiveScraperRunId);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.hostname}:3001/ws/${sessionId}`;

    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closedByUnmount = false;

    function connect() {
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "STATE") {
            setActiveViewKind(msg.activeViewKind);
            setActiveDatasetId(msg.activeDatasetId);
            setActiveScraperRunId(msg.activeScraperRunId);
          }
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        setConnected(false);
        // Exponential-ish backoff per docs/08's reconnect requirement — a
        // brief network hiccup shouldn't require physically restarting the Pi.
        if (!closedByUnmount) reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      closedByUnmount = true;
      clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [sessionId]);

  function showView(target: Target) {
    socketRef.current?.send(JSON.stringify({ type: "SHOW_VIEW", target: { kind: target.kind, id: target.id } }));
  }

  const targets: Target[] = [
    ...datasets.map((d) => ({ kind: "dataset" as const, id: d.id, label: d.name })),
    ...scraperRuns.map((r) => ({ kind: "attachments" as const, id: r.id, label: r.label })),
  ];

  const isActive = (t: Target) =>
    (t.kind === "dataset" && activeViewKind === "DATASET" && activeDatasetId === t.id) ||
    (t.kind === "attachments" && activeViewKind === "ATTACHMENTS" && activeScraperRunId === t.id);

  return (
    <main className="flex h-dvh w-dvw flex-col gap-4 bg-black p-4">
      <div className="flex items-center justify-between text-sm text-white/60">
        <span>Presentation Controller</span>
        <span className={connected ? "text-green-400" : "text-red-400"}>
          {connected ? "connected" : "reconnecting…"}
        </span>
      </div>

      {targets.length === 0 && (
        <p className="flex flex-1 items-center justify-center text-lg text-white/40">
          Nothing to show yet — clean a dataset or run a scraper first.
        </p>
      )}

      <div className="grid flex-1 grid-cols-2 gap-4">
        {targets.map((t) => (
          <Button
            key={`${t.kind}:${t.id}`}
            onClick={() => showView(t)}
            variant={isActive(t) ? "default" : "outline"}
            className="h-full min-h-24 w-full whitespace-normal text-lg"
          >
            {t.label}
          </Button>
        ))}
      </div>
    </main>
  );
}
