import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { extractActionData, UnsafeActionSourceError } from "./action-source-guard.js";

const run = promisify(execFile);

/**
 * Differential test: the static evaluator versus real Node.
 *
 * `extractActionData()` claims to return the value a native `import()` would
 * have produced. That claim is only worth what it is TESTED against, and the
 * unit tests next door cannot test it — they assert what their author believed
 * the runtime does. This file asks the runtime.
 *
 * Each case is written to a temp directory and imported by a CLEAN `node`
 * subprocess (Node's own type stripping, not tsx's esbuild transform, which
 * accepts syntax Node rejects). The result is compared against the evaluator's:
 *
 *  - native throws, evaluator returns a value  -> DIVERGENCE. This is the
 *    dangerous direction: the evaluator is describing a module that cannot
 *    exist, and every such case so far has been a bypass.
 *  - native returns, evaluator throws          -> fail-closed, always fine.
 *  - both return                               -> values must match exactly,
 *    modulo the deliberate tightenings listed in `EXPECTED_TIGHTENINGS`.
 *
 * The corpus has two halves, and the split is the point:
 *
 *  - `HAND_CASES` are shapes someone thought of — the regressions from past
 *    review rounds, kept as pins.
 *  - `generatedCases()` and `generatedValueCases()` are mechanical enumerations
 *    of the dimensions the evaluator branches on. This half exists because the
 *    hand corpus is bounded by imagination: a hundred hand-written cases missed
 *    `const unused;` (an uninitialized `const` is an early error, so Node
 *    refuses the module while the evaluator happily returned its action),
 *    and the generated half found it, plus eighteen siblings, on its first run.
 *
 * The generated half covers two independent things, and both need a generator:
 * `generatedCases()` enumerates how a value is DECLARED (declaration kind,
 * export form, annotation, initializer presence, binding name), and
 * `generatedValueCases()` enumerates what the value IS (literal forms, key
 * spellings and ordering, nesting, shared references) across the placements
 * that reach the evaluator differently. The declaration half shipped first with
 * every initializer fixed to `"v"`, which left `evaluatePureData()` — the half
 * where value correctness actually lives — covered by hand cases only.
 *
 * When adding a branch to the evaluator, add it to whichever DIMENSION it
 * belongs to — not an example to the hand list.
 */

interface Case {
  name: string;
  source: string;
}

/** Regression pins: shapes found by review, kept so they cannot come back. */
const HAND_CASES: Case[] = [
  // Named exports are LIVE bindings; `export default` snapshots its operand.
  { name: "export var redeclared to null", source: `export var action = { id: "junk", name: "J", prompt: "p" };\nvar action = null;\n` },
  { name: "export var redeclared to another object", source: `export var action = { id: "first", name: "J", prompt: "p" };\nvar action = { id: "second", name: "J", prompt: "p" };\n` },
  { name: "export var redeclared without initializer", source: `export var action = { id: "first", name: "J", prompt: "p" };\nvar action;\n` },
  { name: "export default snapshot then var redecl", source: `var action = { id: "first", name: "J", prompt: "p" };\nexport default action;\nvar action = { id: "second", name: "J", prompt: "p" };\n` },

  // Strict-mode / module early errors the parser does not report.
  { name: "const eval", source: `const eval = "p";\nexport default { id: "a", name: "A", prompt: "p" };\n` },
  { name: "let arguments", source: `let arguments = "p";\nexport default { id: "a", name: "A", prompt: "p" };\n` },
  { name: "duplicate const", source: `const X = "first";\nconst X = "second";\nexport default { id: "a", name: "A", prompt: X };\n` },
  { name: "let then var", source: `let X = "first";\nvar X = "second";\nexport default { id: "a", name: "A", prompt: X };\n` },
  { name: "var dup (LEGAL)", source: `var X = "first";\nvar X = "second";\nexport default { id: "a", name: "A", prompt: X };\n` },
  { name: "escaped eval", source: `const ev\\u0061l = "p";\nexport default { id: "a", name: "A", prompt: "p" };\n` },
  { name: "duplicate export default", source: `export default { id: "a", name: "A", prompt: "p" };\nexport default { id: "b", name: "B", prompt: "q" };\n` },
  { name: "duplicate exported var name", source: `export var action = { id: "a", name: "A", prompt: "p" };\nexport var action = { id: "b", name: "B", prompt: "q" };\n` },

  // Early errors that can only hide in the leaf surfaces the allowlist still
  // admits — numeric literals, string literals, keys, comments. All of these
  // ARE parse diagnostics in TypeScript, which is why `unparseable` covers
  // them; the cases exist so that stays true if the parser options change.
  { name: "legacy octal literal", source: `export default { id: "a", name: "A", prompt: "p", n: 017 };\n` },
  { name: "non-octal decimal 08", source: `export default { id: "a", name: "A", prompt: "p", n: 08 };\n` },
  { name: "legacy octal escape in string", source: `export default { id: "a", name: "A", prompt: "\\1" };\n` },
  { name: "\\8 escape in string", source: `export default { id: "a", name: "A", prompt: "\\8" };\n` },
  { name: "legacy octal escape in key", source: `export default { id: "a", name: "A", prompt: "p", "\\1": "x" };\n` },
  { name: "\\0 escape (LEGAL)", source: `export default { id: "a", name: "A", prompt: "\\0" };\n` },
  { name: "html-like open comment", source: `<!-- x\nexport default { id: "a", name: "A", prompt: "p" };\n` },
  { name: "html-like close comment", source: `export default { id: "a", name: "A", prompt: "p" };\n--> x\n` },

  // `mod.default ?? mod.action` coalesces on the VALUE, not on presence.
  { name: "export default null + named action", source: `export const action = { id: "named", name: "N", prompt: "p" };\nexport default null;\n` },
  { name: "export default 0 + named action", source: `export const action = { id: "named", name: "N", prompt: "p" };\nexport default 0;\n` },
  { name: "export default null alone", source: `export default null;\n` },

  // Object/number/string semantics the evaluator reproduces rather than guesses.
  { name: "duplicate keys, later wins", source: `export default { id: "a", name: "A", prompt: "first", prompt: "second" };\n` },
  { name: "numeric key 1 vs 1.0", source: `export default { id: "a", name: "A", prompt: "p", 1: "x", 1.0: "y" };\n` },
  { name: "numeric key separators", source: `export default { id: "a", name: "A", prompt: "p", 1_000: "x" };\n` },
  { name: "shorthand property", source: `const prompt = "p";\nexport default { id: "a", name: "A", prompt };\n` },
  { name: "string escapes", source: `export default { id: "a", name: "A", prompt: "a\\nb\\tc\\u0041\\x42\\\\" };\n` },
  { name: "lone surrogate", source: `export default { id: "a", name: "A", prompt: "\\ud800" };\n` },
  { name: "NFC vs NFD keys", source: `export default { id: "a", name: "A", prompt: "p", "\\u00e9": "nfc", "e\\u0301": "nfd" };\n` },
  { name: "nested array of objects", source: `export default { id: "a", name: "A", prompt: "p", xs: [{ a: 1 }, [2, [3]]] };\n` },
  { name: "shebang", source: `#!/usr/bin/env node\nexport default { id: "a", name: "A", prompt: "p" };\n` },
  { name: "use strict directive", source: `"use strict";\nexport default { id: "a", name: "A", prompt: "p" };\n` },

  // The one accepted value divergence, kept in the corpus so the allowlist
  // below is exercised rather than merely asserted.
  { name: "non-string id/name/prompt", source: `export default { id: 1, name: true, prompt: ["p"] };\n` },
];

/**
 * Cross-product over the dimensions the evaluator's statement walk branches on.
 * Every knob here corresponds to a real `if` in `analyzeActionSource()`.
 */
function generatedCases(): Case[] {
  const DECL_KINDS = ["var", "let", "const"];
  const EXPORTS = [
    { label: "local", prefix: "" },
    { label: "exported", prefix: "export " },
  ];
  const ANNOTATIONS = [
    { label: "bare", text: "" },
    { label: "annotated", text: ": string" },
  ];
  const INITIALIZERS = [
    { label: "init", text: ` = "v"` },
    { label: "no-init", text: "" },
  ];
  // `action` matters because it is the name the loaders resolve.
  const NAMES = ["helper", "action"];

  const out: Case[] = [];
  for (const kind of DECL_KINDS) {
    for (const exp of EXPORTS) {
      for (const ann of ANNOTATIONS) {
        for (const init of INITIALIZERS) {
          for (const name of NAMES) {
            const decl = `${exp.prefix}${kind} ${name}${ann.text}${init.text};`;
            const label = `${kind}/${exp.label}/${ann.label}/${init.label}/${name}`;
            // With a default export, a divergence shows up as a wrong VALUE.
            out.push({
              name: `gen decl ${label} + default`,
              source: `${decl}\nexport default { id: "a", name: "A", prompt: "p" };\n`,
            });
            // Without one, it shows up as a wrong acceptance.
            out.push({ name: `gen decl ${label} alone`, source: `${decl}\n` });
          }
        }
      }
    }
  }
  // A declaration LIST mixes the dimensions within one statement, which is a
  // different code path from two statements.
  for (const kind of DECL_KINDS) {
    for (const first of INITIALIZERS) {
      for (const second of INITIALIZERS) {
        out.push({
          name: `gen list ${kind}/${first.label},${second.label}`,
          source: `${kind} a${first.text}, b${second.text};\nexport default { id: "a", name: "A", prompt: "p" };\n`,
        });
      }
    }
  }
  return out;
}

/** One initializer shape, as source text that can stand anywhere a value can. */
interface ValueCase {
  label: string;
  text: string;
}

/** `{ a0: { a1: … "leaf" } }`, `depth` levels down. */
function deepObject(depth: number): string {
  let text = `"leaf"`;
  for (let i = depth - 1; i >= 0; i -= 1) text = `{ a${i}: ${text} }`;
  return text;
}

/**
 * The VALUE dimension: every literal form `evaluatePureData()` branches on, or
 * deliberately refuses.
 *
 * The declaration cross-product above fixes every initializer to `"v"`, so it
 * proves nothing about the value-computation half of the evaluator — number
 * normalisation, property-key normalisation and ordering, string escapes,
 * shared references, refusals. That half used to be covered only by
 * `HAND_CASES`, which is exactly the imagination-bounded corpus the generated
 * half exists to replace.
 *
 * Entries that the evaluator REFUSES belong here too (`__proto__`, computed
 * keys, array holes, BigInt). A refusal is only fail-closed if the runtime
 * would in fact have loaded the file, and that is what the differential run
 * checks — asserting the refusal in a unit test asserts only its author's
 * belief about Node.
 */
const VALUES: ValueCase[] = [
  // Strings: escape forms, and the code points that survive a round trip only
  // if the evaluator takes the scanner's cooked text rather than re-parsing.
  { label: "str-empty", text: `""` },
  { label: "str-plain", text: `"plain"` },
  { label: "str-c-escapes", text: String.raw`"a\nb\tc\rd\ve\ff\bg"` },
  { label: "str-nul", text: String.raw`"\0"` },
  { label: "str-hex-and-unicode-escape", text: String.raw`"\x41\u0042"` },
  { label: "str-codepoint-escape", text: String.raw`"\u{1f600}"` },
  { label: "str-surrogate-pair", text: String.raw`"😀"` },
  { label: "str-lone-high-surrogate", text: String.raw`"\ud800"` },
  { label: "str-lone-low-surrogate", text: String.raw`"\udfff"` },
  { label: "str-line-separators", text: String.raw`"  "` },
  { label: "str-identity-escape", text: String.raw`"\a\/"` },
  { label: "str-backslash", text: String.raw`"\\"` },
  { label: "str-quote-escape", text: String.raw`'it\'s "quoted"'` },
  { label: "str-max-codepoint", text: String.raw`"\u{10ffff}"` },
  { label: "str-nfc", text: String.raw`"é"` },
  { label: "str-nfd", text: String.raw`"é"` },
  // A backslash before a real newline continues the line; the value has no
  // newline in it.
  { label: "str-line-continuation", text: `"a\\\nb"` },
  { label: "tpl-plain", text: "`tpl`" },
  { label: "tpl-escapes", text: "`a\\nb\\u0041`" },
  // A real newline inside a template IS part of the value.
  { label: "tpl-multiline", text: "`line1\nline2`" },

  // Numbers: every literal form, plus the values where the scanner's
  // normalisation and `Number()` could disagree with the runtime.
  { label: "num-zero", text: "0" },
  { label: "num-negative-zero", text: "-0" },
  { label: "num-positive-zero", text: "+0" },
  { label: "num-int", text: "42" },
  { label: "num-negative-int", text: "-42" },
  { label: "num-fraction", text: "0.1" },
  { label: "num-float", text: "1.5" },
  { label: "num-leading-dot", text: ".5" },
  { label: "num-trailing-dot", text: "1." },
  { label: "num-hex", text: "0x1f" },
  { label: "num-octal", text: "0o17" },
  { label: "num-binary", text: "0b1011" },
  { label: "num-exponent", text: "1e2" },
  { label: "num-exponent-upper", text: "1E3" },
  { label: "num-exponent-signed", text: "1e+21" },
  { label: "num-1e21", text: "1e21" },
  { label: "num-1e-7", text: "1e-7" },
  { label: "num-separators", text: "1_000_000" },
  { label: "num-hex-separators", text: "0x1_f" },
  { label: "num-past-max-safe-integer", text: "9007199254740993" },
  { label: "num-huge-integer", text: "12345678901234567890" },
  { label: "num-max-double", text: "1e308" },
  { label: "num-overflows-to-infinity", text: "1e309" },
  { label: "num-overflows-to-negative-infinity", text: "-1e309" },
  { label: "num-denormal-min", text: "5e-324" },
  { label: "num-underflows-to-zero", text: "1e-400" },
  { label: "num-underflows-to-negative-zero", text: "-1e-400" },
  // Not a NumericLiteral, and the evaluator has no BigInt path — must refuse.
  { label: "num-bigint", text: "1n" },

  { label: "bool-true", text: "true" },
  { label: "bool-false", text: "false" },
  { label: "null", text: "null" },

  // Expression forms that read like literals but are not: the evaluator has
  // no constant folder, so each must be refused rather than approximated.
  { label: "num-double-negation", text: "- -1" },
  { label: "num-parenthesized-negative-zero", text: "(-0)" },
  { label: "num-bitwise-not", text: "~0" },
  { label: "str-concatenation", text: `"a" + "b"` },
  { label: "tpl-substitution", text: "`a${1}b`" },

  // Objects: key normalisation, key ORDER (integer-index keys come first,
  // ascending, whatever the source order), duplicates, and the two key
  // spellings that must be refused rather than approximated.
  { label: "obj-empty", text: "{}" },
  { label: "obj-nested", text: `{ a: { b: { c: [1, { d: 2 }] } } }` },
  { label: "obj-duplicate-keys", text: `{ k: "first", k: "second" }` },
  { label: "obj-numeric-key-forms", text: `{ 1: "a", 1.0: "b", 0x1: "c" }` },
  { label: "obj-numeric-vs-string-key", text: `{ "1": "s", 1: "n" }` },
  { label: "obj-exponent-key", text: `{ "1e+21": "s", 1e21: "n" }` },
  { label: "obj-huge-numeric-key", text: `{ 12345678901234567890: "a", 1e21: "b" }` },
  { label: "obj-integer-vs-string-key-order", text: `{ 2: "two", b: "bee", 1: "one", a: "ay" }` },
  { label: "obj-negative-zero-string-key", text: `{ "-0": "s", 0: "n" }` },
  { label: "obj-unicode-nfc-nfd-keys", text: String.raw`{ "é": "nfc", "é": "nfd" }` },
  { label: "obj-quoted-vs-bare-keys", text: `{ a: 1, "a b": 2, "c": 3 }` },
  { label: "obj-empty-key", text: `{ "": "x" }` },
  { label: "obj-escaped-keys", text: String.raw`{ "\n": "x", "\u0041": "y" }` },
  // An escape in an IDENTIFIER key: `\u0061` binds `a`, so this is a duplicate.
  { label: "obj-escaped-identifier-key", text: String.raw`{ \u0061: 1, a: 2 }` },
  { label: "obj-deep", text: deepObject(20) },
  { label: "obj-proto-key", text: `{ __proto__: null }` },
  { label: "obj-quoted-proto-key", text: `{ "__proto__": null }` },
  // 2^32-2 is the largest array index, so 2^32-1 orders as a STRING key
  // while its neighbour orders as an integer one.
  { label: "obj-array-index-boundary-keys", text: `{ 4294967295: "a", 4294967294: "b", z: "s", 0: "zero" }` },
  { label: "obj-keyword-keys", text: `{ default: 1, class: 2, if: 3, new: 4 }` },
  { label: "obj-prototype-name-keys", text: `{ constructor: 1, toString: 2, hasOwnProperty: 3 }` },
  { label: "obj-computed-key", text: `{ ["a"]: 1 }` },

  // Arrays: a trailing comma adds no element, a HOLE does — and the hole must
  // be refused, since the evaluator has no way to build a sparse array.
  { label: "arr-empty", text: "[]" },
  { label: "arr-flat", text: `[1, "two", true, null]` },
  { label: "arr-nested", text: `[[1, [2, [3]]]]` },
  { label: "arr-trailing-comma", text: `[1, 2,]` },
  { label: "arr-hole", text: `[1, , 2]` },
  { label: "arr-of-objects", text: `[{ a: [] }, {}]` },
];

/**
 * Where a value is put. Each placement is a distinct path THROUGH the evaluator
 * to the compared result, and `shared` is the one that can only be tested here:
 * one binding read twice is one object at runtime, so it must be one object in
 * the extracted value too, not two equal copies. `encodeLocal`/`PROBE` encode
 * that as a `$ref`, so a copy shows up as a mismatch rather than passing.
 */
const VALUE_PLACEMENTS: { label: string; wrap: (value: string) => string }[] = [
  { label: "in-default", wrap: (v) => `export default { id: "a", name: "A", prompt: "p", v: ${v} };\n` },
  {
    label: "shared-binding",
    wrap: (v) =>
      `const shared = ${v};\nexport default { id: "a", name: "A", prompt: "p", x: shared, y: shared };\n`,
  },
  { label: "named-export", wrap: (v) => `export var action = { id: "a", name: "A", prompt: "p", v: ${v} };\n` },
  { label: "as-const", wrap: (v) => `export default { id: "a", name: "A", prompt: "p", v: ${v} as const };\n` },
  {
    label: "satisfies",
    wrap: (v) => `export default { id: "a", name: "A", prompt: "p", v: ${v} satisfies unknown };\n`,
  },
  // The value IS the module's default export, so a non-action value has to
  // resolve to no action on both sides rather than to a different one.
  { label: "sole-default", wrap: (v) => `export default ${v};\n` },
];

/**
 * COVERAGE STRATEGY, stated because it is a deliberate incompleteness.
 *
 * The value dimension is composed PAIRWISE with placement (|VALUES| x
 * |PLACEMENTS|), not crossed with `generatedCases()`. Substituting every value
 * for the fixed `"v"` initializer there would add |VALUES| x 108 ≈ 9,000 more
 * modules; at the ~0.35 ms per module this corpus costs, that is seconds of
 * subprocess time on a run that has to stay well under one.
 *
 * Pairwise is sound here because the two halves are independent by
 * construction: the statement walk reaches an initializer only by calling
 * `evaluatePureData()` and never inspects its shape, and `evaluatePureData()`
 * never inspects the declaration it came from. So a bug needing `let` AND a hex
 * literal together would have to live in that seam — and the placements above
 * are chosen to walk it: declaration initializer, default-export operand,
 * named-export operand, and a binding read twice.
 *
 * What this corpus still does NOT cover, so nobody reads it as completeness:
 *  - Value shapes crossed with declaration kind, annotation and export form
 *    (pairwise, per above).
 *  - Nesting beyond 20 levels, and objects wider than a handful of keys.
 *  - Unicode beyond representative points (NFC/NFD, both lone surrogates, an
 *    astral pair, U+2028/U+2029, U+10FFFF) — not the code point space.
 *  - Values no literal can spell (a Symbol, a function, a null-prototype
 *    object). Those reach a value only through a construct the allowlist
 *    already refuses, so the corpus checks the refusal, not the value.
 *  - `.action.js` files: every case here is `.ts`, since the probe imports what
 *    Node's type stripper produces. The JS-only rules (`typescript-in-js`) are
 *    covered by the unit tests next door, not differentially.
 */
function generatedValueCases(): Case[] {
  const out: Case[] = [];
  for (const value of VALUES) {
    for (const placement of VALUE_PLACEMENTS) {
      out.push({
        name: `gen value ${value.label}/${placement.label}`,
        source: placement.wrap(value.text),
      });
    }
  }
  return out;
}

/**
 * Cases where the evaluator deliberately returns LESS than the runtime would,
 * each with the reason. Anything not listed here that differs is a bug.
 */
const EXPECTED_TIGHTENINGS = new Map<string, string>([
  [
    "non-string id/name/prompt",
    "`id`/`name`/`prompt` must be non-empty strings, not merely truthy — the loaders this replaced accepted `{ id: 1 }` and flowed a number into every place an id is a string",
  ],
]);

/**
 * Imports each file in a clean subprocess and reports what the module system
 * actually produced. Encoding is structural so `-0`, BigInt, non-finite
 * numbers, prototypes and shared references all survive the comparison.
 */
const PROBE = `
import { pathToFileURL } from "node:url";
const files = JSON.parse(process.argv[1]);
const out = [];
for (const file of files) {
  try {
    const mod = await import(pathToFileURL(file).href);
    // The OLD loaders, verbatim: they resolved \`mod.default ?? mod.action\`
    // and then kept it only if \`action?.id && action?.name && action?.prompt\`.
    // Comparing against the raw export instead would flag every file that
    // exports a non-action as a divergence, which says nothing about the guard.
    const picked = mod.default ?? mod.action;
    const resolved = picked?.id && picked?.name && picked?.prompt ? picked : undefined;
    const seen = new Map();
    const enc = (v) => {
      if (typeof v === "bigint") return { $bigint: String(v) };
      if (typeof v === "number") {
        if (Object.is(v, -0)) return { $num: "-0" };
        if (!Number.isFinite(v)) return { $num: String(v) };
        return v;
      }
      if (typeof v === "symbol") return { $sym: String(v) };
      if (v === undefined) return { $undefined: true };
      if (v === null) return null;
      if (typeof v === "object") {
        if (seen.has(v)) return { $ref: seen.get(v) };
        const id = seen.size; seen.set(v, id);
        if (Array.isArray(v)) return { $id: id, $arr: v.map(enc) };
        const out = { $id: id, $protoNull: Object.getPrototypeOf(v) === null, $obj: {} };
        for (const k of Object.keys(v)) out.$obj[k] = enc(v[k]);
        return out;
      }
      return v;
    };
    out.push({ kind: "value", detail: JSON.stringify(enc(resolved)) });
  } catch (err) {
    out.push({ kind: "throw", detail: String(err && err.message ? err.message : err).slice(0, 160) });
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Re-encodes an extracted value exactly as the probe encodes a native one. */
function encodeLocal(root: unknown): string {
  const seen = new Map<object, number>();
  const enc = (v: unknown): unknown => {
    if (typeof v === "bigint") return { $bigint: String(v) };
    if (typeof v === "number") {
      if (Object.is(v, -0)) return { $num: "-0" };
      if (!Number.isFinite(v)) return { $num: String(v) };
      return v;
    }
    if (typeof v === "symbol") return { $sym: String(v) };
    if (v === undefined) return { $undefined: true };
    if (v === null) return null;
    if (typeof v === "object") {
      const o = v as object;
      if (seen.has(o)) return { $ref: seen.get(o) };
      const id = seen.size;
      seen.set(o, id);
      if (Array.isArray(v)) return { $id: id, $arr: v.map(enc) };
      const out: Record<string, unknown> = {
        $id: id,
        $protoNull: Object.getPrototypeOf(o) === null,
        $obj: {} as Record<string, unknown>,
      };
      for (const k of Object.keys(o)) {
        (out.$obj as Record<string, unknown>)[k] = enc((o as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(enc(root));
}

interface Outcome {
  kind: "value" | "throw";
  detail: string;
}

function staticOutcome(source: string): Outcome {
  try {
    return { kind: "value", detail: encodeLocal(extractActionData(source, "case.action.ts")) };
  } catch (err) {
    if (err instanceof UnsafeActionSourceError) {
      return { kind: "throw", detail: `REFUSED: ${err.violations.map((v) => v.rule).join(",")}` };
    }
    return { kind: "throw", detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

describe("action source extraction — differential against real Node", () => {
  let dir = "";
  let stripsTypes = false;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "action-differential-"));
    await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
    // Node has stripped TypeScript types unflagged since 22.18, which this
    // package requires. If it cannot, every case would "diverge" for a reason
    // that has nothing to do with the guard, so say so instead of failing.
    const probe = join(dir, "probe.action.ts");
    await writeFile(probe, `export default { id: "a", name: "A", prompt: "p" } as const;\n`, "utf8");
    try {
      await run(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", PROBE, JSON.stringify([probe])], { cwd: dir });
      stripsTypes = true;
    } catch {
      stripsTypes = false;
    }
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("produces exactly what a native import produces, or refuses", async (t) => {
    if (!stripsTypes) {
      t.skip(`node ${process.versions.node} cannot strip TypeScript types; the differential comparison would be meaningless`);
      return;
    }

    const cases = [...HAND_CASES, ...generatedCases(), ...generatedValueCases()];
    // One subprocess for the whole corpus: per-case spawning turned a
    // two-second test into a two-minute one.
    const files: string[] = [];
    for (const [index, c] of cases.entries()) {
      const file = join(dir, `case${index}.action.ts`);
      await writeFile(file, c.source, "utf8");
      files.push(file);
    }
    const { stdout } = await run(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", PROBE, JSON.stringify(files)],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024 },
    );
    const native = JSON.parse(stdout) as Outcome[];
    assert.equal(native.length, cases.length, "the probe must report one outcome per case");

    const unsafe: string[] = [];
    const mismatched: string[] = [];
    const tightened: string[] = [];
    let refusedBecauseNodeWould = 0;

    for (const [index, c] of cases.entries()) {
      const nat = native[index] as Outcome;
      const sta = staticOutcome(c.source);
      const report = `${c.name}\n    native: ${nat.kind === "throw" ? "THROW " : ""}${nat.detail}\n    static: ${sta.kind === "throw" ? "THROW " : ""}${sta.detail}`;

      if (nat.kind === "throw") {
        // The dangerous direction: Node refuses the module, we hand back an
        // action for it.
        if (sta.kind === "throw") refusedBecauseNodeWould++;
        else unsafe.push(report);
        continue;
      }
      // Refusing something Node would have loaded is always allowed.
      if (sta.kind === "throw") continue;
      if (nat.detail === sta.detail) continue;
      if (EXPECTED_TIGHTENINGS.has(c.name)) tightened.push(c.name);
      else mismatched.push(report);
    }

    assert.deepEqual(
      unsafe,
      [],
      `the evaluator returned a value for a module Node REFUSES to load — it is describing a module that cannot exist:\n  ${unsafe.join("\n  ")}`,
    );
    assert.deepEqual(
      mismatched,
      [],
      `the evaluator returned a DIFFERENT value than the runtime; every difference must be a listed, deliberate tightening:\n  ${mismatched.join("\n  ")}`,
    );
    assert.deepEqual(
      [...tightened].sort(),
      [...EXPECTED_TIGHTENINGS.keys()].sort(),
      "every deliberate tightening must still be exercised — and no case may be listed that no longer diverges",
    );
    // The corpus is worthless if nothing in it actually exercises the
    // early-error detection, so pin that it does.
    assert.ok(
      refusedBecauseNodeWould > 20,
      `expected the corpus to contain many modules Node rejects, saw ${refusedBecauseNodeWould}`,
    );
  });
});
