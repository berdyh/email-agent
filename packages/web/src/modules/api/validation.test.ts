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
  parseStrandedResolutionRequest,
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

  // ---------------------------------------------------------------------
  // Local-only guards.
  //
  // SHAPE MATTERS HERE. In an installed Next server the route handler never
  // sees the caller's host in `request.url`: `attachRequestMeta` composes the
  // URL from the server's own configured hostname, which the render server
  // defaults to `localhost`. Measured against this app, `new URL(request.url)`
  // reads `http://localhost:3847` for EVERY request under both
  // `next dev --hostname 127.0.0.1` and `next start --hostname 127.0.0.1`.
  //
  // So every request below is built with that fixed URL and a separate `host`
  // header, which is the only place the caller's real target appears. The
  // previous tests constructed `new Request("http://evil.example…")`, a shape
  // the runtime never produces, and so passed while the running server let a
  // rebound read through and refused the browser at 127.0.0.1.
  // ---------------------------------------------------------------------

  /** The origin Next hands the handler, regardless of what the caller sent. */
  const NEXT_URL = "http://localhost:3847";

  function serverRequest(
    path: string,
    options: {
      host: string;
      origin?: string;
      fetchSite?: string;
      method?: string;
    },
  ): Request {
    const headers: Record<string, string> = { host: options.host };
    if (options.origin !== undefined) headers["origin"] = options.origin;
    if (options.fetchSite !== undefined) headers["sec-fetch-site"] = options.fetchSite;
    return new Request(`${NEXT_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
    });
  }

  function withRemoteAllowed(body: () => void): void {
    const previous = process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
    process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = "1";
    try {
      body();
    } finally {
      if (previous === undefined) {
        delete process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"];
      } else {
        process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = previous;
      }
    }
  }

  it("accepts both local addresses the server is reachable at", () => {
    // The regression: `http://127.0.0.1:3847` is the URL Next and
    // `email-agent serve` PRINT, and every mutation from that tab used to be
    // refused with "Cross-origin mutation requests are not allowed" because the
    // guard compared the Origin against Next's `localhost` URL.
    for (const host of ["localhost:3847", "127.0.0.1:3847", "[::1]:3847"]) {
      const hostname = host.slice(0, host.lastIndexOf(":"));
      const request = serverRequest("/api/approvals/apply", {
        method: "POST",
        host,
        origin: `http://${hostname}:3847`,
        fetchSite: "same-origin",
      });
      assert.equal(mutationGuardResponse(request), undefined, host);
      assert.equal(readGuardResponse(request), undefined, host);
    }
  });

  it("refuses a DNS-rebound page, on reads as well as mutations", () => {
    // A page on evil.example that rebinds the name to 127.0.0.1 is same-origin
    // WITH ITSELF, so its fetches carry no Origin and `Sec-Fetch-Site:
    // same-origin`. The `Host` header is the only thing that gives it away, and
    // the read guard used to answer 200 with the whole approval queue.
    const rebound = serverRequest("/api/approvals", {
      host: "evil.example:3847",
      fetchSite: "same-origin",
    });
    assert.equal(readGuardResponse(rebound)?.status, 403);

    const reboundWrite = serverRequest("/api/approvals/apply", {
      method: "POST",
      host: "evil.example:3847",
      origin: "http://evil.example:3847",
      fetchSite: "same-origin",
    });
    assert.equal(mutationGuardResponse(reboundWrite)?.status, 403);
  });

  it("does not let X-Forwarded-Host talk a rebound host back into the allowlist", () => {
    // `x-forwarded-host` is not a forbidden header name, so the rebound page can
    // set it. Nothing proxies this app, so the guard must ignore it.
    const spoofed = new Request(`${NEXT_URL}/api/approvals`, {
      headers: {
        host: "evil.example:3847",
        "x-forwarded-host": "localhost:3847",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(readGuardResponse(spoofed)?.status, 403);
  });

  it("refuses another app sharing loopback on a different port", () => {
    const otherLocalApp = serverRequest("/api/approvals/apply", {
      method: "POST",
      host: "localhost:3847",
      origin: "http://localhost:8080",
      fetchSite: "same-origin",
    });
    assert.equal(mutationGuardResponse(otherLocalApp)?.status, 403);
  });

  it("refuses cross-site metadata and opaque origins", () => {
    const crossSite = serverRequest("/api/actions", {
      method: "POST",
      host: "localhost:3847",
      origin: "https://example.com",
      fetchSite: "cross-site",
    });
    assert.equal(mutationGuardResponse(crossSite)?.status, 403);

    // A sandboxed iframe sends the literal string "null" as its Origin.
    const opaque = serverRequest("/api/actions", {
      method: "POST",
      host: "localhost:3847",
      origin: "null",
      fetchSite: "same-origin",
    });
    assert.equal(mutationGuardResponse(opaque)?.status, 403);

    // Junk in the Host header must fail closed rather than throw.
    const junkHost = serverRequest("/api/approvals", { host: "not a host/path" });
    assert.equal(readGuardResponse(junkHost)?.status, 403);
  });

  it("refuses a mutation that carries no browser fetch metadata at all", () => {
    // The exact shape the old guard waved through:
    //   curl -X POST -H 'Host: localhost:3847' http://…/api/approvals/apply
    const headless = serverRequest("/api/approvals/apply", {
      method: "POST",
      host: "localhost:3847",
    });
    assert.equal(mutationGuardResponse(headless)?.status, 403);

    // Reads deliberately stay reachable without it, so the address bar and
    // local debugging still work.
    assert.equal(readGuardResponse(headless), undefined);

    // Either header on its own is enough for a mutation: Safari only shipped
    // Fetch Metadata in 16.4, so Origin has to be sufficient by itself.
    for (const headerSet of [{ fetchSite: "same-origin" }, { origin: "http://localhost:3847" }]) {
      const browserFetch = serverRequest("/api/approvals/apply", {
        method: "POST",
        host: "localhost:3847",
        ...headerSet,
      });
      assert.equal(mutationGuardResponse(browserFetch), undefined);
    }
  });

  it("keeps EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS as the full escape hatch", () => {
    withRemoteAllowed(() => {
      // The real LAN shape: `serve --host 0.0.0.0` makes Next's own URL
      // `http://0.0.0.0:3847`, while the browser addresses the LAN IP. Comparing
      // the Origin against Next's URL used to 403 this even with the flag on.
      const lanBrowser = new Request("http://0.0.0.0:3847/api/approvals/apply", {
        method: "POST",
        headers: {
          host: "192.168.1.20:3847",
          origin: "http://192.168.1.20:3847",
          "sec-fetch-site": "same-origin",
        },
      });
      assert.equal(mutationGuardResponse(lanBrowser), undefined);
      assert.equal(readGuardResponse(lanBrowser), undefined);

      // And the headless client the flag exists for.
      const headlessRemote = new Request("http://0.0.0.0:3847/api/approvals/apply", {
        method: "POST",
        headers: { host: "192.168.1.20:3847" },
      });
      assert.equal(mutationGuardResponse(headlessRemote), undefined);
      assert.equal(readGuardResponse(headlessRemote), undefined);
    });
  });

  it("guards mail reads against non-local and cross-origin callers", () => {
    // GET /api/approvals returns subjects, senders and snippets.
    const crossOrigin = serverRequest("/api/approvals", {
      host: "localhost:3847",
      origin: "https://example.com",
      fetchSite: "cross-site",
    });
    assert.equal(readGuardResponse(crossOrigin)?.status, 403);

    const remote = serverRequest("/api/approvals", { host: "192.168.1.20:3847" });
    assert.equal(readGuardResponse(remote)?.status, 403);

    // Typed into the address bar: Sec-Fetch-Site: none, no Origin.
    const addressBar = serverRequest("/api/approvals", {
      host: "127.0.0.1:3847",
      fetchSite: "none",
    });
    assert.equal(readGuardResponse(addressBar), undefined);
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

describe("stranded-row adjudication requests", () => {
  it("requires one of the two answers a person can actually give", () => {
    assert.deepEqual(parseStrandedResolutionRequest({ ids: ["a"], decision: "applied" }), {
      ids: ["a"],
      decision: "applied",
    });
    assert.deepEqual(parseStrandedResolutionRequest({ ids: ["a"], decision: "notApplied" }), {
      ids: ["a"],
      decision: "notApplied",
    });
  });

  it("refuses a missing or invented decision rather than guessing one", () => {
    // Both answers assert something about the user's mailbox that only they can
    // know, so there is no safe default to fall back to.
    assert.throws(() => parseStrandedResolutionRequest({ ids: ["a"] }), /decision/);
    assert.throws(
      () => parseStrandedResolutionRequest({ ids: ["a"], decision: "retry" }),
      /decision/,
    );
  });

  it("applies the same id hygiene as the approve/reject routes", () => {
    assert.throws(() => parseStrandedResolutionRequest({ ids: [], decision: "applied" }), /ids/);
    assert.deepEqual(
      parseStrandedResolutionRequest({ ids: ["a", "a"], decision: "applied" }).ids,
      ["a"],
    );
  });
});
