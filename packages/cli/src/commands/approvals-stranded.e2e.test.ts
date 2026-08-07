// A TEST THAT GOES THROUGH A SURFACE — the CLI half, stranded rows.
//
// Split from `approvals.e2e.test.ts` purely for wall-clock: each CLI case is a
// real process spawn, and `node --test` parallelises FILES, not cases within
// one. Same harness, its own temp `$HOME`.
//
// `approvals.test.ts` calls the exported functions directly and pins every
// sentence they build. That is real coverage of the WORDS and none at all
// of the WIRING: nothing failed if `registerApprovals` stopped calling
// `describeStrandedResolution`, if a command stopped reading the queue, or if
// an exit code changed.
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

const cli = await startCli("stranded");

/** 16 minutes, comfortably past the 15-minute staleness threshold. */
const STALE_MS = 16 * 60 * 1000;

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

describe("email-agent approvals stranded", () => {
  it("lists a row a crash left mid-apply and exits non-zero", async () => {
    await cli.seed({
      pendingOperations: [
        {
          id: "e2e-str1",
          batchId: "str-1111",
          emailId: "e2e-m1",
          accountId: "me@example.com",
          type: "trash",
          status: "applying",
          claimToken: "dead-process",
        },
      ],
      backdateClaims: { ids: ["e2e-str1"], ms: STALE_MS },
    });

    const result = await cli.run(["approvals", "stranded"]);
    assert.equal(
      result.exitCode,
      1,
      "an unresolved change to the user's mailbox is a non-zero condition",
    );
    assert.match(result.output, /stuck mid-apply/);
    assert.match(result.output, /It has not checked and it cannot/);
    assert.match(result.output, /Win a free cruise/);
    assert.match(result.output, /stuck for 16 minutes/);
    assert.match(result.output, /stranded --review/);
  });

  it("says so from `approvals list` too, which otherwise reports silence", async () => {
    // `approvals list` is scoped to `pending`, so before this it said "No Gmail
    // changes awaiting approval" while a change with an unknown effect on the
    // mailbox sat in the table.
    const result = await cli.run(["approvals", "list"]);
    assert.match(result.output, /stuck mid-apply/);
    assert.match(result.output, /approvals stranded/);
  });

  it("records `yes` on the user's word, and says it did not check", async () => {
    const result = await cli.run(["approvals", "stranded", "--review"], {
      stdin: "y\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /on your word/);
    assert.match(result.output, /did not check Gmail/);

    const row = (await cli.queue()).find((entry) => entry.id === "e2e-str1");
    assert.equal(row?.status, "applied");
    assert.match(String(row?.error), /Email Agent did not verify this with Gmail/);
  });

  it("requeues on `no`, and leaves the row alone on anything else", async () => {
    await cli.seed({
      pendingOperations: [
        {
          id: "e2e-str2",
          batchId: "str-2222",
          emailId: "e2e-m1",
          status: "applying",
          claimToken: "dead-2",
        },
        {
          id: "e2e-str3",
          batchId: "str-2222",
          emailId: "e2e-m2",
          status: "applying",
          claimToken: "dead-3",
        },
      ],
      backdateClaims: { ids: ["e2e-str2", "e2e-str3"], ms: STALE_MS },
    });

    const result = await cli.run(["approvals", "stranded", "--review"], {
      stdin: "n\ns\n",
    });
    assert.match(result.output, /back in the approval queue/);
    assert.match(result.output, /1 left stuck/);
    assert.equal(result.exitCode, 1, "a row left stuck keeps the non-zero exit");

    const byId = new Map((await cli.queue()).map((row) => [row.id, row]));
    assert.equal(byId.get("e2e-str2")?.status, "pending");
    assert.equal(byId.get("e2e-str2")?.claimToken, "");
    assert.equal(
      byId.get("e2e-str3")?.status,
      "applying",
      "skipping must change nothing at all",
    );
    assert.equal(byId.get("e2e-str3")?.claimToken, "dead-3");
  });

  it("reports nothing stuck once the last row is answered", async () => {
    await cli.run(["approvals", "stranded", "--review"], { stdin: "y\n" });
    const result = await cli.run(["approvals", "stranded"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /No Gmail changes are stuck mid-apply/);
  });
});
