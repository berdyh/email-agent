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
    "@anthropic-ai/claude-agent-sdk",
  ],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
