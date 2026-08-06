import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  clearSettingsCache,
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
  const entry = {
    path: "/tmp/settings.json",
    config: defaultConfig,
    mtimeMs: 100,
    size: 42,
  };

  it("treats an unchanged file as fresh", () => {
    assert.equal(
      isSettingsCacheFresh(entry, "/tmp/settings.json", {
        mtimeMs: 100,
        size: 42,
      }),
      true,
    );
  });

  it("invalidates on a changed mtime or a changed size", () => {
    // Size is compared as well as mtime because a coarse filesystem timestamp
    // can leave two writes in the same millisecond indistinguishable.
    assert.equal(
      isSettingsCacheFresh(entry, "/tmp/settings.json", {
        mtimeMs: 101,
        size: 42,
      }),
      false,
    );
    assert.equal(
      isSettingsCacheFresh(entry, "/tmp/settings.json", {
        mtimeMs: 100,
        size: 43,
      }),
      false,
    );
  });

  it("invalidates when the file appears or disappears", () => {
    assert.equal(isSettingsCacheFresh(entry, "/tmp/settings.json", null), false);
    const missing = { ...entry, mtimeMs: null, size: null };
    assert.equal(
      isSettingsCacheFresh(missing, "/tmp/settings.json", null),
      true,
    );
    assert.equal(
      isSettingsCacheFresh(missing, "/tmp/settings.json", {
        mtimeMs: 100,
        size: 42,
      }),
      false,
    );
  });

  it("never serves one file's cache for another path", () => {
    assert.equal(
      isSettingsCacheFresh(entry, "/tmp/other.json", { mtimeMs: 100, size: 42 }),
      false,
    );
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
});
