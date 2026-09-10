import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The console is opened via 127.0.0.1 as well as localhost during local development.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // discord.js ships optional native deps (zlib-sync etc.) that break bundling;
  // better-sqlite3 is a native addon (the swarm's archive DB). Load both from
  // node_modules at runtime instead of bundling.
  serverExternalPackages: ["discord.js", "better-sqlite3"],
};

export default nextConfig;
