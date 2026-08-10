import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean runtime image for the Docker Compose deployment (docs/11-deployment.md)
  // — bundles only the traced production dependencies, not the whole node_modules.
  output: "standalone",
};

export default nextConfig;
