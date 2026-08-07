// `run-action` through the BUILT binary, including its post-run `[a/r/S]`
// prompt — the second site that was still calling `rl.question()`.
//
// HOW THE AGENT HALF IS REACHED WITHOUT A MODEL. `agentMode: "direct-api"`
// routes `ActionRunner` through `DirectApiExecutor`, which is the OpenAI SDK,
// which resolves `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment.
// Pointing those at a local `node:http` stub on an ephemeral port makes the
// whole pipeline real — prompt construction, the HTTP call, `parseActionOutput`,
// `mapResultToOperations`, the queue write, the approval prompt, the exit code —
// with no network, no key and no spend.
//
// WHAT IT STILL DOES NOT COVER, and must not be described as covered: a real
// model (the stub answers a fixed body, so nothing here says an LLM would
// produce that shape), and a SUCCESSFUL Gmail mutation (the temp `$HOME` holds
// no tokens, so `createGmailClient` throws locally and approved rows resolve
// `failed`). The claim, the resolution and the reporting are covered; "the
// trash reached Gmail" is not.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const cli = await startCli("run-action");

await cli.writeSettings({ agentMode: "direct-api" });
await cli.seed({
  emails: [
    { id: "ra-m1", accountId: "me@example.com", subject: "Win a free cruise" },
    { id: "ra-m2", accountId: "me@example.com", subject: "Weekly newsletter" },
  ],
});

/** What the stub claims the model said. Junk maps `delete` → trash. */
const MODEL_ANSWER = JSON.stringify([
  { emailId: "ra-m1", recommendation: "delete", reason: "obvious spam" },
  { emailId: "ra-m2", recommendation: "delete", reason: "obvious spam" },
]);

let requestCount = 0;
const server: Server = createServer((req, res) => {
  requestCount += 1;
  // Drain the body; the executor sends a chat-completions request and the
  // socket must not be left half-read.
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "stub",
      choices: [{ message: { role: "assistant", content: MODEL_ANSWER } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }),
  );
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const port = (server.address() as AddressInfo).port;
const agentEnv = {
  OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  OPENAI_API_KEY: "stub-key",
  OPENAI_MODEL: "stub-model",
};

async function pendingIds(): Promise<string[]> {
  return (await cli.queue())
    .filter((row) => row.status === "pending")
    .map((row) => row.id);
}

/**
 * Empties the queue between cases.
 *
 * Needed because `enqueueOperationsDetailed` skips a proposal identical to one
 * already PENDING, so a second run against the same two emails would queue
 * nothing and `run-action` would never reach the prompt. Rejecting first is the
 * product's own way to clear it — and a re-proposal after a rejection is
 * deliberately NOT suppressed, which is what makes this work.
 */
async function clearQueue(): Promise<void> {
  await cli.run(["approvals", "reject"]);
  assert.deepEqual(await pendingIds(), []);
}

/** Rows that did not exist before `before` was taken. */
async function rowsAddedSince(before: Set<string>) {
  return (await cli.queue()).filter((row) => !before.has(row.id));
}

describe("email-agent run-action", () => {
  it("queues the proposed changes and leaves them pending when the input ends", async () => {
    // THE REGRESSION. `rl.question()` never settles at EOF, so a piped or
    // redirected `run-action` hung commander's action promise and exited 0
    // with nothing printed after the prompt. EOF must read as the documented
    // default — S, leave them queued — and say so.
    const result = await cli.run(["run-action", "junk", "--limit", "5"], {
      stdin: "",
      env: agentEnv,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(requestCount > 0, "the stub agent was actually called");
    assert.match(result.output, /Gmail changes awaiting your approval/);
    assert.match(result.output, /Move to Trash/);
    assert.match(result.output, /Left pending/);

    const pending = await pendingIds();
    assert.equal(pending.length, 2, "both proposals are queued, none applied");
  });

  it("applies on `a`, and a Gmail failure is a non-zero exit", async () => {
    await clearQueue();
    const before = new Set((await cli.queue()).map((row) => row.id));

    const result = await cli.run(["run-action", "junk", "--limit", "5"], {
      stdin: "a\n",
      env: agentEnv,
    });

    assert.equal(result.exitCode, 1, "per-operation Gmail failures must exit non-zero");
    assert.match(result.output, /failed/);

    const added = await rowsAddedSince(before);
    assert.equal(added.length, 2);
    assert.ok(
      added.every((row) => row.status === "failed"),
      "claimed, called Gmail, recorded the failure — not left in `applying`",
    );
    assert.ok(added.every((row) => row.error.length > 0 && row.resolvedAt !== ""));
    assert.deepEqual(await pendingIds(), []);
  });

  it("routes `r` into the per-email review and honours every answer", async () => {
    // `printf 'r\ny\nn\n' | email-agent run-action junk` — the exact shape that
    // was broken: the `[a/r/S]` interface buffered all three piped lines, so
    // the interface `reviewOperations` opened next saw immediate EOF and both
    // review answers were discarded. One prompt module, one interface, one
    // buffer.
    await clearQueue();
    const before = new Set((await cli.queue()).map((row) => row.id));

    const result = await cli.run(["run-action", "junk", "--limit", "5"], {
      stdin: "r\ny\nn\n",
      env: agentEnv,
    });

    const added = await rowsAddedSince(before);
    assert.equal(added.length, 2);
    assert.deepEqual(
      added.map((row) => row.status).sort(),
      ["failed", "rejected"],
      "both review answers were recorded: `y` reached Gmail (which refused), `n` was rejected",
    );
    // A per-operation Gmail failure is a failure, not a success with a note.
    assert.equal(result.exitCode, 1);
    assert.deepEqual(await pendingIds(), []);
  });
});
