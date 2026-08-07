// The prompt primitive, and the two failures it exists to prevent.
//
// WHAT THIS DRIVES, AND WHAT IT CANNOT. Both cases run node's OWN readline over
// a `terminal: true` PassThrough pair, so the `^C` decoding under test is the
// real one (`lib/internal/readline/interface.js`) rather than a stand-in. What
// it is NOT is a real terminal: there is no pty library in this repo, so
// "pressing Ctrl-C in an actual shell" is verified by the mechanism being
// identical, not by observation. The e2e tests next door cover the EOF half
// through the built binary, where a pipe is exactly what a user gets.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import ts from "typescript";
import { askOnce, withPrompt } from "./prompt.js";
import { reviewOperations, reviewStrandedOperations } from "./commands/approvals.js";
import type { PendingOperationRecord } from "@email-agent/core";

const CTRL_C = String.fromCharCode(3);

interface Streams {
  input: PassThrough;
  output: PassThrough;
  written: () => string;
  /**
   * Deterministic Ctrl-C: fires when the Nth prompt reaches the output stream.
   *
   * `session.ask` is the only thing that writes to `output` (the operation
   * details go to `console.log`), so "prompt N has been printed" is an exact
   * observation of where the loop is. A `setTimeout` would be a guess, and a
   * guess in a test about a race is a flake.
   */
  interruptAtPrompt: (n: number) => void;
}

function terminalStreams(): Streams {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  let interruptAt = 0;
  output.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
    if (interruptAt > 0 && chunks.length === interruptAt) {
      // Deferred: this handler can run inside readline's own keypress
      // generator, and feeding the input stream from there re-enters it
      // ("Generator is already running").
      setImmediate(() => input.write(CTRL_C));
    }
  });
  return {
    input,
    output,
    written: () => chunks.join(""),
    interruptAtPrompt: (n: number) => {
      interruptAt = n;
    },
  };
}

/** Swallows the command chatter so a failing assertion is readable. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await body();
  } finally {
    console.log = log;
  }
}

function display(id: string): Parameters<typeof reviewOperations>[0][number] {
  const op = {
    id,
    batchId: "b",
    actionId: "junk",
    actionName: "Junk Detector",
    emailId: `m-${id}`,
    accountId: "",
    type: "trash",
    labelIds: "",
    status: "pending",
    createdAt: new Date().toISOString(),
    claimedAt: "",
    resolvedAt: "",
    claimToken: "",
    error: "",
  } as unknown as PendingOperationRecord;
  return { op, subject: `subject ${id}`, from: "", snippet: "" };
}

describe("withPrompt: the input ending", () => {
  it("delivers every buffered line, then null — never a hang", async () => {
    const { input, output } = terminalStreams();
    input.end("y\nn\n");

    const answers = await withPrompt(
      async (session) => [
        await session.ask("1? "),
        await session.ask("2? "),
        await session.ask("3? "),
      ],
      { input, output, terminal: false },
    );

    // The third ask is past EOF. `rl.question()` never settled here, which is
    // how three collected decisions were silently discarded and node exited 0.
    assert.deepEqual(answers, ["y", "n", null]);
  });

  it("writes the prompt itself, because that is all question() was doing", async () => {
    const { input, output, written } = terminalStreams();
    input.end("y\n");
    await withPrompt(async (session) => session.ask("Apply? "), {
      input,
      output,
      terminal: false,
    });
    assert.match(written(), /Apply\? /);
  });

  it("EOF is not an abort — the caller keeps what was already answered", async () => {
    const { input, output } = terminalStreams();
    input.end("");
    const result = await askOnce("go? ", { input, output, terminal: false });
    assert.deepEqual(result, { answer: null, aborted: false });
  });
});

describe("withPrompt: Ctrl-C", () => {
  it("latches `aborted` and stops answering", async () => {
    const { input, output, interruptAtPrompt } = terminalStreams();
    interruptAtPrompt(2);
    input.write("y\n");

    const result = await withPrompt(
      async (session) => {
        const first = await session.ask("1? ");
        const second = await session.ask("2? ");
        const third = await session.ask("3? ");
        return { first, second, third, aborted: session.aborted };
      },
      { input, output, terminal: true },
    );
    input.end();

    assert.equal(result.first, "y");
    assert.equal(result.second, null);
    // Latched: a caller that forgets to check `aborted` stops asking rather
    // than looping through the rest of the queue against a dead interface.
    assert.equal(result.third, null);
    assert.equal(result.aborted, true);
  });

  it("is distinguishable from EOF, which is the whole point", async () => {
    const eofStreams = terminalStreams();
    eofStreams.input.end("");
    const eof = await askOnce("go? ", {
      input: eofStreams.input,
      output: eofStreams.output,
      terminal: true,
    });

    const sigintStreams = terminalStreams();
    sigintStreams.interruptAtPrompt(1);
    const sigint = await askOnce("go? ", {
      input: sigintStreams.input,
      output: sigintStreams.output,
      terminal: true,
    });

    // Both deliver `null`. Only `aborted` tells them apart — without the SIGINT
    // listener in `prompt.ts` node closes the interface silently and these two
    // are the same event.
    assert.equal(eof.answer, null);
    assert.equal(sigint.answer, null);
    assert.equal(eof.aborted, false);
    assert.equal(sigint.aborted, true);
  });
});

describe("Ctrl-C during a review commits nothing", () => {
  it("discards the y/n answers already given, rather than applying them", async () => {
    const { input, output, interruptAtPrompt } = terminalStreams();
    const displays = [display("op1"), display("op2"), display("op3")];
    // "yes, trash that one" — then a change of heart at the second prompt.
    input.write("y\n");
    interruptAtPrompt(2);

    const decisions = await quietly(() =>
      reviewOperations(displays, { input, output, terminal: true }),
    );

    assert.equal(decisions.aborted, true);
    // THE ASSERTION THAT MATTERS. Before the SIGINT listener existed, `^C`
    // closed the interface, the iterator reported `done`, the answer classified
    // as `stop` — "keep what I decided" — and `commitReviewDecisions` sent the
    // `y` to Gmail. Ctrl-C conventionally means the opposite.
    assert.deepEqual(decisions.approved, []);
    assert.deepEqual(decisions.rejected, []);
  });

  it("discards a stranded-row adjudication too — it is also a write", async () => {
    const { input, output, interruptAtPrompt } = terminalStreams();
    const displays = [display("s1"), display("s2")];
    input.write("y\n");
    interruptAtPrompt(2);

    const decisions = await quietly(() =>
      reviewStrandedOperations(displays, { input, output, terminal: true }),
    );

    assert.equal(decisions.aborted, true);
    assert.deepEqual(decisions.applied, []);
    assert.deepEqual(decisions.notApplied, []);
  });

  it("EOF mid-review still keeps the decisions — the two must not converge", async () => {
    const { input, output } = terminalStreams();
    const displays = [display("op1"), display("op2"), display("op3")];
    input.end("y\nn\n");

    const decisions = await quietly(() =>
      reviewOperations(displays, { input, output, terminal: false }),
    );

    assert.equal(decisions.aborted, false);
    assert.deepEqual(decisions.approved, ["op1"]);
    assert.deepEqual(decisions.rejected, ["op2"]);
  });
});

describe("no command may reach for rl.question()", () => {
  it("is a structural tripwire, and it is only that", async () => {
    // A TypeScript AST pass, not a text scan — a text scan flagged the very
    // comments explaining why `rl.question()` is banned. It reports two shapes:
    // a call to `.question(...)`, and any use of `createInterface` outside
    // `prompt.ts`, which is the only file that attaches the SIGINT listener.
    //
    // ITS LIMIT, stated so a green run is not over-read: it recognises those
    // two spellings and nothing cleverer. A caller that aliased either
    // (`const q = rl.question; q(...)`) slips past. The behavioural tests above
    // are what guard the semantics; this only makes the natural regression fail
    // where it is typed.
    const here = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    const check = (path: string, source: string): void => {
      const rel = relative(here, path);
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "question"
        ) {
          offenders.push(`${rel}: .question() call`);
        }
        if (ts.isIdentifier(node) && node.text === "createInterface" && rel !== "prompt.ts") {
          offenders.push(`${rel}: createInterface`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    };

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        check(path, await readFile(path, "utf-8"));
      }
    };
    await walk(here);

    assert.deepEqual(
      offenders,
      [],
      "every CLI prompt goes through prompt.ts — see its header for why",
    );
  });

  it("catches the shape it claims to catch", () => {
    // The tripwire's own regression test: the two spellings it reports must
    // actually be reported, or "no offenders" means nothing.
    const findings: string[] = [];
    const source = `
      import { createInterface } from "node:readline/promises";
      const rl = createInterface({ input: process.stdin });
      const answer = await rl.question("go? ");
    `;
    const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "question"
      ) {
        findings.push("question");
      }
      if (ts.isIdentifier(node) && node.text === "createInterface") {
        findings.push("createInterface");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    assert.ok(findings.includes("question"));
    assert.ok(findings.includes("createInterface"));
  });
});
