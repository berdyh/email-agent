import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS_PATH, defaultConfig } from "./defaults.js";
import type { AccountConfig, AppConfig, OAuthConfig } from "./types.js";

/**
 * A cached parse of one settings file, tagged with a hash of the exact bytes
 * that parse came from. `contentHash` is null when the file did not exist, so a
 * settings.json created after the first read is still picked up.
 */
export interface SettingsCacheEntry {
  path: string;
  config: AppConfig;
  contentHash: string | null;
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
  const retention = asRecord(input["retention"]);

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
    retention: {
      approvalQueueDays:
        "approvalQueueDays" in retention
          ? (retention["approvalQueueDays"] as number)
          : (defaults.retention?.approvalQueueDays ?? 0),
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
 * Content hash of the exact bytes a settings parse came from.
 *
 * Hashes the raw buffer rather than a decoded string so the key is the bytes
 * on disk, not a lossy view of them (invalid UTF-8 decodes to replacement
 * characters and would collide).
 */
export function hashSettingsContent(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * True when a cache entry still describes the bytes just read from `path`.
 *
 * The key is a hash of content, NOT file metadata. `mtimeMs + size` is not
 * file identity: `git checkout`, a restore from backup and `rsync --times` all
 * reproduce a timestamp, and two settings files differing only in a boolean can
 * be byte-for-byte the same length. That combination was reproducible — the
 * auto-apply kill switch reported ON while the file said OFF, indefinitely.
 * Hashing also closes a TOCTOU the stat-based check had: the metadata was read
 * before the file contents, so an entry could tag pre-read metadata onto
 * different bytes. Here the validated bytes ARE the parsed bytes.
 *
 * Pure so the freshness rule itself is unit-testable.
 */
export function isSettingsCacheFresh(
  entry: SettingsCacheEntry,
  path: string,
  contentHash: string | null,
): boolean {
  if (entry.path !== path) return false;
  return entry.contentHash === contentHash;
}

/** The file's bytes, or null when it does not exist / cannot be read. */
async function readSettingsBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Loads settings from `path`, re-reading the file on every call.
 *
 * The cache used to be unconditional, which made `gmail.autoApplyActions` — the
 * kill switch for unattended Gmail mutation — stale for the life of the
 * process: a `serve` that read it as ON kept auto-applying after the user
 * turned it off. It was then keyed on `mtimeMs + size`, which is not file
 * identity and left the same staleness reachable (see `isSettingsCacheFresh`).
 *
 * settings.json is a small local file, so the honest fix is the simple one:
 * read it every time and key the cache on a hash of the bytes actually read.
 * The cache then only skips the JSON parse + normalization, never the read, so
 * the file is the single source of truth on every call. That also makes the
 * number of module instances irrelevant — each instance independently sees the
 * current bytes — at the cost of one small read + one sha256 per call.
 *
 * Not exported from the package barrel: `loadSettings()` is the public entry
 * point. Parameterized only so tests can exercise the freshness behaviour
 * against a temp file instead of the user's real `~/.email-agent/settings.json`.
 */
export async function loadSettingsFromPath(path: string): Promise<AppConfig> {
  const raw = await readSettingsBytes(path);
  const contentHash = raw === null ? null : hashSettingsContent(raw);

  // Cheap path: same path, same bytes — reuse the parse, skip nothing else.
  if (cacheEntry && isSettingsCacheFresh(cacheEntry, path, contentHash)) {
    return cacheEntry.config;
  }

  let config: AppConfig;
  if (raw === null) {
    config = normalizeSettings({});
  } else {
    try {
      config = normalizeSettings(JSON.parse(raw.toString("utf-8")));
    } catch {
      config = normalizeSettings({});
    }
  }

  cacheEntry = { path, config, contentHash };
  return config;
}

export function loadSettings(): Promise<AppConfig> {
  return loadSettingsFromPath(SETTINGS_PATH);
}

/**
 * Drops the in-process settings cache, forcing the next `loadSettings()` to
 * re-parse.
 *
 * Since the cache is keyed on content, every real edit already invalidates it;
 * this is now only a test affordance (a guaranteed cold parse) and a belt for
 * callers that want to drop the retained `AppConfig` object.
 */
export function clearSettingsCache(): void {
  cacheEntry = null;
}

export async function saveSettings(config: AppConfig): Promise<void> {
  const normalized = normalizeSettings(config);
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  const serialized = JSON.stringify(normalized, null, 2);
  await writeFile(SETTINGS_PATH, serialized);
  // Key the cache on the bytes we just wrote — no re-read, no re-stat, no
  // window in which the recorded identity could belong to different bytes.
  cacheEntry = {
    path: SETTINGS_PATH,
    config: normalized,
    contentHash: hashSettingsContent(Buffer.from(serialized, "utf-8")),
  };
}
