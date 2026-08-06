import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "@email-agent/core/config";
import {
  internalErrorResponse,
  mergeSettingsUpdate,
  mutationGuardResponse,
  parseActionGenerateRequest,
  parseActionRunRequest,
  parseAccountDeleteRequest,
  parseAccountPostRequest,
  parseApprovalIdsRequest,
  parseEmailIdRequest,
  parseEmailIdentityQuery,
  parseEmailListQuery,
  parseEmailReadStatusRequest,
  parseSettingsUpdateRequest,
  parseSnapshotRestoreRequest,
  parseFetchEmailsRequest,
  parseUserActionSaveRequest,
  readGuardResponse,
  sanitizeSettingsForResponse,
} from "./validation.js";

describe("web API validation", () => {
  it("normalizes fetch requests and clamps invalid scope to unread", () => {
    assert.deepEqual(parseFetchEmailsRequest({ scope: "all", maxResults: 25 }), {
      scope: "all",
      maxResults: 25,
      accountEmail: undefined,
    });
    assert.equal(parseFetchEmailsRequest({ accountEmail: "" }).accountEmail, "");
    assert.equal(parseFetchEmailsRequest({ scope: "unknown" }).scope, "unread");
  });

  it("rejects invalid fetch limits", () => {
    assert.throws(() => parseFetchEmailsRequest({ maxResults: 0 }), /maxResults/);
    assert.throws(() => parseFetchEmailsRequest({ maxResults: 1001 }), /maxResults/);
  });

  it("validates action generation conversations", () => {
    const parsed = parseActionGenerateRequest({
      mode: "edit",
      currentCode: "const action = {};",
      messages: [{ role: "user", content: "Add a tone field" }],
    });

    assert.equal(parsed.mode, "edit");
    assert.equal(parsed.messages[0]?.role, "user");
  });

  it("normalizes optional action generation fields", () => {
    const parsed = parseActionGenerateRequest({
      mode: "create",
      currentCode: "",
      messages: [{ role: "assistant", content: "draft" }],
    });

    assert.equal(parsed.currentCode, undefined);
    assert.equal(parsed.messages[0]?.role, "assistant");
  });

  it("rejects invalid action generation mode and message roles", () => {
    assert.throws(
      () => parseActionGenerateRequest({ mode: "delete", messages: [] }),
      /mode/,
    );
    assert.throws(
      () =>
        parseActionGenerateRequest({
          mode: "create",
          messages: [{ role: "system", content: "bad" }],
        }),
      /role/,
    );
  });

  it("validates action run and save requests", () => {
    assert.deepEqual(parseActionRunRequest({ actionId: "priority" }), {
      actionId: "priority",
      accountEmail: undefined,
    });
    assert.deepEqual(parseActionRunRequest({ actionId: "priority", accountEmail: "" }), {
      actionId: "priority",
      accountEmail: "",
    });
    assert.equal(
      parseUserActionSaveRequest({
        filename: "custom.action.js",
        content: "export default action;",
      }).filename,
      "custom.action.js",
    );
    assert.throws(
      () => parseUserActionSaveRequest({ filename: "../custom.action.ts", content: "x" }),
      /filename/,
    );
  });

  it("validates email list query parameters", () => {
    assert.deepEqual(
      parseEmailListQuery(new URLSearchParams("unreadOnly=true&limit=10&offset=5")),
      {
        unreadOnly: true,
        limit: 10,
        offset: 5,
        accountId: undefined,
      },
    );
    assert.equal(parseEmailListQuery(new URLSearchParams("accountId=")).accountId, "");
    assert.throws(() => parseEmailListQuery(new URLSearchParams("limit=abc")), /limit/);
  });

  it("validates email id requests", () => {
    assert.deepEqual(parseEmailIdRequest({ emailId: "email-1", accountId: "me@example.com" }), {
      emailId: "email-1",
      accountId: "me@example.com",
    });
    assert.deepEqual(parseEmailIdRequest({ emailId: "email-1", accountId: "" }), {
      emailId: "email-1",
      accountId: "",
    });
    assert.throws(() => parseEmailIdRequest({ emailId: "" }), /emailId/);
    assert.throws(() => parseEmailIdRequest({ emailId: "email-1" }), /accountId/);
    assert.deepEqual(parseEmailIdentityQuery(new URLSearchParams("accountId=me%40example.com")), {
      accountId: "me@example.com",
    });
    assert.deepEqual(parseEmailIdentityQuery(new URLSearchParams("accountId=")), {
      accountId: "",
    });
    assert.throws(() => parseEmailIdentityQuery(new URLSearchParams()), /accountId/);
  });

  it("validates approval-ids and snapshot restore requests", () => {
    assert.deepEqual(parseApprovalIdsRequest({ ids: ["op-1", "op-2"] }), {
      ids: ["op-1", "op-2"],
    });
    assert.equal(
      parseSnapshotRestoreRequest({
        snapshotFilename: "custom.action.ts.2026-06-26T10-00-00-000Z.ts",
        originalFilename: "custom.action.ts",
      }).originalFilename,
      "custom.action.ts",
    );
    assert.throws(() => parseApprovalIdsRequest({ ids: [] }), /ids/);
    assert.throws(() => parseApprovalIdsRequest({}), /ids/);
    assert.throws(() => parseApprovalIdsRequest({ ids: ["op-1", 7] }), /ids\[1\]/);
    // A blank id would widen the IN(...) filter over the queue; reject it.
    assert.throws(() => parseApprovalIdsRequest({ ids: ["  "] }), /ids\[0\]/);
    assert.throws(() => parseApprovalIdsRequest(null), /object/);
    assert.throws(() => parseApprovalIdsRequest({ ids: "op-1" }), /ids/);
    assert.deepEqual(parseApprovalIdsRequest({ ids: [" op-1 "] }), {
      ids: ["op-1"],
    });
    // Duplicates would resolve the same queue row twice.
    assert.deepEqual(parseApprovalIdsRequest({ ids: ["op-1", "op-1"] }), {
      ids: ["op-1"],
    });
    assert.throws(
      () =>
        parseApprovalIdsRequest({
          ids: Array.from({ length: 1001 }, (_, i) => `op-${i}`),
        }),
      /more than 1000/,
    );
    assert.throws(
      () =>
        parseSnapshotRestoreRequest({
          snapshotFilename: "../custom.action.ts.2026-06-26T10-00-00-000Z.ts",
          originalFilename: "custom.action.ts",
        }),
      /snapshotFilename/,
    );
  });

  it("validates account and read-status mutations", () => {
    assert.deepEqual(parseAccountPostRequest({ action: "add" }), { action: "add" });
    assert.deepEqual(parseAccountPostRequest({ action: "setDefault", email: "me@example.com" }), {
      action: "setDefault",
      email: "me@example.com",
    });
    assert.deepEqual(parseAccountDeleteRequest({ email: "me@example.com" }), {
      email: "me@example.com",
    });
    assert.deepEqual(parseEmailReadStatusRequest({ isUnread: true }), {
      isUnread: true,
    });
    assert.throws(() => parseAccountPostRequest({ action: "setDefault" }), /email/);
    assert.throws(() => parseEmailReadStatusRequest({ isUnread: "false" }), /isUnread/);
  });

  it("accepts only object settings updates", () => {
    assert.deepEqual(parseSettingsUpdateRequest({ ui: { fetchInterval: 10 } }), {
      ui: { fetchInterval: 10 },
    });
    assert.throws(() => parseSettingsUpdateRequest([]), /object/);
    assert.throws(() => parseSettingsUpdateRequest({ unknown: true }), /Unknown setting/);
    // Legacy nested keys are dropped rather than rejected, like every other section.
    assert.deepEqual(parseSettingsUpdateRequest({ gmail: { syncActions: true } }), {
      gmail: {},
    });
    assert.throws(
      () => parseSettingsUpdateRequest({ gmail: { autoApplyActions: "yes" } }),
      /autoApplyActions/,
    );
    assert.throws(
      () => parseSettingsUpdateRequest({ gmail: { autoApplyAcknowledged: 1 } }),
      /autoApplyAcknowledged/,
    );
    // A null acknowledgement is read as "not acknowledged", never as "keep".
    assert.deepEqual(
      parseSettingsUpdateRequest({ gmail: { autoApplyAcknowledged: null } }),
      { gmail: { autoApplyAcknowledged: false } },
    );
  });

  it("validates a full settings update shape", () => {
    const settings = parseSettingsUpdateRequest({
      agentMode: "hybrid",
      preferredAgent: "codex",
      gcp: {
        projectId: "project",
      },
      prompts: {
        summary: "summary",
        digest: "digest",
      },
      embedding: {
        provider: "openrouter",
        model: "qwen/qwen3-embedding-0.6b",
        dimensions: 768,
      },
      ui: {
        panelWidths: [25, 35, 40],
        fetchInterval: 15,
        fetchScope: "all",
      },
      dataDir: "/tmp/email-agent",
      accounts: [{ email: "me@example.com", name: "Me", isDefault: true }],
      oauth: { clientId: "client", clientSecret: "secret" },
    });

    assert.equal(settings.agentMode, "hybrid");
    assert.equal(settings.prompts?.summary, "summary");
    assert.equal(settings.accounts?.[0]?.isDefault, true);
    assert.equal(settings.oauth?.clientSecret, "secret");
    assert.equal("panelWidths" in settings.ui!, false);
  });

  it("rejects malformed nested settings", () => {
    assert.throws(() => parseSettingsUpdateRequest({ agentMode: "bad" }), /agentMode/);
    assert.throws(() => parseSettingsUpdateRequest({ preferredAgent: "bad" }), /preferredAgent/);
    assert.equal(
      parseSettingsUpdateRequest({ embedding: { dimensions: 1536 } }).embedding?.dimensions,
      768,
    );
    assert.throws(
      () =>
        parseSettingsUpdateRequest({
          ui: {
            fetchInterval: 0,
            fetchScope: "everything",
          },
        }),
      /fetchScope/,
    );
    assert.throws(
      () => parseSettingsUpdateRequest({ notifications: { desktop: { enabled: true } } }),
      /Unknown setting/,
    );
    assert.throws(() => parseSettingsUpdateRequest({ accounts: {} }), /accounts/);
  });

  it("supports partial nested settings updates without resetting omitted fields", () => {
    const update = parseSettingsUpdateRequest({ ui: { fetchInterval: 10 } });
    const merged = mergeSettingsUpdate(
      {
        agentMode: "all-agents",
        preferredAgent: "claude",
        gcp: { projectId: "project" },
        prompts: { summary: "s", digest: "d" },
        embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
        gmail: { autoApplyActions: false, autoApplyAcknowledged: false },
        ui: {
          fetchInterval: 0,
          fetchScope: "all",
        },
        dataDir: "/tmp/email-agent",
        accounts: [],
      },
      update,
    );

    assert.equal(merged.ui.fetchInterval, 10);
    assert.equal(merged.ui.fetchScope, "all");
    assert.equal("panelWidths" in merged.ui, false);
  });

  it("never enables auto-apply without an acknowledgement in the same config", () => {
    const base: AppConfig = {
      agentMode: "all-agents",
      preferredAgent: "claude",
      gcp: { projectId: "" },
      prompts: { summary: "", digest: "" },
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 768 },
      gmail: { autoApplyActions: false, autoApplyAcknowledged: false },
      ui: { fetchInterval: 0, fetchScope: "unread" },
      dataDir: "/tmp/email-agent",
      accounts: [],
    };

    // Toggle alone: rejected.
    const forced = mergeSettingsUpdate(
      base,
      parseSettingsUpdateRequest({ gmail: { autoApplyActions: true } }),
    );
    assert.equal(forced.gmail.autoApplyActions, false);

    // Toggle plus acknowledgement: honored.
    const accepted = mergeSettingsUpdate(
      base,
      parseSettingsUpdateRequest({
        gmail: { autoApplyActions: true, autoApplyAcknowledged: true },
      }),
    );
    assert.equal(accepted.gmail.autoApplyActions, true);

    // Revoking the acknowledgement switches auto-apply back off.
    const revoked = mergeSettingsUpdate(
      { ...base, gmail: { autoApplyActions: true, autoApplyAcknowledged: true } },
      parseSettingsUpdateRequest({ gmail: { autoApplyAcknowledged: false } }),
    );
    assert.equal(revoked.gmail.autoApplyActions, false);
  });

  it("ignores an accounts key in settings updates (managed by account endpoints)", () => {
    const update = parseSettingsUpdateRequest({
      accounts: [{ email: "attacker@example.com", isDefault: true }],
    });
    const merged = mergeSettingsUpdate(
      {
        agentMode: "all-agents",
        preferredAgent: "claude",
        gcp: { projectId: "" },
        prompts: { summary: "", digest: "" },
        embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 768 },
        gmail: { autoApplyActions: false, autoApplyAcknowledged: false },
        ui: {
          fetchInterval: 0,
          fetchScope: "unread",
        },
        dataDir: "/tmp/email-agent",
        accounts: [{ email: "real@example.com", name: "Real", isDefault: true }],
      },
      update,
    );

    // The removed/attacker account must not be written back; current wins.
    assert.deepEqual(merged.accounts, [
      { email: "real@example.com", name: "Real", isDefault: true },
    ]);
  });

  it("accepts direct-api as a preferred agent", () => {
    assert.equal(
      parseSettingsUpdateRequest({ preferredAgent: "direct-api" }).preferredAgent,
      "direct-api",
    );
  });

  it("removes OAuth secrets from settings responses", () => {
    const sanitized = sanitizeSettingsForResponse({
      agentMode: "all-agents",
      preferredAgent: "claude",
      gcp: { projectId: "" },
      prompts: { summary: "", digest: "" },
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      gmail: { autoApplyActions: false, autoApplyAcknowledged: false },
      ui: {
        fetchInterval: 0,
        fetchScope: "unread",
        panelWidths: [20, 35, 45],
      } as never,
      dataDir: "/tmp/email-agent",
      accounts: [],
      oauth: { clientId: "client", clientSecret: "secret" },
      customCliKey: true,
    } as never);

    assert.equal("oauth" in sanitized, false);
    assert.equal("customCliKey" in sanitized, false);
    assert.equal(sanitized.embedding.dimensions, 768);
    assert.equal("panelWidths" in sanitized.ui, false);
  });

  it("never reports auto-apply as on without an acknowledgement", () => {
    // A settings.json hand-edited to the dangerous half of the pair must not
    // surface as an enabled toggle in the UI.
    const base = {
      agentMode: "all-agents",
      preferredAgent: "claude",
      gcp: { projectId: "" },
      prompts: { summary: "", digest: "" },
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 768 },
      ui: { fetchInterval: 0, fetchScope: "unread" },
      dataDir: "/tmp/email-agent",
      accounts: [],
    } as unknown as AppConfig;

    const forced = sanitizeSettingsForResponse({
      ...base,
      gmail: { autoApplyActions: true, autoApplyAcknowledged: false },
    });
    assert.equal(forced.gmail.autoApplyActions, false);
    assert.equal(forced.gmail.autoApplyAcknowledged, false);

    const accepted = sanitizeSettingsForResponse({
      ...base,
      gmail: { autoApplyActions: true, autoApplyAcknowledged: true },
    });
    assert.equal(accepted.gmail.autoApplyActions, true);

    // Acknowledged but not switched on stays off.
    const armedOnly = sanitizeSettingsForResponse({
      ...base,
      gmail: { autoApplyActions: false, autoApplyAcknowledged: true },
    });
    assert.equal(armedOnly.gmail.autoApplyActions, false);
    assert.equal(armedOnly.gmail.autoApplyAcknowledged, true);
  });

  it("blocks cross-site and non-local mutation requests", () => {
    const crossSite = new Request("http://localhost:3847/api/actions", {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(mutationGuardResponse(crossSite)?.status, 403);

    const remoteHost = new Request("http://192.168.1.20:3847/api/actions", {
      method: "POST",
      headers: { origin: "http://192.168.1.20:3847" },
    });
    assert.equal(mutationGuardResponse(remoteHost)?.status, 403);

    const sameOrigin = new Request("http://localhost:3847/api/actions", {
      method: "POST",
      headers: {
        origin: "http://localhost:3847",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(mutationGuardResponse(sameOrigin), undefined);

    const previous = process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
    process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = "1";
    try {
      const allowedRemote = new Request("http://192.168.1.20:3847/api/actions", {
        method: "POST",
        headers: { origin: "http://192.168.1.20:3847" },
      });
      assert.equal(mutationGuardResponse(allowedRemote), undefined);
    } finally {
      if (previous === undefined) {
        delete process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
      } else {
        process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = previous;
      }
    }
  });

  it("refuses a mutation that carries no browser fetch metadata at all", () => {
    // The exact shape the old guard waved through:
    //   curl -X POST -H 'Host: localhost:3847' http://…/api/approvals/apply
    // `Host` is caller-controlled, so `request.url` said "local" and neither
    // Origin nor Sec-Fetch-Site was present to contradict it.
    const headless = new Request("http://localhost:3847/api/approvals/apply", {
      method: "POST",
    });
    const response = mutationGuardResponse(headless);
    assert.equal(response?.status, 403);

    // A real browser always sends at least Sec-Fetch-Site, so the UI is unaffected.
    const browserFetch = new Request("http://localhost:3847/api/approvals/apply", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(mutationGuardResponse(browserFetch), undefined);

    // A same-origin Origin header alone is enough too (older browsers).
    const originOnly = new Request("http://localhost:3847/api/approvals/apply", {
      method: "POST",
      headers: { origin: "http://localhost:3847" },
    });
    assert.equal(mutationGuardResponse(originOnly), undefined);
  });

  it("keeps EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS as the full escape hatch", () => {
    const previous = process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
    process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = "1";
    try {
      // Remote host, no Origin, no Sec-Fetch-Site — the documented deployment
      // where a non-browser client is expected to write.
      const headlessRemote = new Request("http://192.168.1.20:3847/api/approvals/apply", {
        method: "POST",
      });
      assert.equal(mutationGuardResponse(headlessRemote), undefined);
      assert.equal(readGuardResponse(headlessRemote), undefined);
    } finally {
      if (previous === undefined) {
        delete process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
      } else {
        process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = previous;
      }
    }
  });

  it("guards mail reads against non-local and cross-origin callers", () => {
    // GET /api/approvals returns subjects, senders and snippets and used to have
    // no guard at all, so any page the user visited could read the queue.
    const crossOrigin = new Request("http://localhost:3847/api/approvals", {
      headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
    });
    assert.equal(readGuardResponse(crossOrigin)?.status, 403);

    const rebound = new Request("http://evil.example.com:3847/api/approvals");
    assert.equal(readGuardResponse(rebound)?.status, 403);

    const sameOrigin = new Request("http://localhost:3847/api/approvals", {
      headers: { origin: "http://localhost:3847", "sec-fetch-site": "same-origin" },
    });
    assert.equal(readGuardResponse(sameOrigin), undefined);

    // Typed into the address bar: Sec-Fetch-Site: none, no Origin. Reads stay
    // reachable for local debugging — unlike mutations, they are not required
    // to prove they came from the UI.
    const addressBar = new Request("http://localhost:3847/api/approvals", {
      headers: { "sec-fetch-site": "none" },
    });
    assert.equal(readGuardResponse(addressBar), undefined);
    assert.equal(readGuardResponse(new Request("http://127.0.0.1:3847/api/approvals")), undefined);
  });

  it("returns generic internal errors", async () => {
    const originalError = console.error;
    console.error = () => {};
    let response: Response;
    try {
      response = internalErrorResponse(new Error("/tmp/secret/token.json"));
    } finally {
      console.error = originalError;
    }
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error.includes("/tmp"), false);
  });
});
