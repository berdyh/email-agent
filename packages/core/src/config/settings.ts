import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS_PATH, defaultConfig } from "./defaults.js";
import type { AccountConfig, AppConfig, OAuthConfig } from "./types.js";

let cachedSettings: AppConfig | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalize an arbitrary parsed settings object to the exact `AppConfig`
 * shape, constructing the result key-by-key from `parsed` + `defaults`.
 *
 * Unknown top-level keys and unknown nested keys are dropped, so a legacy
 * `~/.email-agent/settings.json` carrying removed fields (e.g. `notifications`,
 * `prompts.priority`, `prompts.clustering`, `gcp.pubsubTopic`) can never
 * survive a load/merge cycle back into the runtime config or API responses.
 * Partial nested sections keep their sibling defaults.
 *
 * Pure and side-effect free — safe to unit test without touching the fs.
 */
export function normalizeSettings(
  parsed: unknown,
  defaults: AppConfig = defaultConfig,
): AppConfig {
  const input = asRecord(parsed);

  const gcp = asRecord(input["gcp"]);
  const prompts = asRecord(input["prompts"]);
  const embedding = asRecord(input["embedding"]);
  const ui = asRecord(input["ui"]);

  const normalized: AppConfig = {
    agentMode:
      "agentMode" in input ? (input["agentMode"] as AppConfig["agentMode"]) : defaults.agentMode,
    preferredAgent:
      "preferredAgent" in input
        ? (input["preferredAgent"] as AppConfig["preferredAgent"])
        : defaults.preferredAgent,
    gcp: {
      projectId: "projectId" in gcp ? (gcp["projectId"] as string) : defaults.gcp.projectId,
    },
    prompts: {
      summary: "summary" in prompts ? (prompts["summary"] as string) : defaults.prompts.summary,
      digest: "digest" in prompts ? (prompts["digest"] as string) : defaults.prompts.digest,
    },
    embedding: {
      provider:
        "provider" in embedding
          ? (embedding["provider"] as AppConfig["embedding"]["provider"])
          : defaults.embedding.provider,
      model: "model" in embedding ? (embedding["model"] as string) : defaults.embedding.model,
      dimensions:
        "dimensions" in embedding
          ? (embedding["dimensions"] as number)
          : defaults.embedding.dimensions,
    },
    ui: {
      fetchInterval:
        "fetchInterval" in ui ? (ui["fetchInterval"] as number) : defaults.ui.fetchInterval,
      fetchScope:
        "fetchScope" in ui
          ? (ui["fetchScope"] as AppConfig["ui"]["fetchScope"])
          : defaults.ui.fetchScope,
    },
    dataDir: "dataDir" in input ? (input["dataDir"] as string) : defaults.dataDir,
    accounts: Array.isArray(input["accounts"])
      ? (input["accounts"] as AccountConfig[])
      : defaults.accounts,
  };

  const oauth = asRecord(input["oauth"]);
  if (typeof oauth["clientId"] === "string" && typeof oauth["clientSecret"] === "string") {
    normalized.oauth = {
      clientId: oauth["clientId"],
      clientSecret: oauth["clientSecret"],
    } satisfies OAuthConfig;
  }

  return normalized;
}

export async function loadSettings(): Promise<AppConfig> {
  if (cachedSettings) return cachedSettings;

  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    cachedSettings = normalizeSettings(JSON.parse(raw));
  } catch {
    cachedSettings = normalizeSettings({});
  }
  return cachedSettings;
}

export async function saveSettings(config: AppConfig): Promise<void> {
  const normalized = normalizeSettings(config);
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(normalized, null, 2));
  cachedSettings = normalized;
}
