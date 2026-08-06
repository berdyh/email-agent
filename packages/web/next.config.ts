import { resolve } from "node:path";
import type { NextConfig } from "next";

// Load the repo-root .env (written by setup.sh) into the Next process for
// dev/build/start. Next only auto-loads env files from this package dir, so
// keys like OPENAI_API_KEY / OPENROUTER_API_KEY would otherwise never be seen.
// process.loadEnvFile does NOT override variables already set in the shell.
try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch {
  // No root .env present (or unreadable) — fine, env may come from the shell.
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../../"),
  transpilePackages: ["@email-agent/core"],
  serverExternalPackages: [
    "@lancedb/lancedb",
    "apache-arrow",
    "@anthropic-ai/claude-agent-sdk",
    // The action source guard parses generated actions with the TypeScript
    // compiler. It is server-only; bundling it would add megabytes for nothing.
    "typescript",
  ],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
