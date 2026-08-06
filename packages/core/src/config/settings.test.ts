import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  clearSettingsCache,
  hashSettingsContent,
  isSettingsCacheFresh,
  loadSettingsFromPath,
  normalizeSettings,
} from "./settings.js";
import { defaultConfig } from "./defaults.js";

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
      oauth: { clientId: "id", clientSecret: "secret" },
    });

    assert.equal(normalized.agentMode, "direct-api");
    assert.equal(normalized.preferredAgent, "codex");
    assert.equal(normalized.gcp.projectId, "my-project");
    assert.equal(normalized.prompts.summary, "custom summary");
    assert.equal(normalized.gmail.autoApplyActions, true);
    assert.equal(normalized.ui.fetchInterval, 15);
    assert.equal(normalized.dataDir, "/tmp/data");
    assert.equal(normalized.accounts[0]?.email, "me@example.com");
    assert.equal(normalized.oauth?.clientSecret, "secret");
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

  it("drops oauth when its fields are malformed", () => {
    const normalized = normalizeSettings({ oauth: { clientId: 123 } });
    assert.equal("oauth" in normalized, false);
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
