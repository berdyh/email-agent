import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../../"),
  transpilePackages: ["@email-agent/core"],
  serverExternalPackages: [
    "@lancedb/lancedb",
    "apache-arrow",
    "@google-cloud/pubsub",
    "node-notifier",
  ],
};

export default nextConfig;
