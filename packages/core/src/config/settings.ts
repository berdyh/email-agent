import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS_PATH, defaultConfig } from "./defaults.js";
import type { AccountConfig, AppConfig, OAuthConfig } from "./types.js";

/**
 * A cached parse of one settings file, tagged with the file identity it was
 * read from. `mtimeMs`/`size` are null when the file did not exist, so a
 * settings.json created after the first read is still picked up.
 */
export interface SettingsCacheEntry {
  path: string;
  config: AppConfig;
  mtimeMs: number | null;
  size: number | null;
}

let cacheEntry: SettingsCacheEntry | null = null;

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
  const gmail = asRecord(input["gmail"]);
  const ui = asRecord(input["ui"]);

  const autoApplyAcknowledged =
    "autoApplyAcknowledged" in gmail
      ? (gmail["autoApplyAcknowledged"] as boolean)
      : defaults.gmail.autoApplyAcknowledged;
  const autoApplyRequested =
    "autoApplyActions" in gmail
      ? (gmail["autoApplyActions"] as boolean)
      : defaults.gmail.autoApplyActions;

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
    gmail: {
      // Auto-apply performs irreversible-feeling Gmail writes (trash, spam)
      // with no further prompt, so the acknowledgement gates the toggle here —
      // the one chokepoint every writer (web PUT, CLI config set, hand-edited
      // settings.json) passes through via saveSettings/loadSettings.
      autoApplyActions: autoApplyAcknowledged === true && autoApplyRequested === true,
      autoApplyAcknowledged: autoApplyAcknowledged === true,
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

/**
 * True when a cache entry still describes the file currently on disk.
 *
 * Pure so the freshness rule itself is unit-testable. Both mtime AND size are
 * compared: coarse filesystem timestamps can leave two writes in the same
 * millisecond indistinguishable by mtime alone, and a settings edit that flips
 * a boolean almost always changes the byte length too.
 */
export function isSettingsCacheFresh(
  entry: SettingsCacheEntry,
  path: string,
  stats: { mtimeMs: number; size: number } | null,
): boolean {
  if (entry.path !== path) return false;
  if (stats === null) return entry.mtimeMs === null && entry.size === null;
  return entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;
}

async function statSettings(
  path: string,
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stats = await stat(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

/**
 * Loads settings from `path`, re-reading whenever the file changed on disk.
 *
 * The cache used to be unconditional, which made `gmail.autoApplyActions` — the
 * kill switch for unattended Gmail mutation — stale for the life of the
 * process: a `serve` that read it as ON kept auto-applying after the user
 * turned it off. Re-validating against the file's mtime+size on every read
 * keeps the file the single source of truth, which also makes the number of
 * module instances irrelevant (each instance independently notices the change),
 * at the cost of one `stat()` per read.
 *
 * Not exported from the package barrel: `loadSettings()` is the public entry
 * point. Parameterized only so tests can exercise the freshness behaviour
 * against a temp file instead of the user's real `~/.email-agent/settings.json`.
 */
export async function loadSettingsFromPath(path: string): Promise<AppConfig> {
  const stats = await statSettings(path);
  if (cacheEntry && isSettingsCacheFresh(cacheEntry, path, stats)) {
    return cacheEntry.config;
  }

  let config: AppConfig;
  try {
    const raw = await readFile(path, "utf-8");
    config = normalizeSettings(JSON.parse(raw));
  } catch {
    config = normalizeSettings({});
  }

  cacheEntry = {
    path,
    config,
    mtimeMs: stats?.mtimeMs ?? null,
    size: stats?.size ?? null,
  };
  return config;
}

export function loadSettings(): Promise<AppConfig> {
  return loadSettingsFromPath(SETTINGS_PATH);
}

/**
 * Drops the in-process settings cache, forcing the next `loadSettings()` to
 * re-read from disk.
 *
 * The mtime+size check above already covers ordinary edits; this exists for the
 * cases it cannot see — a restore that rewrites the file with its original
 * timestamp and length, or a test that needs a guaranteed cold read.
 */
export function clearSettingsCache(): void {
  cacheEntry = null;
}

export async function saveSettings(config: AppConfig): Promise<void> {
  const normalized = normalizeSettings(config);
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(normalized, null, 2));
  // Re-stat after the write so the cached entry carries the identity of the
  // bytes we just wrote. Caching the config against a stale (or absent) stat
  // would make the very next read look fresh against the wrong file identity.
  const stats = await statSettings(SETTINGS_PATH);
  cacheEntry = {
    path: SETTINGS_PATH,
    config: normalized,
    mtimeMs: stats?.mtimeMs ?? null,
    size: stats?.size ?? null,
  };
}
