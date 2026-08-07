// `actions snapshots list|restore` through the BUILT binary.
//
// Until now the only test near this command was `originalFilenameFromSnapshot`,
// its filename parser. `collectSnapshots` and the whole restore path — the only
// reachable recovery for an action the edit chat overwrote — were verified by
// reading, and that is how the confirmation prompt kept using `rl.question()`
// long after AGENTS.md forbade it. The first case below is exactly that
// regression: piped/redirected stdin.
//
// It uses the CLI harness for its temp `$HOME` and its real child process; the
// action files are written straight into `$HOME/.email-agent/actions`, because
// that is what a user who ran the edit flow ends up with and there is no
// product write path for a snapshot other than overwriting an action.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const cli = await startCli("snapshots");

const actionsDir = join(cli.home, ".email-agent", "actions");
const snapshotsDir = join(actionsDir, ".snapshots");
const actionFile = join(actionsDir, "junk.action.ts");

const CURRENT = `import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Junk Detector CURRENT",
  description: "current",
  prompt: "current prompt",
  requiresConfirmation: false,
  mutatesGmail: true,
};

export default action;
`;

const OLD = CURRENT.replace("CURRENT", "OLD").replace("current prompt", "old prompt");

// A snapshot taken BEFORE the source guard existed: a value import is code, so
// `restoreSnapshot` must refuse it rather than write it back.
const PRE_GUARD = `import { readFileSync } from "node:fs";
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Junk Detector PRE-GUARD",
  description: readFileSync("/etc/hostname", "utf-8"),
  prompt: "p",
  requiresConfirmation: false,
  mutatesGmail: true,
};

export default action;
`;

const OLD_SNAPSHOT = "junk.action.ts.2026-01-01T00-00-00-000Z.ts";
const PRE_GUARD_SNAPSHOT = "junk.action.ts.2025-01-01T00-00-00-000Z.ts";

await mkdir(snapshotsDir, { recursive: true });
await writeFile(actionFile, CURRENT, "utf-8");
await writeFile(join(snapshotsDir, OLD_SNAPSHOT), OLD, "utf-8");
await writeFile(join(snapshotsDir, PRE_GUARD_SNAPSHOT), PRE_GUARD, "utf-8");

const currentSource = (): Promise<string> => readFile(actionFile, "utf-8");

describe("email-agent actions snapshots list", () => {
  it("lists the snapshots on disk, newest first, with the restore hint", async () => {
    const result = await cli.run(["actions", "snapshots"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /junk\.action\.ts/);
    assert.match(result.output, new RegExp(OLD_SNAPSHOT.replace(/\./g, "\\.")));
    assert.match(result.output, /snapshots restore/);
    // Newest first: 2026 before 2025.
    assert.ok(
      result.output.indexOf(OLD_SNAPSHOT) < result.output.indexOf(PRE_GUARD_SNAPSHOT),
      "listSnapshots sorts newest-first and the command must not reorder it",
    );
  });

  it("says so when an action has no snapshots", async () => {
    const result = await cli.run([
      "actions",
      "snapshots",
      "--action",
      "nothing.action.ts",
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /No snapshots for nothing\.action\.ts/);
  });
});

describe("email-agent actions snapshots restore", () => {
  it("treats the input ending as No, and says so, instead of hanging", async () => {
    // THE REGRESSION. `rl.question()` never settles at EOF, so this command
    // used to hang commander's action promise and then exit 0 having restored
    // nothing and printed nothing after the prompt.
    const result = await cli.run(
      ["actions", "snapshots", "restore", OLD_SNAPSHOT],
      { stdin: "" },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Skipped — nothing was changed/);
    assert.match(await currentSource(), /CURRENT/, "the action file is untouched");
  });

  it("does nothing for any answer that is not y", async () => {
    const result = await cli.run(
      ["actions", "snapshots", "restore", OLD_SNAPSHOT],
      { stdin: "yes\n" },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Skipped — nothing was changed/);
    assert.match(await currentSource(), /CURRENT/);
  });

  it("restores on y, and snapshots what it replaced", async () => {
    const result = await cli.run(
      ["actions", "snapshots", "restore", OLD_SNAPSHOT],
      { stdin: "y\n" },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Restored junk\.action\.ts/);
    assert.match(await currentSource(), /OLD/, "the snapshot's content is now live");

    // `saveUserAction` snapshots the file it is about to overwrite, so the
    // version just replaced is itself recoverable — the property that makes
    // restore safe to try.
    const listed = await cli.run(["actions", "snapshots"]);
    const snapshotCount = listed.output.match(/junk\.action\.ts\.\d/g)?.length ?? 0;
    assert.ok(snapshotCount >= 3, `expected a new snapshot, saw ${snapshotCount}`);
  });

  it("refuses a pre-guard snapshot with the rules it broke, not a generic error", async () => {
    const result = await cli.run(
      ["actions", "snapshots", "restore", PRE_GUARD_SNAPSHOT],
      { stdin: "y\n" },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /does not pass the action source guard/);
    // The specific violations, which is the whole reason this branch exists:
    // a user has to know WHAT to copy out by hand.
    assert.match(result.output, /import/i);
    assert.match(result.output, /predates the guard/);
    assert.match(await currentSource(), /OLD/, "nothing was changed");
  });

  it("refuses a snapshot whose action it cannot name", async () => {
    const result = await cli.run(
      ["actions", "snapshots", "restore", "not-a-snapshot.ts"],
      { stdin: "y\n" },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Cannot tell which action/);
  });
});
