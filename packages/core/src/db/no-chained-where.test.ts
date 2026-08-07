// STRUCTURAL GUARD against reintroducing chained `.where()` in `db/`.
//
// READ THIS BEFORE TRUSTING IT. This repo has been burned three times by
// denylist-style scans presented as proofs, so the limits come first.
//
// WHAT IT IS. A TypeScript AST pass over every `.ts` file in
// `packages/core/src/db/` (tests excluded). It reports three shapes:
//
//   A. `q.where(a).where(b)` — a `where` call whose receiver chain already
//      contains a `where` call. The literal bug that shipped.
//   B. `q = q.where(x)` inside a loop. The most likely REWRITE of the fix:
//      `for (const f of filters) query = query.where(f)` is a chain spelled
//      across statements, and shape A cannot see it. (This is the shape the
//      mutation check for `chained-where.test.ts` used, precisely because it is
//      the natural thing to write.)
//   C. two or more `q = q.where(x)` statements for the same variable in one
//      function.
//
// WHAT IT CANNOT SEE, and therefore what it does NOT prove:
//   * a `where` applied through a helper — `applyFilter(query, f)` called twice
//     is a chain this pass reads as two unrelated calls;
//   * a receiver stashed in an object, array, closure or field between the two
//     calls, since the pass does not do dataflow;
//   * a query built somewhere the scan does not reach. The set of files that
//     open a LanceDB query outside `db/` is pinned below against a written
//     allowlist and every one of them is scanned too, so a NEW query surface
//     fails this file rather than quietly going unguarded;
//   * a call built dynamically (`query[method](f)`).
//
// So this is a tripwire for the shapes a person actually writes, NOT a proof
// that no chain exists. The BEHAVIOURAL guarantee lives in
// `chained-where.test.ts`, which runs real two-filter queries against a real
// table and is what fails if the semantics break by any route. This file exists
// to make the common regression fail at the point it is typed rather than only
// where its effect happens to be covered.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const DB_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));

async function tsFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...(await tsFilesIn(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files.sort();
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
}

/** True for `<expr>.where(...)`. */
function isWhereCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "where"
  );
}

/** True when a `where` call already appears in this expression's receiver chain. */
function receiverChainHasWhere(call: ts.CallExpression): boolean {
  let node: ts.Node = (call.expression as ts.PropertyAccessExpression).expression;
  for (;;) {
    if (isWhereCall(node)) return true;
    if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isParenthesizedExpression(node)) node = node.expression;
    else return false;
  }
}

/** `v = v.where(...)` — the self-reassignment form. Returns the variable name. */
function selfReassignedWhere(node: ts.Node): string | null {
  if (!ts.isBinaryExpression(node)) return null;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (!ts.isIdentifier(node.left)) return null;
  if (!isWhereCall(node.right)) return null;

  const receiver = (node.right.expression as ts.PropertyAccessExpression)
    .expression;
  if (!ts.isIdentifier(receiver)) return null;
  return receiver.text === node.left.text ? node.left.text : null;
}

function enclosingLoop(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (
      ts.isForStatement(cur) ||
      ts.isForOfStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isWhileStatement(cur) ||
      ts.isDoStatement(cur)
    ) {
      return true;
    }
    if (ts.isFunctionLike(cur)) return false;
  }
  return false;
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return cur;
  }
  return null;
}

interface Finding {
  file: string;
  line: number;
  shape: "chained" | "loop-reassigned" | "repeated-reassignment";
  detail: string;
}

function scan(file: string, source: string): Finding[] {
  const sourceFile = parse(file, source);
  const findings: Finding[] = [];
  const reassignmentsPerFunction = new Map<ts.Node | null, Map<string, number>>();

  const at = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (isWhereCall(node) && receiverChainHasWhere(node)) {
      findings.push({
        file,
        line: at(node),
        shape: "chained",
        detail: node.getText(sourceFile).replaceAll(/\s+/g, " ").slice(0, 120),
      });
    }

    const reassigned = selfReassignedWhere(node);
    if (reassigned !== null) {
      if (enclosingLoop(node)) {
        findings.push({
          file,
          line: at(node),
          shape: "loop-reassigned",
          detail: `${reassigned} = ${reassigned}.where(...) inside a loop applies one predicate per iteration; only the last survives`,
        });
      }
      const fn = enclosingFunction(node);
      const counts = reassignmentsPerFunction.get(fn) ?? new Map<string, number>();
      const seen = (counts.get(reassigned) ?? 0) + 1;
      counts.set(reassigned, seen);
      reassignmentsPerFunction.set(fn, counts);
      if (seen === 2) {
        findings.push({
          file,
          line: at(node),
          shape: "repeated-reassignment",
          detail: `${reassigned} is reassigned from ${reassigned}.where(...) more than once in this function`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return findings;
}

/**
 * True when the file opens a LanceDB query/merge/count. AST-based, so a
 * `mergeInsert` mentioned in a COMMENT (as `actions/approval.ts` does) is not
 * mistaken for one.
 */
function buildsLanceQuery(file: string, source: string): boolean {
  const sourceFile = parse(file, source);
  const names = new Set(["query", "mergeInsert", "countRows"]);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      names.has(node.expression.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Query builders that live OUTSIDE `core/src/db`, each with the reason it is
 * there. Both surface copies are the duplication tracked in TODOS.md ("The
 * batched email lookup is duplicated in two surfaces"); when that lands in core
 * they come off this list. Adding a file here is a decision someone writes down.
 */
const QUERY_BUILDERS_OUTSIDE_DB = new Map<string, string>([
  [
    "core/src/testing/lancedb-fixture.ts",
    "the test fixture reads rows back; it is not product code but it is a real query and is scanned like one",
  ],
  [
    "core/src/testing/claim-race-worker.ts",
    "the forked claim-race worker reads back what it won; same reasoning as the fixture",
  ],
  [
    "web/src/modules/api/email-lookup.ts",
    "hand-copied batched email lookup — belongs in core/src/db/emails.ts (TODOS.md)",
  ],
  [
    "cli/src/email-lookup.ts",
    "the CLI's copy of the same lookup; the CLI may only import the core barrel (TODOS.md)",
  ],
]);

async function scanTargets(): Promise<string[]> {
  const inDb = await tsFilesIn(DB_DIR);
  const outside = [...QUERY_BUILDERS_OUTSIDE_DB.keys()].map((rel) =>
    join(PACKAGES_DIR, rel),
  );
  return [...inDb, ...outside];
}

describe("chained .where() is refused structurally", () => {
  it("finds no chain, loop-applied filter or repeated re-filter", async () => {
    const files = await scanTargets();
    // A floor, so a walk that silently found nothing cannot pass vacuously.
    assert.ok(
      files.length >= 8,
      `expected to scan the db module, saw ${files.length} files`,
    );

    const findings: Finding[] = [];
    for (const file of files) {
      findings.push(...scan(file, await readFile(file, "utf8")));
    }

    assert.deepEqual(
      findings.map((f) => `${f.file.slice(PACKAGES_DIR.length)}:${f.line} [${f.shape}] ${f.detail}`),
      [],
    );
  });

  it("catches each shape it claims to catch", async () => {
    // A guard nobody has seen fail is a guard nobody knows works. These are the
    // three spellings the scan reports, run through the same `scan()`.
    const chained = scan(
      "sample.ts",
      "const q = t.query().where('a = 1').where('b = 2');",
    );
    assert.deepEqual(chained.map((f) => f.shape), ["chained"]);

    const looped = scan(
      "sample.ts",
      `function f(t: unknown, filters: string[]) {
         let q = (t as { query(): { where(s: string): unknown } }).query();
         for (const filter of filters) q = q.where(filter);
         return q;
       }`,
    );
    assert.deepEqual(looped.map((f) => f.shape), ["loop-reassigned"]);

    const repeated = scan(
      "sample.ts",
      `function f(t: { query(): { where(s: string): unknown } }) {
         let q = t.query();
         q = q.where('a = 1');
         q = q.where('b = 2');
         return q;
       }`,
    );
    assert.deepEqual(repeated.map((f) => f.shape), ["repeated-reassignment"]);

    // And the shape the FIX uses must stay clean, or the guard is unusable.
    const fixed = scan(
      "sample.ts",
      `function f(t: { query(): { where(s: string): unknown } }, filters: string[]) {
         let q = t.query();
         if (filters.length > 0) q = q.where(filters.join(' AND '));
         return q;
       }`,
    );
    assert.deepEqual(fixed, []);
  });

  it("is honest about its blind spot rather than silently having one", () => {
    // Two chains this pass CANNOT see. Asserting they come back clean is not an
    // endorsement — it records, in executable form, exactly what the header
    // says the scan does not prove, so nobody reads a green run as "there is no
    // chain anywhere".
    const viaHelper = scan(
      "sample.ts",
      `function apply(q: { where(s: string): unknown }, f: string) { return q.where(f); }
       function run(t: { query(): { where(s: string): unknown } }) {
         return apply(apply(t.query() as never, 'a = 1') as never, 'b = 2');
       }`,
    );
    assert.deepEqual(viaHelper, [], "dataflow through a helper is invisible here");

    const viaContainer = scan(
      "sample.ts",
      `function run(t: { query(): { where(s: string): unknown } }) {
         const box = { q: t.query() };
         box.q = box.q.where('a = 1') as never;
         box.q = box.q.where('b = 2') as never;
         return box.q;
       }`,
    );
    assert.deepEqual(
      viaContainer,
      [],
      "a receiver held on an object is invisible here — the reassignment check only tracks plain identifiers",
    );
  });

  it("scans every file in the repo that builds a LanceDB query", async () => {
    // The scan's scope is only sound while the set of query builders is known.
    // This sweeps all three packages and fails if a file starts querying
    // LanceDB without being added to the allowlist above — so a new query
    // surface cannot slip past unguarded, and a stale entry cannot linger.
    const found: string[] = [];
    for (const pkg of ["core/src", "web/src", "cli/src"]) {
      for (const file of await tsFilesIn(join(PACKAGES_DIR, pkg))) {
        if (file.startsWith(DB_DIR)) continue;
        if (buildsLanceQuery(file, await readFile(file, "utf8"))) {
          found.push(file.slice(PACKAGES_DIR.length));
        }
      }
    }
    assert.deepEqual([...found].sort(), [...QUERY_BUILDERS_OUTSIDE_DB.keys()].sort());
  });
});
