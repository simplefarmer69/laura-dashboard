import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The console is opened via 127.0.0.1 as well as localhost during local development.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // discord.js ships optional native deps (zlib-sync etc.) that break bundling;
  // better-sqlite3 is a native addon (the swarm's archive DB). Load both from
  // node_modules at runtime instead of bundling. playwright (browser worker,
  // optional) drives a real Chromium and must never be bundled either.
  serverExternalPackages: ["discord.js", "better-sqlite3", "playwright"],
  /* Next ignores app-router folders whose name starts with a dot, so the MCP
     discovery card lives at a normal route and is served from the conventional
     well-known path through this rewrite. */
  async rewrites() {
    return [{ source: "/.well-known/mcp.json", destination: "/api/well-known/mcp" }];
  },
};

export default nextConfig;
