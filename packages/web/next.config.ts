import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@email-agent/core"],
  serverExternalPackages: [
    "@lancedb/lancedb",
    "apache-arrow",
    "@google-cloud/pubsub",
    "node-notifier",
  ],
};

export default nextConfig;
