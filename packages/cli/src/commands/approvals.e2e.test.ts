// A TEST THAT GOES THROUGH A SURFACE — the CLI half.
//
// `approvals.test.ts` next door calls the exported functions directly and pins
// every sentence they build. That is real coverage of the WORDS and none at all
// of the WIRING: nothing failed if `registerApprovals` stopped calling
// `describeStrandedResolution`, if a command stopped reading the queue, or if
// an exit code changed.
//
// The stranded-row half lives in `approvals-stranded.e2e.test.ts`; the split is
// wall-clock only, since `node --test` parallelises files rather than cases.
//
// These run the BUILT binary (`packages/cli/dist/index.js`, which `npm test`
// now builds) as a real child process against a real temp-directory LanceDB,
// and assert on stdout, stderr, the exit code and the rows left behind.
//
// GMAIL IS ABSENT THE WAY IT IS FOR A USER WITH NO LINKED ACCOUNT. The temp
// `$HOME` holds no stored tokens, so `createGmailClient` throws locally — no
// network call is made — and `applyOperations` records a per-operation failure.
// A SUCCESSFUL Gmail mutation is therefore not reachable from here and nothing
// below claims one; what is covered is the claim, the resolution, the reporting
// and the exit code.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const cli = await startCli("approvals");

await cli.seed({
  emails: [
    {
      id: "e2e-m1",
      accountId: "me@example.com",
      subject: "Win a free cruise",
      from: "spam@example.com",
      snippet: "click here",
    },
    {
      id: "e2e-m2",
      accountId: "me@example.com",
      subject: "Weekly newsletter",
      from: "news@example.com",
    },
  ],
});

describe("email-agent approvals list", () => {
  it("says the queue is empty when it is", async () => {
    const result = await cli.run(["approvals", "list"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /No Gmail changes awaiting approval/);
  });

  it("prints each queued change with the sentence core wrote and the email's subject", async () => {
    await cli.seed({
      pendingOperations: [
        {
          id: "e2e-op1",
          batchId: "e2e-batch-aaaaaaaa",
          actionName: "Junk Detector",
          emailId: "e2e-m1",
          accountId: "me@example.com",
          type: "trash",
          status: "pending",
        },
        {
          id: "e2e-op2",
          batchId: "e2e-batch-aaaaaaaa",
          actionName: "Junk Detector",
          emailId: "e2e-m2",
          accountId: "me@example.com",
          type: "removeLabels",
          labelIds: '["INBOX"]',
          status: "pending",
        },
      ],
    });

    const result = await cli.run(["approvals", "list"]);
    assert.equal(result.exitCode, 0);
    // Core's `describeGmailOperation`, reached through the command.
    assert.match(result.output, /Move to Trash/);
    assert.match(result.output, /Archive/);
    // The batched email lookup, reached through the command.
    assert.match(result.output, /Win a free cruise/);
    assert.match(result.output, /Weekly newsletter/);
    // The batch header, and the next step.
    assert.match(result.output, /Junk Detector/);
    assert.match(result.output, /approvals review/);
  });

  it("is the default subcommand, so a bare `approvals` lists too", async () => {
    const bare = await cli.run(["approvals"]);
    assert.match(bare.output, /Move to Trash/);
  });
});

describe("email-agent approvals reject", () => {
  it("rejects the queue and leaves an audit row, not a deletion", async () => {
    const result = await cli.run(["approvals", "reject", "--batch", "e2e-batch"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Rejected 2 pending changes/);

    const rows = await cli.queue();
    const rejected = rows.filter((row) => row.status === "rejected");
    assert.deepEqual(
      rejected.map((row) => row.id).sort(),
      ["e2e-op1", "e2e-op2"],
      "a rejected proposal is kept as an audit trail, never deleted",
    );

    const after = await cli.run(["approvals", "list"]);
    assert.match(after.output, /No Gmail changes awaiting approval/);
  });

  it("refuses an ambiguous batch prefix rather than acting on more than was named", async () => {
    await cli.seed({
      pendingOperations: [
        { id: "e2e-amb1", batchId: "dup-1111", emailId: "e2e-m1", status: "pending" },
        { id: "e2e-amb2", batchId: "dup-2222", emailId: "e2e-m2", status: "pending" },
      ],
    });

    const result = await cli.run(["approvals", "reject", "--batch", "dup"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /matches 2 batches/);
    assert.match(result.output, /longer prefix/);

    const rows = await cli.queue();
    assert.equal(
      rows.filter((row) => row.id.startsWith("e2e-amb") && row.status === "pending")
        .length,
      2,
      "nothing may be rejected on an ambiguous prefix",
    );
  });
});

describe("email-agent approvals apply", () => {
  it("does nothing when the confirmation is not `y`", async () => {
    const result = await cli.run(["approvals", "apply", "--batch", "dup-1111"], {
      stdin: "n\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Skipped — changes stay pending/);
    const rows = await cli.queue();
    assert.equal(
      rows.find((row) => row.id === "e2e-amb1")?.status,
      "pending",
    );
  });

  it("claims, calls Gmail, records the failure and exits non-zero", async () => {
    // A Gmail failure is a FAILURE, not a success with a note. The exit code
    // used to be taken only from a thrown exception, so shell automation was
    // told everything worked while nothing had been changed.
    const result = await cli.run(["approvals", "apply", "--batch", "dup-1111"], {
      stdin: "y\n",
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /1 failed/);

    const row = (await cli.queue()).find((entry) => entry.id === "e2e-amb1");
    assert.equal(row?.status, "failed", "a terminal row, not one stuck in `applying`");
    assert.ok((row?.error ?? "").length > 0);
    assert.notEqual(row?.resolvedAt, "");
  });
});

describe("email-agent approvals review", () => {
  it("applies the y answers, rejects the n answers, and leaves s pending", async () => {
    await cli.seed({
      pendingOperations: [
        { id: "e2e-rev1", batchId: "rev-1111", emailId: "e2e-m1", status: "pending" },
        { id: "e2e-rev2", batchId: "rev-1111", emailId: "e2e-m2", status: "pending" },
        { id: "e2e-rev3", batchId: "rev-1111", emailId: "e2e-m1", type: "spam", status: "pending" },
      ],
    });

    // The queue is ordered newest-first then by batch then by id, so the three
    // rows are presented rev1, rev2, rev3.
    const result = await cli.run(["approvals", "review", "--batch", "rev-1111"], {
      stdin: "y\nn\ns\n",
    });

    const rows = await cli.queue();
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get("e2e-rev1")?.status, "failed", "approved, then Gmail refused");
    assert.equal(byId.get("e2e-rev2")?.status, "rejected");
    assert.equal(
      byId.get("e2e-rev3")?.status,
      "pending",
      "an unanswered change stays queued — skipping is never a decision",
    );
    assert.match(result.output, /1 changes left pending/);
    // A per-operation Gmail failure must still be a non-zero exit.
    assert.equal(result.exitCode, 1);
  });
});
