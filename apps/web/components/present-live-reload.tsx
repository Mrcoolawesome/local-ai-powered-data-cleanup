"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Subscribes to this session's WS channel (ws-server.ts) purely to know
// "something changed" — router.refresh() re-fetches this Server Component
// tree in place, no full browser navigation/reload, which is the actual
// requirement (docs/07-zoom-bot.md: "a reload would drop or visibly
// glitch the native share"). Renders nothing; this is a side-effect-only
// component deliberately kept separate from the page's own data-fetching
// so the page itself stays a plain Server Component.
export function PresentLiveReload({ sessionId }: { sessionId: string }) {
  const router = useRouter();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.hostname}:3001/ws/${sessionId}`;

    let socket: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closedByUnmount = false;

    function connect() {
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "STATE") router.refresh();
        } catch {
          // ignore malformed frames
        }
      };
      // Standard exponential-ish backoff (docs/08's "reconnect logic...
      // so a brief network hiccup during a live meeting doesn't require
      // physically restarting the Pi") — same reconnect behavior is
      // useful here too, since this is the presentation route itself
      // staying resilient through the same kind of hiccup.
      socket.onclose = () => {
        if (!closedByUnmount) reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      closedByUnmount = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [sessionId, router]);

  return null;
}
