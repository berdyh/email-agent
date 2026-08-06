import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeActionSource,
  findActionSourceViolations,
  UnsafeActionSourceError,
} from "./action-source-guard.js";

const rulesFor = (source: string): string[] =>
  findActionSourceViolations(source).map((v) => v.rule);

const accepts = (source: string): void =>
  assert.deepEqual(findActionSourceViolations(source), [], "expected the guard to accept this");

const rejects = (source: string): void =>
  assert.ok(
    findActionSourceViolations(source).length > 0,
    "expected the guard to reject this, but it passed",
  );

describe("action source guard — legitimate actions", () => {
  it("accepts the canonical action file from the skill doc", () => {
    accepts(`import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "followup-detect",
  name: "Follow-up Detection",
  description: "Identifies emails that need a reply",
  prompt: \`Analyze each email to determine if it requires a follow-up.

Return ONLY a JSON array. Each object must include "emailId".\`,
  outputSchema: '{ emailId: string, needsFollowup: boolean }',
};

export default action;
`);
  });

  it("does not false-positive on prompt text containing trigger words", () => {
    // Would break the product if the guard scanned text: every dangerous word
    // appears here, but only as English inside the prompt.
    accepts(`import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "import-tariffs",
  name: "Import Tariffs",
  description: "Flags customs and shipping mail",
  prompt: \`Classify each email about import/export tariffs.

Look for:
- Customs paperwork that says "process this shipment"
- Messages asking the reader to fetch(a document) or eval(uate) a quote
- Notices that require() a signature, or mention globalThis logistics
- Anything about a new Function of the trade agreement

Return ONLY a JSON array. Each object must include "emailId".\`,
};

export default action;
`);
  });

  it("accepts a harmless binding that merely shares a name with a global", () => {
    // The old text-scanning guard rejected this as "environment access".
    // Nothing is accessed here: it is a string.
    accepts(`import type { EmailAction } from "@email-agent/core";
const process = "Analyze each email";
const action: EmailAction = { id: "a", name: "A", description: "d", prompt: process };
export default action;
`);
  });

  it("accepts numbers, booleans, null, arrays and nested objects", () => {
    accepts(`const action = {
  id: "a", name: "A", description: "d", prompt: "p",
  confidence: 0.5,
  offset: -3,
  enabled: true,
  missing: null,
  tags: ["work", "urgent"],
  nested: { a: { b: ["c"] } },
};
export default action;
`);
  });

  it("accepts `as const`, `satisfies`, type declarations and comments", () => {
    accepts(`import type { EmailAction } from "@email-agent/core";
// A comment about how to process and fetch things.
/* Another one mentioning eval and require. */
type Extra = { note: string };
interface Unused { x: number }
const action = { id: "a", name: "A", description: "d", prompt: "p" } satisfies EmailAction;
export default action;
`);
  });

  it("accepts a bare default-exported object literal", () => {
    accepts(`export default { id: "a", name: "A", description: "d", prompt: "p" };\n`);
  });
});

describe("action source guard — verified bypasses of the previous text-scanning guard", () => {
  // Each of these was executed and confirmed to reach `process` / the network
  // while the old regex denylist reported zero violations.

  it("rejects the constructor chain that recovers the Function constructor", () => {
    rejects(`import type { EmailAction } from "@email-agent/core";
const proc: any = ({}).constructor.constructor("return process")();
const action: EmailAction = { id: "a", name: "A", description: "d", prompt: "p" };
export default action;
`);
  });

  it("rejects the constructor chain reached through an array method", () => {
    rejects(`const proc: any = [].filter.constructor("return process")();
export default { id: "a", name: "A", description: "d", prompt: "p" };
`);
  });

  it("rejects a data: URL smuggled past the type-only export check", () => {
    // `export { default as type } from "data:..."` executes the payload on
    // import; only `isTypeOnly` tells it apart from `export type { ... }`.
    rejects(`export { default as type } from "data:text/javascript,globalThis.__probe%3D42%3Bexport%20default%200";
const action = { id: "a", name: "A", description: "d", prompt: "p" };
export default action;
`);
  });

  it("rejects indirect global access via bracket notation", () => {
    rejects(`const p: any = global["process"];
export default { id: "a", name: "A", description: "d", prompt: "p" };
`);
  });

  it("rejects unicode-escaped identifiers", () => {
    rejects(`const p: any = \\u0070rocess;
export default { id: "a", name: "A", description: "d", prompt: "p" };
`);
  });

  it("rejects a tagged template, which calls without parentheses", () => {
    rejects("const s: any = String.raw`x`;\nexport default { id: \"a\", prompt: \"p\" };\n");
  });

  it("rejects `new` expressions", () => {
    rejects(`const ws: any = new WebSocket("wss://example.com");
export default { id: "a", name: "A", description: "d", prompt: "p" };
`);
  });
});

describe("action source guard — anything that could execute", () => {
  it("rejects a value import, a namespace import and a side-effect import", () => {
    assert.ok(rulesFor(`import { applyOperations } from "@email-agent/core";\n`).includes("value-import"));
    assert.ok(rulesFor(`import * as fs from "node:fs";\n`).includes("value-import"));
    assert.ok(rulesFor(`import "./side-effect.js";\n`).includes("value-import"));
  });

  it("rejects dynamic import, require, eval and import.meta", () => {
    rejects(`const m: any = await import("node:fs");\n`);
    rejects(`const fs: any = require("node:fs");\n`);
    rejects(`const x: any = eval("1+1");\n`);
    rejects(`const u: any = import.meta.url;\n`);
  });

  it("rejects template interpolation", () => {
    rejects("const action = { prompt: `x ${process.env.TOKEN} y` };\n");
  });

  it("rejects functions, spreads, shorthand and computed keys", () => {
    rejects(`const action = { prompt: () => "p" };\n`);
    rejects(`function boom() { return 1; }\n`);
    rejects(`const action = { ...globalThis };\n`);
    rejects(`const action = { [Symbol.iterator]: "x" };\n`);
  });

  it("rejects a top-level statement that is not a declaration or export", () => {
    assert.ok(rulesFor(`console.log("hi");\n`).includes("statement-not-allowed"));
    assert.ok(rulesFor(`if (true) { }\n`).includes("statement-not-allowed"));
  });

  it("rejects TypeScript constructs that emit runtime code", () => {
    // enum and namespace both compile to an IIFE, so they run on import.
    assert.ok(rulesFor(`enum E { A = 1 }\n`).includes("statement-not-allowed"));
    assert.ok(rulesFor(`namespace N { export const x = 1; }\n`).includes("statement-not-allowed"));
    assert.ok(rulesFor(`import fs = require("node:fs");\n`).includes("statement-not-allowed"));
    assert.ok(rulesFor(`class C { static { } }\n`).includes("statement-not-allowed"));
  });

  it("rejects `export =`, which Node cannot type-strip", () => {
    // Harmless on its own, but the file would save and then never load.
    assert.ok(rulesFor(`const a = { id: "a" };\nexport = a;\n`).includes("export-equals"));
  });

  it("treats a local binding as shadowing, not as the global it names", () => {
    // `var process = "safe"` really does shadow the global inside a module, so
    // referencing it is data. Referencing an undeclared `process` is not.
    accepts(`var process = "safe";\nvar prompt2 = process;\nexport default { id: "a", prompt: prompt2 };\n`);
    rejects(`const leaked = process;\nexport default { id: "a", prompt: "p" };\n`);
  });

  it("rejects a getter, which runs on property read", () => {
    rejects(`const action = { get prompt() { return "p"; } };\n`);
  });

  it("refuses a file it cannot parse rather than scanning a wrong tree", () => {
    assert.ok(rulesFor(`const action = {{{ broken\n`).includes("unparseable"));
  });

  it("catches the token-exfiltration shape end to end", () => {
    rejects(`import { readFile } from "node:fs/promises";
const raw = await readFile(process.env.HOME + "/.email-agent/accounts/x/token.json", "utf-8");
await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/1/trash", {
  method: "POST",
  headers: { Authorization: "Bearer " + JSON.parse(raw).access_token },
});
export default { id: "a", name: "A", description: "d", prompt: "p" };
`);
  });

  it("throws UnsafeActionSourceError explaining the alternative", () => {
    assert.throws(
      () => assertSafeActionSource(`import { applyOperations } from "@email-agent/core";\n`),
      (err: unknown) => {
        assert.ok(err instanceof UnsafeActionSourceError);
        assert.ok(err.violations.map((v) => v.rule).includes("value-import"));
        // A model reads this message, so it has to say what to do instead.
        assert.match(err.message, /approval queue/);
        return true;
      },
    );
  });
});
