import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  clearSettingsCache,
  hasLegacyOauthKey,
  hasLegacySyncActionsKey,
  hashSettingsContent,
  isSettingsCacheFresh,
  loadSettingsFromPath,
  normalizeAutoApplyConsent,
  normalizeSettings,
} from "./settings.js";
import { defaultConfig } from "./defaults.js";
import type { AppConfig } from "./types.js";

describe("config settings normalization", () => {
  it("strips legacy top-level and nested keys not in AppConfig", () => {
    const normalized = normalizeSettings({
      agentMode: "hybrid",
      notifications: { desktop: { enabled: true }, slackWebhookUrl: "https://x" },
      prompts: {
        summary: "s",
        digest: "d",
        priority: "legacy priority prompt",
        clustering: "legacy clustering prompt",
      },
      ui: { fetchInterval: 5, fetchScope: "all", theme: "dark", sidebarCollapsed: true },
      gcp: {
        projectId: "proj",
        pubsubTopic: "topic",
        pubsubSubscription: "sub",
      },
    });

    assert.equal("notifications" in normalized, false);
    assert.equal("priority" in normalized.prompts, false);
    assert.equal("clustering" in normalized.prompts, false);
    assert.equal("theme" in normalized.ui, false);
    assert.equal("sidebarCollapsed" in normalized.ui, false);
    assert.equal("pubsubTopic" in normalized.gcp, false);
    assert.equal("pubsubSubscription" in normalized.gcp, false);
    assert.deepEqual(Object.keys(normalized.gcp), ["projectId"]);
  });

  it("keeps sibling defaults when a nested section is partial", () => {
    const normalized = normalizeSettings({ ui: { fetchInterval: 30 } });

    assert.equal(normalized.ui.fetchInterval, 30);
    assert.equal(normalized.ui.fetchScope, defaultConfig.ui.fetchScope);
    assert.equal(normalized.prompts.summary, defaultConfig.prompts.summary);
    assert.equal(normalized.embedding.provider, defaultConfig.embedding.provider);
  });

  it("preserves known values across all sections", () => {
    const normalized = normalizeSettings({
      agentMode: "direct-api",
      preferredAgent: "codex",
      gcp: { projectId: "my-project" },
      prompts: { summary: "custom summary", digest: "custom digest" },
      embedding: { provider: "openrouter", model: "qwen", dimensions: 768 },
      gmail: { autoApplyActions: true, autoApplyAcknowledged: true },
      ui: { fetchInterval: 15, fetchScope: "all" },
      dataDir: "/tmp/data",
      accounts: [{ email: "me@example.com", isDefault: true }],
    });

    assert.equal(normalized.agentMode, "direct-api");
    assert.equal(normalized.preferredAgent, "codex");
    assert.equal(normalized.gcp.projectId, "my-project");
    assert.equal(normalized.prompts.summary, "custom summary");
    assert.equal(normalized.gmail.autoApplyActions, true);
    assert.equal(normalized.ui.fetchInterval, 15);
    assert.equal(normalized.dataDir, "/tmp/data");
    assert.equal(normalized.accounts[0]?.email, "me@example.com");
  });

  it("falls back to defaults for empty or non-object input", () => {
    assert.deepEqual(normalizeSettings({}), defaultConfig);
    assert.deepEqual(normalizeSettings(null), defaultConfig);
    assert.deepEqual(normalizeSettings("garbage"), defaultConfig);
  });

  it("refuses to enable auto-apply without an acknowledgement", () => {
    // The dangerous half of the pair alone must never survive normalization —
    // this is what a hand-edited settings.json or `config set` would produce.
    const forced = normalizeSettings({
      gmail: { autoApplyActions: true },
    });
    assert.equal(forced.gmail.autoApplyActions, false);
    assert.equal(forced.gmail.autoApplyAcknowledged, false);

    const revoked = normalizeSettings({
      gmail: { autoApplyActions: true, autoApplyAcknowledged: false },
    });
    assert.equal(revoked.gmail.autoApplyActions, false);
  });

  it("keeps auto-apply off by default and when only acknowledged", () => {
    assert.equal(defaultConfig.gmail.autoApplyActions, false);
    assert.equal(defaultConfig.gmail.autoApplyAcknowledged, false);

    const acknowledgedOnly = normalizeSettings({
      gmail: { autoApplyAcknowledged: true },
    });
    assert.equal(acknowledgedOnly.gmail.autoApplyActions, false);
    assert.equal(acknowledgedOnly.gmail.autoApplyAcknowledged, true);
  });

  it("drops a legacy oauth block entirely, malformed or not", () => {
    // oauth is a removed field (dead config nothing ever reads — Gmail OAuth
    // credentials come only from ~/.email-agent/oauth.json). It must be
    // dropped like any other legacy key, whether or not its shape was ever
    // well-formed — the malformed case alone would not have caught a
    // normalizeSettings that still round-tripped a VALID oauth block.
    const malformed = normalizeSettings({ oauth: { clientId: 123 } });
    assert.equal("oauth" in malformed, false);

    const wellFormed = normalizeSettings({
      oauth: { clientId: "id", clientSecret: "secret" },
    });
    assert.equal("oauth" in wellFormed, false);
  });
});

describe("the auto-apply consent invariant", () => {
  // This is the rule that keeps unattended Gmail mutation opt-in. It is
  // enforced twice on purpose — here, and again at the web API boundary — so
  // the point of these tests is the SHARED implementation both are meant to
  // call. `normalizeGmailConfig` in packages/web still has its own copy; when
  // it adopts this function, these become the tests for both.
  it("forces autoApplyActions off unless the acknowledgement is recorded", () => {
    assert.deepEqual(
      normalizeAutoApplyConsent({ autoApplyActions: true, autoApplyAcknowledged: true }),
      { autoApplyActions: true, autoApplyAcknowledged: true },
    );
    // The dangerous half alone: what a hand-edited settings.json produces.
    assert.deepEqual(
      normalizeAutoApplyConsent({ autoApplyActions: true, autoApplyAcknowledged: false }),
      { autoApplyActions: false, autoApplyAcknowledged: false },
    );
    assert.deepEqual(
      normalizeAutoApplyConsent({ autoApplyActions: false, autoApplyAcknowledged: true }),
      { autoApplyActions: false, autoApplyAcknowledged: true },
    );
    assert.deepEqual(
      normalizeAutoApplyConsent({ autoApplyActions: false, autoApplyAcknowledged: false }),
      { autoApplyActions: false, autoApplyAcknowledged: false },
    );
  });

  it("treats a missing section, and missing keys, as no consent", () => {
    assert.deepEqual(normalizeAutoApplyConsent(undefined), {
      autoApplyActions: false,
      autoApplyAcknowledged: false,
    });
    assert.deepEqual(normalizeAutoApplyConsent({}), {
      autoApplyActions: false,
      autoApplyAcknowledged: false,
    });
    assert.deepEqual(normalizeAutoApplyConsent({ autoApplyActions: true }), {
      autoApplyActions: false,
      autoApplyAcknowledged: false,
    });
  });

  it("does not accept a truthy non-boolean as consent", () => {
    // A JSON request body or a hand-edited settings.json can carry anything;
    // both flags are compared with === true for exactly this reason.
    const truthy: unknown[] = [1, "true", "yes", {}, []];
    for (const value of truthy) {
      const gmail = {
        autoApplyActions: value,
        autoApplyAcknowledged: value,
      } as unknown as Partial<AppConfig["gmail"]>;
      assert.deepEqual(
        normalizeAutoApplyConsent(gmail),
        { autoApplyActions: false, autoApplyAcknowledged: false },
        `truthy value ${JSON.stringify(value)} must not arm auto-apply`,
      );
    }
  });

  it("returns exactly the two keys, so no other gmail.* field can ride along", () => {
    const extra = {
      autoApplyActions: true,
      autoApplyAcknowledged: true,
      syncActions: true,
    } as unknown as Partial<AppConfig["gmail"]>;
    assert.deepEqual(Object.keys(normalizeAutoApplyConsent(extra)), [
      "autoApplyActions",
      "autoApplyAcknowledged",
    ]);
  });

  it("is the implementation normalizeSettings uses, for every combination", () => {
    // Pins the delegation: if normalizeSettings ever grows a second copy of
    // the rule, this fails rather than drifting quietly.
    for (const autoApplyActions of [true, false]) {
      for (const autoApplyAcknowledged of [true, false]) {
        const gmail = { autoApplyActions, autoApplyAcknowledged };
        assert.deepEqual(
          normalizeSettings({ gmail }).gmail,
          normalizeAutoApplyConsent(gmail),
          `normalizeSettings disagreed for ${JSON.stringify(gmail)}`,
        );
      }
    }
  });
});

describe("settings cache freshness", () => {
  const hashOn = hashSettingsContent('{"gmail":{"autoApplyActions":true}}');
  const hashOff = hashSettingsContent('{"gmail":{"autoApplyActions":false}}');
  const entry = {
    path: "/tmp/settings.json",
    config: defaultConfig,
    contentHash: hashOn,
  };

  it("treats identical bytes as fresh", () => {
    assert.equal(isSettingsCacheFresh(entry, "/tmp/settings.json", hashOn), true);
  });

  it("invalidates whenever the bytes differ", () => {
    assert.equal(
      isSettingsCacheFresh(entry, "/tmp/settings.json", hashOff),
      false,
    );
  });

  it("invalidates when the file appears or disappears", () => {
    assert.equal(isSettingsCacheFresh(entry, "/tmp/settings.json", null), false);
    const missing = { ...entry, contentHash: null };
    assert.equal(
      isSettingsCacheFresh(missing, "/tmp/settings.json", null),
      true,
    );
    assert.equal(
      isSettingsCacheFresh(missing, "/tmp/settings.json", hashOn),
      false,
    );
  });

  it("never serves one file's cache for another path", () => {
    assert.equal(isSettingsCacheFresh(entry, "/tmp/other.json", hashOn), false);
  });

  it("hashes bytes, not a decoded view of them", () => {
    // The Buffer and string overloads must agree, so saveSettings (which hashes
    // what it serialized) and loadSettingsFromPath (which hashes what it read)
    // key the same content the same way.
    assert.equal(
      hashSettingsContent(Buffer.from('{"a":1}', "utf-8")),
      hashSettingsContent('{"a":1}'),
    );
    assert.notEqual(hashSettingsContent('{"a":1}'), hashSettingsContent('{"a":2}'));
  });
});

describe("loadSettings re-reads a changed settings file", () => {
  let dir = "";
  let path = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-settings-"));
    path = join(dir, "settings.json");
  });

  after(async () => {
    clearSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("picks up a kill-switch flip without a restart", async () => {
    // The regression: `gmail.autoApplyActions` is the kill switch for
    // unattended Gmail mutation. A long-running `serve` that cached it as ON
    // kept auto-applying after the user turned it off, until restart.
    clearSettingsCache();
    await writeFile(
      path,
      JSON.stringify({
        gmail: { autoApplyActions: true, autoApplyAcknowledged: true },
      }),
    );
    const armed = await loadSettingsFromPath(path);
    assert.equal(armed.gmail.autoApplyActions, true);

    await writeFile(
      path,
      JSON.stringify({
        gmail: { autoApplyActions: false, autoApplyAcknowledged: true },
      }),
    );
    const disarmed = await loadSettingsFromPath(path);
    assert.equal(disarmed.gmail.autoApplyActions, false);
  });

  it("serves the cached object while the file is untouched", async () => {
    clearSettingsCache();
    const first = await loadSettingsFromPath(path);
    const second = await loadSettingsFromPath(path);
    assert.equal(first, second);
  });

  it("falls back to defaults for a missing file, then notices it appear", async () => {
    clearSettingsCache();
    const absent = join(dir, "nope.json");
    assert.deepEqual(await loadSettingsFromPath(absent), defaultConfig);

    await writeFile(absent, JSON.stringify({ agentMode: "direct-api" }));
    const created = await loadSettingsFromPath(absent);
    assert.equal(created.agentMode, "direct-api");
  });

  it("sees a kill-switch flip that preserves BOTH mtime and byte length", async () => {
    // The reproduction that broke the previous `mtimeMs + size` cache key.
    // Two valid settings files of identical byte length, with the mtime
    // restored to its original value after the rewrite — exactly what
    // `git checkout`, a restore from backup, `rsync --times` or an editor that
    // preserves timestamps produces. Under the stat-based key the process kept
    // reporting the auto-apply kill switch ON while the file on disk said OFF,
    // with no bound on how long that lasted.
    clearSettingsCache();
    const path = join(dir, "identity.json");
    const frozen = new Date(1_700_000_000_000);

    // "true" is one byte shorter than "false"; the padding key (dropped by
    // normalizeSettings) makes the two files the same length.
    const armed = '{"gmail":{"autoApplyActions":true,"autoApplyAcknowledged":true},"pad":"xx"}';
    const disarmed = '{"gmail":{"autoApplyActions":false,"autoApplyAcknowledged":true},"pad":"x"}';
    assert.equal(
      Buffer.byteLength(armed),
      Buffer.byteLength(disarmed),
      "test fixture must produce equal-length files",
    );

    await writeFile(path, armed);
    await utimes(path, frozen, frozen);
    const before = await stat(path);
    assert.equal((await loadSettingsFromPath(path)).gmail.autoApplyActions, true);

    await writeFile(path, disarmed);
    await utimes(path, frozen, frozen);
    const afterStats = await stat(path);

    // Pin the premise: the file identity the old cache keyed on is unchanged.
    assert.equal(afterStats.mtimeMs, before.mtimeMs);
    assert.equal(afterStats.size, before.size);

    // ...and the kill switch is still read correctly, because the cache key is
    // a hash of the bytes actually read.
    assert.equal(
      (await loadSettingsFromPath(path)).gmail.autoApplyActions,
      false,
      "kill switch must follow the file, not its mtime+size",
    );
  });
});

describe("a dropped legacy gmail.syncActions key is announced once", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-legacy-"));
  });

  after(async () => {
    clearSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => { console.warn = original; } };
  }

  it("detects the key only when the file actually carries it", () => {
    assert.equal(hasLegacySyncActionsKey({ gmail: { syncActions: true } }), true);
    // Value-independent: `false` was still a preference the user expressed.
    assert.equal(hasLegacySyncActionsKey({ gmail: { syncActions: false } }), true);
    assert.equal(hasLegacySyncActionsKey({ gmail: { autoApplyActions: true } }), false);
    assert.equal(hasLegacySyncActionsKey({}), false);
    assert.equal(hasLegacySyncActionsKey(null), false);
    // An own-property check, so a polluted prototype cannot fabricate it.
    assert.equal(hasLegacySyncActionsKey({ gmail: Object.create({ syncActions: true }) }), false);
  });

  it("warns on the load that drops it, and says what happens now", async () => {
    clearSettingsCache();
    const path = join(dir, "legacy.json");
    await writeFile(path, JSON.stringify({ gmail: { syncActions: true } }));

    const { lines, restore } = captureWarnings();
    try {
      const config = await loadSettingsFromPath(path);
      // Fail-safe direction: the preference is gone and auto-apply is off.
      assert.equal("syncActions" in config.gmail, false);
      assert.equal(config.gmail.autoApplyActions, false);
    } finally {
      restore();
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /gmail\.syncActions/);
    assert.match(lines[0] ?? "", /queued for your approval/);
    assert.match(lines[0] ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not warn again on every read, even when the file changes", async () => {
    // The hazard: `loadSettings()` re-reads the file on EVERY call, so a notice
    // hung off the read would print once per request in a `serve` process. The
    // cache-miss guard alone is not enough either — an edit that leaves the
    // legacy key in place is a new hash and a fresh parse.
    clearSettingsCache();
    const path = join(dir, "chatty.json");
    await writeFile(path, JSON.stringify({ gmail: { syncActions: true } }));

    const { lines, restore } = captureWarnings();
    try {
      await loadSettingsFromPath(path);
      // Same bytes: served from the parse cache, no re-inspection.
      await loadSettingsFromPath(path);
      await loadSettingsFromPath(path);
      // Different bytes, legacy key still present: a real cache miss.
      await writeFile(
        path,
        JSON.stringify({ gmail: { syncActions: true }, ui: { fetchInterval: 30 } }),
      );
      await loadSettingsFromPath(path);
      // And again with the key removed, which must not warn either.
      await writeFile(path, JSON.stringify({ ui: { fetchInterval: 45 } }));
      await loadSettingsFromPath(path);
    } finally {
      restore();
    }

    assert.equal(lines.length, 1, `expected exactly one notice, got:\n${lines.join("\n")}`);
  });

  it("says nothing for a settings file without the legacy key", async () => {
    clearSettingsCache();
    const path = join(dir, "clean.json");
    await writeFile(path, JSON.stringify({ gmail: { autoApplyActions: false } }));

    const { lines, restore } = captureWarnings();
    try {
      await loadSettingsFromPath(path);
    } finally {
      restore();
    }
    assert.deepEqual(lines, []);
  });
});

describe("a dropped legacy oauth key is announced once", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-legacy-oauth-"));
  });

  after(async () => {
    clearSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => { console.warn = original; } };
  }

  it("detects the key only when the file actually carries it", () => {
    assert.equal(hasLegacyOauthKey({ oauth: { clientId: "x", clientSecret: "y" } }), true);
    // Value-independent: even an empty/malformed block is the on-disk
    // condition the notice is about.
    assert.equal(hasLegacyOauthKey({ oauth: {} }), true);
    assert.equal(hasLegacyOauthKey({ gmail: {} }), false);
    assert.equal(hasLegacyOauthKey({}), false);
    assert.equal(hasLegacyOauthKey(null), false);
    // An own-property check, so a polluted prototype cannot fabricate it.
    assert.equal(hasLegacyOauthKey(Object.create({ oauth: {} })), false);
  });

  it("warns on the load that drops it, and says what happens now", async () => {
    clearSettingsCache();
    const path = join(dir, "legacy-oauth.json");
    await writeFile(
      path,
      JSON.stringify({ oauth: { clientId: "id", clientSecret: "secret" } }),
    );

    const { lines, restore } = captureWarnings();
    try {
      const config = await loadSettingsFromPath(path);
      assert.equal("oauth" in config, false);
    } finally {
      restore();
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /legacy "oauth" key/);
    assert.match(lines[0] ?? "", /oauth\.json/);
    assert.match(lines[0] ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not warn again on every read, even when the file changes", async () => {
    clearSettingsCache();
    const path = join(dir, "chatty-oauth.json");
    await writeFile(path, JSON.stringify({ oauth: { clientId: "id" } }));

    const { lines, restore } = captureWarnings();
    try {
      await loadSettingsFromPath(path);
      await loadSettingsFromPath(path);
      await writeFile(
        path,
        JSON.stringify({ oauth: { clientId: "id" }, ui: { fetchInterval: 30 } }),
      );
      await loadSettingsFromPath(path);
      await writeFile(path, JSON.stringify({ ui: { fetchInterval: 45 } }));
      await loadSettingsFromPath(path);
    } finally {
      restore();
    }

    assert.equal(lines.length, 1, `expected exactly one notice, got:\n${lines.join("\n")}`);
  });

  it("says nothing for a settings file without the legacy key", async () => {
    clearSettingsCache();
    const path = join(dir, "clean-oauth.json");
    await writeFile(path, JSON.stringify({ gmail: { autoApplyActions: false } }));

    const { lines, restore } = captureWarnings();
    try {
      await loadSettingsFromPath(path);
    } finally {
      restore();
    }
    assert.deepEqual(lines, []);
  });

  it("announces BOTH a dropped syncActions key and a dropped oauth key in one load, neither suppressing the other", async () => {
    // The case the composite (path, kind) cache key exists for: a naive
    // bare-path `legacyNoticeShownFor` would let whichever check runs first
    // mark the path warned and silently swallow the second notice.
    clearSettingsCache();
    const path = join(dir, "both-legacy.json");
    await writeFile(
      path,
      JSON.stringify({
        gmail: { syncActions: true },
        oauth: { clientId: "id", clientSecret: "secret" },
      }),
    );

    const { lines, restore } = captureWarnings();
    try {
      await loadSettingsFromPath(path);
    } finally {
      restore();
    }

    assert.equal(lines.length, 2, `expected two notices, got:\n${lines.join("\n")}`);
    assert.ok(lines.some((line) => /gmail\.syncActions/.test(line)));
    assert.ok(lines.some((line) => /legacy "oauth" key/.test(line)));
  });
});

describe("an unreadable settings file is not the same as an absent one", () => {
  // These exercise REAL filesystem failures, not malformed content: the bug was
  // that `catch {}` around `readFile` turned every errno into "no settings
  // file", and the defaults it then returned prune the approval audit trail on
  // a 365-day window that an explicit `approvalQueueDays: 0` had opted out of.
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-settings-fail-"));
  });

  after(async () => {
    clearSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("throws rather than defaulting when the path is a directory (EISDIR)", async () => {
    clearSettingsCache();
    const asDir = join(dir, "settings-as-dir.json");
    await mkdir(asDir, { recursive: true });
    await assert.rejects(
      loadSettingsFromPath(asDir),
      /Could not read settings .*Refusing to fall back to default settings/s,
    );
  });

  it("throws rather than defaulting when a path component is a file (ENOTDIR)", async () => {
    clearSettingsCache();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    await assert.rejects(
      loadSettingsFromPath(join(blocker, "settings.json")),
      /Could not read settings .*Refusing to fall back to default settings/s,
    );
  });

  it("throws rather than defaulting when the file is unreadable (chmod 000)", async (t) => {
    clearSettingsCache();
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root bypasses mode bits");
      return;
    }
    const path = join(dir, "locked.json");
    await writeFile(path, JSON.stringify({ retention: { approvalQueueDays: 0 } }));
    await chmod(path, 0o000);
    try {
      await assert.rejects(
        loadSettingsFromPath(path),
        /Could not read settings .*Refusing to fall back to default settings/s,
      );
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("throws rather than defaulting when the file exists but is not JSON", async () => {
    clearSettingsCache();
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ approvalQueueDays: 0, truncated");
    await assert.rejects(
      loadSettingsFromPath(path),
      /exist but are not valid JSON .*Refusing to fall back to default settings/s,
    );
  });

  it("still treats a genuinely absent file (ENOENT) as defaults", async () => {
    clearSettingsCache();
    assert.deepEqual(
      await loadSettingsFromPath(join(dir, "definitely-not-here.json")),
      defaultConfig,
    );
  });
});
