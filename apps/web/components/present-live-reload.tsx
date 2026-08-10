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
//
// `wsPort` comes from the parent Server Component reading process.env
// (WEB_WS_PORT) rather than being hardcoded — the host-published WS port
// isn't always 3001 (docker-compose.yml's WEB_WS_PORT is overridable for
// exactly this reason: a shared host running other Compose stacks can
// easily already have 3001 taken, found for real deploying alongside an
// existing stack). NEXT_PUBLIC_* build-time env vars would bake a single
// value into the client bundle at image-build time, which breaks the
// moment two deployments of the same image use different ports; reading
// it per-request server-side and passing it as a prop doesn't have that
// problem.
export function PresentLiveReload({ sessionId, wsPort }: { sessionId: string; wsPort: string }) {
  const router = useRouter();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.hostname}:${wsPort}/ws/${sessionId}`;

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
  }, [sessionId, wsPort, router]);

  return null;
}
