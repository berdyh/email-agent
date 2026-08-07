import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS_PATH, defaultConfig } from "./defaults.js";
import type {
  AccountConfig,
  AppConfig,
  GmailAutoApplyConfig,
  OAuthConfig,
} from "./types.js";

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
 * THE consent invariant: **`autoApplyActions` requires `autoApplyAcknowledged`.**
 *
 * Auto-apply performs irreversible-feeling Gmail writes (trash, spam) with no
 * further prompt, so the toggle is forced off unless the acknowledgement of its
 * warnings is recorded alongside it. Revoking the acknowledgement disables the
 * toggle again by the same expression. Both flags are coerced with `=== true`,
 * so a truthy non-boolean out of a hand-edited settings.json or a JSON request
 * body (`"true"`, `1`) does not arm anything.
 *
 * ONE IMPLEMENTATION, TWO CALL SITES — deliberately. The rule is enforced both
 * here (every load and save goes through `normalizeSettings`) and again at the
 * web API boundary, which is defense in depth worth keeping: a settings PUT that
 * bypassed core normalization must still not be able to flip the toggle alone.
 * What must NOT happen is the two drifting, which is why this is a shared export
 * rather than a copy.
 *
 * INTENDED ADOPTION, not yet done (`packages/web` belongs to a concurrent
 * branch; tracked in TODOS.md): `normalizeGmailConfig` in
 * `packages/web/src/modules/api/validation.ts` is currently a hand-written
 * duplicate of this function's body with the same signature, called from
 * `mergeSettingsUpdate` and `sanitizeSettingsForResponse`. It should become a
 * call to this function, imported from `@email-agent/core/config` (the same
 * specifier that file already uses for `defaultConfig`/`AppConfig`).
 *
 * The scope of what this invariant can promise is "consent RECORDED", not
 * "warnings SEEN": it checks only that the flag is set, never where it came
 * from. `config set` refuses both keys and the Settings → Gmail card shows the
 * cautions before writing the acknowledgement, but a hand-edited settings.json
 * with both booleans is honoured. See TODOS.md.
 *
 * Pure — safe to call from a request handler or a test without touching the fs.
 */
export function normalizeAutoApplyConsent(
  gmail: Partial<GmailAutoApplyConfig> | undefined,
): GmailAutoApplyConfig {
  const autoApplyAcknowledged = gmail?.autoApplyAcknowledged === true;
  return {
    autoApplyActions: autoApplyAcknowledged && gmail?.autoApplyActions === true,
    autoApplyAcknowledged,
  };
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
    // The acknowledgement gates the toggle here — the one chokepoint every
    // writer (web PUT, CLI config set, hand-edited settings.json) passes
    // through via saveSettings/loadSettings. The rule itself lives in
    // `normalizeAutoApplyConsent` so the web API boundary can enforce the same
    // one instead of a copy.
    gmail: normalizeAutoApplyConsent({
      autoApplyActions: autoApplyRequested,
      autoApplyAcknowledged,
    }),
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
 * The removed key this build still recognises well enough to explain.
 *
 * `gmail.syncActions` was the old "apply AI-proposed Gmail changes as they are
 * produced" preference. `normalizeSettings` drops every unknown key, so an
 * upgraded install loses it silently — in the fail-safe direction (auto-apply
 * lands off and the changes are queued for approval), but silently.
 */
const LEGACY_SYNC_ACTIONS_KEY = "syncActions";

/**
 * True when the parsed settings still carry `gmail.syncActions`.
 *
 * Own-property check, deliberately: `in` would consult the prototype chain and
 * report a key the file does not contain. Pure, so the detection rule is
 * testable without a filesystem or a console.
 */
export function hasLegacySyncActionsKey(parsed: unknown): boolean {
  const gmail = asRecord(asRecord(parsed)["gmail"]);
  return Object.prototype.hasOwnProperty.call(gmail, LEGACY_SYNC_ACTIONS_KEY);
}

/** The notice text, exported so a test can assert what the user is told. */
export function legacySyncActionsNotice(path: string): string {
  return (
    `Settings at ${path} still contain the removed "gmail.syncActions" key. ` +
    "It no longer does anything and its value has been dropped: AI-proposed " +
    "Gmail changes are now queued for your approval instead of being applied " +
    "automatically. To apply them automatically again, turn on auto-apply in " +
    "the web UI under Settings → Gmail, which shows what it means before " +
    "arming it. To silence this notice, delete the key — any settings save " +
    "(the Settings page, or `email-agent config set`) also rewrites the file " +
    "without it."
  );
}

/**
 * Paths this process has already warned about.
 *
 * WHY THIS EXISTS AND NOT A BARE `console.warn`. `loadSettings()` re-reads the
 * file on EVERY call — that is deliberate and load-bearing, because
 * `gmail.autoApplyActions` is a kill switch that must not go stale — so
 * anything hung off the read fires on every read. A `serve` process calls
 * `loadSettings()` per request; an unconditional warn would print this notice
 * hundreds of times and train the user to ignore the log.
 *
 * Two guards, both needed. The parse only happens on a cache MISS, so an
 * unchanged file is not re-inspected; and this set makes it once per path even
 * when the bytes DO change (an edit that leaves the legacy key in place, or a
 * file whose contents flip back and forth) or when `clearSettingsCache()` has
 * dropped the parse.
 *
 * Per module instance, not per process: Next.js does not guarantee one instance
 * of this module per process (see the note on `loadSettingsFromPath`), so a
 * bundle that carries a second copy warns once from that copy too. Acceptable —
 * it is a log line, not an action — and stating it beats implying a stronger
 * guarantee than the mechanism gives.
 */
const legacyNoticeShownFor = new Set<string>();

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

/**
 * The file's bytes, or null when — and ONLY when — the file does not exist.
 *
 * ABSENCE IS NOT THE SAME AS "COULD NOT READ". This used to catch everything
 * and return null, so a permission change, an I/O error or a path component
 * turning into a file all resolved to "no settings file" and therefore to the
 * built-in defaults. That is a fallback that destroys data: the retention
 * sweep in `actions/approval.ts` reads `retention.approvalQueueDays` from here,
 * and the default is 365 days while the explicit opt-out is 0. A user who set
 * 0 to keep their approval audit trail forever would have had rows deleted the
 * first time the file was momentarily unreadable — an irreversible action taken
 * because we could not read the instruction saying not to.
 *
 * So: ENOENT means the user genuinely has no settings file yet (first run) and
 * defaults are the right answer. Every other errno means we do not know what
 * the user configured, and the caller must fail rather than guess.
 *
 * KNOWN CONSEQUENCE, accepted deliberately: every settings path goes through
 * `loadSettings()` first, so once the file is unreadable or unparsable NO tool
 * can repair it. CLI `config get` and `config set` throw, and the web settings
 * PUT throws before it can merge and write. There is no self-repair path, by
 * design — a writer that fell back to defaults in order to "fix" the file
 * would persist those defaults over the user's configuration, which is the
 * exact data loss this refusal exists to prevent. Recovery is the instruction
 * in the error text: repair the file by hand, or move it aside to start from
 * defaults. If you ever add a repair command, it must bypass `loadSettings()`
 * explicitly rather than softening the fallback here.
 */
async function readSettingsBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read settings at ${path} (${code}: ${message}). Refusing to fall back to default settings — the defaults differ from a configured file in ways that delete data (retention.approvalQueueDays defaults to 365 days, while 0 means never prune). Fix the file's permissions or path and retry.`,
    );
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
    // Genuinely absent (ENOENT) — first run, defaults are the right answer.
    config = normalizeSettings({});
  } else {
    // A file that exists but does not parse is the same class of unknown as a
    // file that cannot be read: it is NOT evidence that the user configured
    // nothing. Falling back to defaults here would silently re-arm the 365-day
    // retention sweep over an explicit `approvalQueueDays: 0`.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Settings at ${path} exist but are not valid JSON (${message}). Refusing to fall back to default settings — the defaults differ from a configured file in ways that delete data (retention.approvalQueueDays defaults to 365 days, while 0 means never prune). Repair the file, or move it aside to start from defaults.`,
      );
    }
    // Removed keys are dropped by normalizeSettings without a word. Say so for
    // the one whose loss changes behaviour the user will notice. Reached only
    // on a cache miss, and at most once per path — see `legacyNoticeShownFor`.
    if (hasLegacySyncActionsKey(parsed) && !legacyNoticeShownFor.has(path)) {
      legacyNoticeShownFor.add(path);
      console.warn(legacySyncActionsNotice(path));
    }

    config = normalizeSettings(parsed);
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
 *
 * Also forgets which paths have shown the legacy-key notice, so a test can
 * assert the notice itself. That is the only reason it is coupled: in a real
 * process nothing calls this, and the notice stays once per path.
 */
export function clearSettingsCache(): void {
  cacheEntry = null;
  legacyNoticeShownFor.clear();
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
