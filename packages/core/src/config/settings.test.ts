import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSettings } from "./settings.js";
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
      ui: { fetchInterval: 15, fetchScope: "all" },
      dataDir: "/tmp/data",
      accounts: [{ email: "me@example.com", isDefault: true }],
      oauth: { clientId: "id", clientSecret: "secret" },
    });

    assert.equal(normalized.agentMode, "direct-api");
    assert.equal(normalized.preferredAgent, "codex");
    assert.equal(normalized.gcp.projectId, "my-project");
    assert.equal(normalized.prompts.summary, "custom summary");
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

  it("drops oauth when its fields are malformed", () => {
    const normalized = normalizeSettings({ oauth: { clientId: 123 } });
    assert.equal("oauth" in normalized, false);
  });
});
