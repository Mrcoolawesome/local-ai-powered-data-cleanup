import type { NextConfig } from "next";

// No `output: "standalone"` — the Docker Compose deployment
// (apps/web/Dockerfile, docs/11-deployment.md) needs the full node_modules
// at runtime anyway, since ws-server.ts (docs/08-raspberry-pi-controller.md)
// runs as a second process alongside Next via `tsx`/`ws`, neither of which
// Next's own build tracing would include in a standalone bundle. Removed
// once that stopped being true rather than left as dead config.
const nextConfig: NextConfig = {};

export default nextConfig;
