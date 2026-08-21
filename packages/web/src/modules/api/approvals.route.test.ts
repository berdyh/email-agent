// A TEST THAT GOES THROUGH A SURFACE — the web half.
//
// Every wording the approval surfaces show is pinned by a pure function
// (`approvals-contract.ts`, `action-run-contract.ts`) and every queue rule is
// pinned in core. What nothing checked was the JOIN: that the route still calls
// the thing, still returns the field the client's type says it returns, and
// still maps a core outcome onto the right status code. A route that stopped
// returning `label`, or answered 200 where the client expects 409, broke
// nothing in the suite.
//
// These run the real handlers, over a real temp-directory LanceDB, seeded
// through core's own write paths.
//
// WHAT IS REAL AND WHAT IS NOT. Everything below the handler is real: the
// queue, the claim/lease, the email join, the retention sweep. Gmail is not
// stubbed either — the temp `$HOME` holds no stored tokens, so
// `createGmailClient` throws locally (no network) and `applyOperations` records
// a per-operation failure. That is a genuine terminal path through the whole
// stack and it is the one the apply cases assert; a SUCCESSFUL Gmail mutation
// is not reachable from here and is not claimed.
//
// STILL NOT COVERED, and not implied anywhere below: React. There is no
// component testing library in this repo, so `ApprovalPanel` and
// `StrandedOperationsPanel` are never rendered by any test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  startRouteHarness,
} from "./testing/route-harness.js";
import type {
  ApplyApprovalsResult,
  ApprovalsResponse,
  RejectApprovalsResult,
  ResolveStrandedResult,
  StrandedApprovalsResponse,
} from "./approvals-contract.js";

const harness = await startRouteHarness("approvals-routes");

type Handler = (
  request: import("next/server").NextRequest,
) => Promise<Response>;

const list = await harness.load<{ GET: Handler }>("app/api/approvals/route.js");
const count = await harness.load<{ GET: Handler }>(
  "app/api/approvals/count/route.js",
);
const apply = await harness.load<{ POST: Handler }>(
  "app/api/approvals/apply/route.js",
);
const reject = await harness.load<{ POST: Handler }>(
  "app/api/approvals/reject/route.js",
);
const stranded = await harness.load<{ GET: Handler; POST: Handler }>(
  "app/api/approvals/stranded/route.js",
);

const { STALE_APPLYING_THRESHOLD_MS } = await import("@email-agent/core/db");

describe("GET /api/approvals", () => {
  it("returns the queued changes joined to their emails, described by core", async () => {
    await harness.db.seedEmails([
      {
        id: "w-m1",
        accountId: "me@example.com",
        subject: "Cheap watches",
        from: "spam@example.com",
        snippet: "buy now",
      },
    ]);
    await harness.db.seedPendingOperations([
      {
        id: "w-op1",
        emailId: "w-m1",
        accountId: "me@example.com",
        type: "trash",
        actionName: "Junk Detector",
        status: "pending",
      },
      {
        id: "w-op2",
        emailId: "w-m1",
        accountId: "me@example.com",
        type: "removeLabels",
        labelIds: '["INBOX"]',
        status: "pending",
      },
      // A row whose email is not in the local DB — the surface must still list
      // it rather than dropping a queued Gmail mutation.
      {
        id: "w-op3",
        emailId: "w-missing",
        accountId: "me@example.com",
        type: "spam",
        status: "pending",
      },
      { id: "w-done", emailId: "w-m1", status: "applied", resolvedAt: "2026-08-02T00:00:00.000Z" },
    ]);

    const result = await callHandler<ApprovalsResponse>(
      list.GET,
      buildRequest("/api/approvals"),
    );
    assert.equal(result.status, 200);

    const byId = new Map(result.body.operations.map((op) => [op.id, op]));
    assert.deepEqual([...byId.keys()].sort(), ["w-op1", "w-op2", "w-op3"]);
    assert.equal(result.body.pendingCount, 3);

    // The human sentence comes from core's `describeGmailOperation`, so the
    // route calling something else would show here.
    assert.equal(byId.get("w-op1")?.label, "Move to Trash");
    assert.equal(byId.get("w-op2")?.label, "Archive");
    assert.equal(byId.get("w-op1")?.destructive, true);
    assert.equal(byId.get("w-op2")?.destructive, false);

    // The email join, which is what the panel renders under each change.
    assert.equal(byId.get("w-op1")?.email?.subject, "Cheap watches");
    assert.equal(byId.get("w-op1")?.email?.from, "spam@example.com");
    assert.equal(
      byId.get("w-op3")?.email,
      null,
      "a queued change for mail we no longer hold must still be listed, with a null email",
    );
    // labelIds arrives parsed, not as the stored JSON string.
    assert.deepEqual(byId.get("w-op2")?.labelIds, ["INBOX"]);
  });

  it("is refused cross-origin, because it returns subjects and senders", async () => {
    const result = await callHandler(
      list.GET,
      buildRequest("/api/approvals", {
        sameOrigin: false,
        headers: { origin: "http://evil.example" },
      }),
    );
    assert.equal(result.status, 403);
  });

  it("is refused for a rebound Host header", async () => {
    const result = await callHandler(
      list.GET,
      buildRequest("/api/approvals", {
        sameOrigin: false,
        headers: { host: "evil.example" },
      }),
    );
    assert.equal(result.status, 403);
  });
});

describe("GET /api/approvals/count", () => {
  it("agrees with the list it is the badge for", async () => {
    const badge = await callHandler<{ pendingCount: number }>(
      count.GET,
      buildRequest("/api/approvals/count"),
    );
    const full = await callHandler<ApprovalsResponse>(
      list.GET,
      buildRequest("/api/approvals"),
    );
    assert.equal(badge.status, 200);
    assert.equal(
      badge.body.pendingCount,
      full.body.pendingCount,
      "the sidebar badge and the panel are served by different endpoints; a " +
        "disagreement is a user being told N changes await approval with no way to see them",
    );
  });
});

describe("POST /api/approvals/reject", () => {
  it("rejects the named rows, leaves the rest, and reports what it claimed", async () => {
    await harness.db.seedPendingOperations([
      { id: "w-rej1", status: "pending" },
      { id: "w-rej2", status: "pending" },
    ]);

    const result = await callHandler<RejectApprovalsResult>(
      reject.POST,
      buildRequest("/api/approvals/reject", {
        method: "POST",
        body: { ids: ["w-rej1"] },
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { rejected: 1, requested: 1, skipped: 0 });

    assert.equal((await harness.db.readPendingOperation("w-rej1")).status, "rejected");
    assert.equal((await harness.db.readPendingOperation("w-rej2")).status, "pending");
  });

  it("reports a second rejection of the same row as skipped, not as done again", async () => {
    const result = await callHandler<RejectApprovalsResult>(
      reject.POST,
      buildRequest("/api/approvals/reject", {
        method: "POST",
        body: { ids: ["w-rej1"] },
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { rejected: 0, requested: 1, skipped: 1 });
  });

  it("refuses a bare POST and a malformed body", async () => {
    const bare = await callHandler(
      reject.POST,
      buildRequest("/api/approvals/reject", {
        method: "POST",
        body: { ids: ["w-rej2"] },
        sameOrigin: false,
      }),
    );
    assert.equal(bare.status, 403);

    const bad = await callHandler<{ error: string }>(
      reject.POST,
      buildRequest("/api/approvals/reject", { method: "POST", body: { ids: [] } }),
    );
    assert.equal(bad.status, 400);

    // And the guard really did stop the first one before core ran.
    assert.equal((await harness.db.readPendingOperation("w-rej2")).status, "pending");
  });
});

describe("POST /api/approvals/apply", () => {
  it("claims, calls Gmail, and records the terminal outcome on each row", async () => {
    await harness.db.seedPendingOperations([
      { id: "w-app1", accountId: "me@example.com", emailId: "w-m1", status: "pending" },
    ]);

    const result = await callHandler<ApplyApprovalsResult>(
      apply.POST,
      buildRequest("/api/approvals/apply", {
        method: "POST",
        body: { ids: ["w-app1"] },
      }),
    );

    // 200 with `failed > 0` is the DELIBERATE status for "the server owned
    // every row it was given, called Gmail for each, and recorded a terminal
    // result". The per-operation reasons only survive on a 2xx — the client's
    // error path collapses a non-2xx into one Error and throws `outcomes` away.
    assert.equal(result.status, 200);
    assert.equal(result.body.requested, 1);
    assert.equal(result.body.skipped, 0);
    assert.equal(result.body.applied, 0);
    assert.equal(result.body.failed, 1);
    assert.equal(result.body.outcomes.length, 1);
    assert.equal(result.body.outcomes[0]?.ok, false);
    assert.equal(result.body.errors.length, 1);

    // The row is terminal — `failed`, not `pending` and not stuck in
    // `applying`. Nothing else in the app can act on it, which is the point.
    const row = await harness.db.readPendingOperation("w-app1");
    assert.equal(row.status, "failed");
    assert.ok(row.error.length > 0, "the Gmail error text must be kept on the row");
    assert.notEqual(row.resolvedAt, "");
  });

  it("answers 409 when it could claim nothing, rather than 'Applied 0 changes'", async () => {
    // The row is already terminal from the case above.
    const result = await callHandler<ApplyApprovalsResult & { error: string }>(
      apply.POST,
      buildRequest("/api/approvals/apply", {
        method: "POST",
        body: { ids: ["w-app1"] },
      }),
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.applied, 0);
    assert.equal(result.body.failed, 0);
    assert.equal(result.body.skipped, 1);
    assert.match(result.body.error, /None of the 1 selected change could be claimed/);
    // The message must not assert WHY — the row could equally be mid-apply.
    assert.match(result.body.error, /may already have been applied or rejected/);
  });

  it("refuses more ids than one request may reasonably carry", async () => {
    const result = await callHandler<{ error: string }>(
      apply.POST,
      buildRequest("/api/approvals/apply", {
        method: "POST",
        body: { ids: Array.from({ length: 1001 }, (_, i) => `x-${String(i)}`) },
      }),
    );
    assert.equal(result.status, 400);
  });
});

describe("/api/approvals/stranded", () => {
  it("lists rows a crash left mid-apply, which no other surface shows", async () => {
    await harness.db.seedPendingOperations([
      {
        id: "w-str1",
        emailId: "w-m1",
        accountId: "me@example.com",
        type: "trash",
        status: "applying",
        claimToken: "dead-process",
      },
      // Claimed a moment ago by a healthy apply — must NOT be listed.
      {
        id: "w-str-fresh",
        emailId: "w-m1",
        status: "applying",
        claimToken: "live",
        claimedAt: new Date().toISOString(),
      },
    ]);
    await harness.db.backdateClaim("w-str1", STALE_APPLYING_THRESHOLD_MS + 60_000);

    const result = await callHandler<StrandedApprovalsResponse>(
      stranded.GET,
      buildRequest("/api/approvals/stranded"),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.operations.map((op) => op.id),
      ["w-str1"],
    );
    assert.equal(result.body.thresholdMinutes, 15);
    // The panel ages the row off this field.
    assert.ok(result.body.operations[0]?.claimedAt);
    assert.equal(result.body.operations[0]?.label, "Move to Trash");

    // And these rows are invisible to the pending list, which is the whole
    // reason this endpoint exists.
    const pending = await callHandler<ApprovalsResponse>(
      list.GET,
      buildRequest("/api/approvals"),
    );
    assert.equal(
      pending.body.operations.some((op) => op.id === "w-str1"),
      false,
    );
  });

  it("records the user's answer and reports what it actually wrote", async () => {
    const result = await callHandler<ResolveStrandedResult>(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str1"], decision: "applied" },
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      decision: "applied",
      requested: 1,
      resolved: 1,
      skipped: 0,
    });

    const row = await harness.db.readPendingOperation("w-str1");
    assert.equal(row.status, "applied");
    assert.match(
      row.error,
      /Email Agent did not verify this with Gmail/,
      "the audit trail must never imply the app checked",
    );
  });

  it("reports resolved:0 for a snapshot that has gone stale, not an error", async () => {
    const result = await callHandler<ResolveStrandedResult>(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str1"], decision: "notApplied" },
      }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.resolved, 0);
    assert.equal(result.body.skipped, 1);
    // The row keeps the answer that was already recorded.
    assert.equal((await harness.db.readPendingOperation("w-str1")).status, "applied");
  });

  it("refuses a row that is claimed but not yet stale", async () => {
    const result = await callHandler<ResolveStrandedResult>(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str-fresh"], decision: "notApplied" },
      }),
    );
    assert.equal(result.body.resolved, 0);
    assert.equal(
      (await harness.db.readPendingOperation("w-str-fresh")).claimToken,
      "live",
      "an in-flight apply's claim must survive an adjudication aimed at it",
    );
  });

  it("refuses an invented decision rather than guessing one", async () => {
    const result = await callHandler<{ error: string }>(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str1"], decision: "retry" },
      }),
    );
    assert.equal(result.status, 400);
  });

  it("refuses a bare POST and a malformed body", async () => {
    const bare = await callHandler(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str1"], decision: "applied" },
        sameOrigin: false,
      }),
    );
    assert.equal(bare.status, 403);

    const badShape = await callHandler(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        body: { ids: ["w-str1"] },
      }),
    );
    assert.equal(badShape.status, 400, "a well-formed body with a bad shape is a 400");

    // MALFORMED JSON IS A 400, NOT A 500. Every mutating route now parses its
    // body through `parseJsonBody` (`modules/api/validation.ts`), which catches
    // the `SyntaxError` `request.json()` throws for invalid JSON and turns it
    // into a `RequestValidationError` — the same shape `validationResponse`
    // already maps to 400 for a well-formed-but-wrong-shaped body. A client
    // that sends junk is told its body was rejected, not that the server broke,
    // and nothing is logged for a request that never reached anything worth
    // erroring about.
    const malformed = await callHandler<{ error: string }>(
      stranded.POST,
      buildRequest("/api/approvals/stranded", {
        method: "POST",
        rawBody: "{not json",
      }),
    );
    assert.equal(malformed.status, 400);
    assert.match(
      malformed.body.error,
      /valid JSON/,
      "must read differently from the bad-shape 400 above it",
    );
  });
});
