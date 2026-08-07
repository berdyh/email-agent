import ts from "typescript";
import type { EmailAction } from "./types.js";

/**
 * Guard and static evaluator for action source.
 *
 * Actions are pure data: an id, a name, a description, and a prompt. They are
 * written by an LLM (`POST /api/actions/generate`), and they used to be
 * dynamically imported IN-PROCESS with full Node privileges, which ran their
 * top-level code before anything inspected the exported object.
 *
 * They are no longer imported at all. `extractActionData()` walks the same
 * allowlist this guard enforces and RETURNS the values it proves are literal,
 * so a file in `ACTIONS_DIR` is read as data and never enters the module graph
 * (see `user-actions.ts` and `registry.ts`). The guard still runs at save time,
 * where refusing is cheap and the message can be fed back to the model — but
 * the load path no longer depends on it having run.
 *
 * The save-time check and the load-time extractor are deliberately the SAME
 * traversal: `findActionSourceViolations()` is `analyzeActionSource()` with the
 * values thrown away. A second, parallel allowlist would drift, and the drift
 * would be a bypass.
 *
 * This is an ALLOWLIST over the parsed syntax tree, deliberately not a
 * denylist over source text. The first version of this guard blanked strings
 * and comments and then regex-matched for `process`, `eval`, `Function(` and
 * friends. Review broke it in one line:
 *
 *     const p = ({}).constructor.constructor("return process")();
 *
 * That recovers the Function constructor without ever writing the token
 * `Function(`, and the dangerous keyword rides along inside a string argument,
 * which the stripper had already blanked. A second bypass slipped a live
 * `data:` URL past the type-only check with `export { default as type } from`.
 * Both are instances of the same lesson: enumerating forbidden spellings
 * cannot work, because the language has unbounded ways to name a value.
 *
 * So instead of asking "does this contain something bad?", the guard asks
 * "is this exactly the small shape a data file is allowed to have?" Only
 * `import type`, type declarations, variable statements whose initializers are
 * static data, and `export default` are admitted, and a file built from nothing
 * but those contains no construct that can run at import time.
 *
 * Note what that framing deliberately does NOT say. It would be false to claim
 * that the absence of calls, member access and `new` is sufficient for
 * inertness: the rules below have to refuse four constructs in which none of
 * those three node kinds appears anywhere in the tree — a bare value import of
 * a `data:` URL and the live re-export `export { default as type } from
 * "data:…"` (both fetch and run another module), `using` (whose disposal hook
 * runs later), and a `__proto__` object key (which sets the object's prototype
 * instead of binding a property of that name, so the value extracted here would
 * not be the value the runtime produces). Sufficiency comes from the allowlist
 * admitting only known-inert shapes. It never comes from any list of forbidden
 * ones, however that list is phrased.
 *
 * Not executing the file is only half the job. The other half is that the value
 * this returns must be the value the runtime WOULD have produced — otherwise
 * the evaluator is describing a different module than the one on disk, and the
 * difference is exploitable. Two consequences run through the code below:
 *
 *  - Where the evaluator cannot be sure it matches, it REFUSES. Every construct
 *    it does not model (a live `import()`, `export { x as action }`, a getter, a
 *    BigInt literal, a computed key) is a violation, never a best guess.
 *  - Where the runtime would refuse, the evaluator refuses too. A module is
 *    strict code, and strict code has early errors that plain parsing does not
 *    report — a duplicate lexical declaration, a binding called `eval`, a
 *    duplicate export, an uninitialized `const`.
 *    `ts.createSourceFile().parseDiagnostics` covers syntax only (TypeScript
 *    checks these in a later grammar pass), so those classes are detected
 *    explicitly (`FORBIDDEN_BINDING_NAMES`, `duplicate-declaration`,
 *    `duplicate-export`, `uninitialized-const`). Accepting a file Node would
 *    reject with `SyntaxError` means loading an action that could not exist.
 *
 * Those early-error classes are found by DIFFERENTIAL testing, not by reading
 * the spec and hoping: `action-source-guard.differential.test.ts` runs every
 * case through real Node and through this evaluator and compares the outcomes.
 * `uninitialized-const` survived a corpus of a hundred hand-written cases and
 * fell out on the first run of a MECHANICALLY GENERATED corpus — a
 * cross-product of the dimensions this walk branches on. Hand-picked cases only
 * ever cover the bugs someone already imagined; when adding a branch here, add
 * its dimension to the generator rather than an example to the list.
 *
 * And the module semantics themselves are modelled, not assumed: a named export
 * is a LIVE binding read at the end of evaluation, while `export default`
 * snapshots its operand where it stands, and `mod.default ?? mod.action` falls
 * back on the VALUE being nullish rather than on the default export's presence.
 *
 * Remaining limits, stated plainly: this stops code in `ACTIONS_DIR` files from
 * running, whatever put them there — it does nothing about malicious local code
 * outside the action pathway, which can read the stored OAuth tokens and drive
 * the Gmail REST API itself. See the approval gate section of TODOS.md.
 */

/** A single reason a source file was rejected. */
export interface ActionSourceViolation {
  rule: string;
  detail: string;
}

/**
 * Names a MODULE may not bind. Module code is always strict, and strict code
 * adds early errors that plain parsing does not produce — so a file using one
 * of these parses cleanly here and then throws `SyntaxError` in Node. A file
 * the runtime would refuse must be refused here too, or the evaluator is
 * answering a question about a module that could never exist.
 *
 * The list is deliberate, not a guess:
 *
 *  - `eval` and `arguments` — early error for any BindingIdentifier in strict
 *    code (ES2025 13.1.1).
 *  - the future reserved words that are reserved ONLY in strict mode:
 *    `implements`, `interface`, `let`, `package`, `private`, `protected`,
 *    `public`, `static`, `yield` (ES2025 12.7.2).
 *  - `await`, reserved specifically in module code.
 *
 * The always-reserved words (`class`, `const`, `enum`, `function`, `new`,
 * `this`, `typeof`, `void`, `with`, …) are NOT listed, because they are not
 * parseable as a binding name at all: `ts.createSourceFile` already reports a
 * parse diagnostic for each of them, which the `unparseable` rule catches.
 * That was verified for every word in the ES2025 ReservedWord production
 * rather than assumed.
 *
 * Matching is on the identifier's COOKED text, so `const eval` — which
 * Node also rejects — cannot spell its way past this.
 */
const FORBIDDEN_BINDING_NAMES: ReadonlySet<string> = new Set([
  "eval",
  "arguments",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
]);

/** `let`/`const` create a lexical binding; `var` creates a var-scoped one. */
type BindingKind = "lexical" | "var";

function bindingKindOf(declarationList: ts.VariableDeclarationList): BindingKind {
  const flags = declarationList.flags;
  return (flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 ? "lexical" : "var";
}

function isConstDeclaration(declarationList: ts.VariableDeclarationList): boolean {
  return (declarationList.flags & ts.NodeFlags.Const) !== 0;
}

/**
 * `declare` makes a statement ambient: it describes something assumed to exist
 * rather than creating it, and is erased entirely. So `declare const process =
 * "safe"` binds nothing — every later mention of `process` resolves to the real
 * global. Treating that as a data binding would hand an action the live
 * `process` object while every expression still looked like a literal.
 *
 * Decorators are rejected for the plain reason that they are call expressions
 * attached to a declaration, and this guard's whole premise is that no call
 * survives anywhere in the tree.
 */
function forbiddenModifier(statement: ts.Statement): ActionSourceViolation | undefined {
  if (ts.canHaveDecorators(statement) && (ts.getDecorators(statement)?.length ?? 0) > 0) {
    return {
      rule: "decorator",
      detail: "decorators are call expressions, which an action file may not contain",
    };
  }

  if (ts.canHaveModifiers(statement)) {
    const isAmbient = ts
      .getModifiers(statement)
      ?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
    if (isAmbient === true) {
      return {
        rule: "ambient-declaration",
        detail:
          "`declare` binds nothing at runtime, so the name would resolve to a global instead of to this file's data",
      };
    }
  }

  return undefined;
}

/** True for a statement carrying the `export` modifier. */
function isExported(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  return (
    ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

/** Describes where in the file the problem is, for a human-readable message. */
function describe(node: ts.Node, source: ts.SourceFile): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const text = node.getText(source).replace(/\s+/g, " ").slice(0, 60);
  return `line ${line + 1}:${character + 1} — ${text}`;
}

/**
 * Static evaluation of an expression that is pure data: literals, and
 * objects/arrays built only from pure data. Anything that could run — a call, a
 * member access, a `new`, a function, a tagged or interpolated template — is
 * not data.
 *
 * This is the predicate the guard used to be, made value-producing. Where it
 * once answered "yes, that is inert", it now answers "yes, and here is the
 * value", so the load path can obtain an action without importing its file.
 * `reason` carries a specific violation when one exists; otherwise the caller
 * reports its own generic message for the position.
 */
type DataResult =
  | { ok: true; value: unknown }
  | { ok: false; reason?: ActionSourceViolation };

const NOT_DATA: DataResult = { ok: false };

interface DataContext {
  /** Names this file has BOUND to data, mapped to the value they were bound to. */
  safeNames: ReadonlyMap<string, unknown>;
  /** True when the target file is .js, where TypeScript syntax cannot run. */
  isJs: boolean;
}

/**
 * The literal text of a non-computed property key, or undefined when the key
 * is computed or private (both of which this guard refuses anyway).
 */
function staticPropertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function evaluatePureData(node: ts.Expression, ctx: DataContext): DataResult {
  // A name is data only if this file already bound it to data. That admits the
  // natural `const PROMPT = "..."` then `prompt: PROMPT` shape, while a name
  // this file never declared (`process`, `globalThis`) resolves to a global and
  // is refused. `safeNames` is filled in source order, so a name can only
  // resolve to something declared above it — matching what the file would do.
  if (ts.isIdentifier(node)) {
    if (!ctx.safeNames.has(node.text)) return NOT_DATA;
    return { ok: true, value: ctx.safeNames.get(node.text) };
  }

  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return { ok: true, value: (node as unknown as ts.LiteralLikeNode).text };
    case ts.SyntaxKind.NumericLiteral: {
      // `.text` is the scanner's normalised form (separators removed, radix
      // prefix kept), so `Number()` reproduces the runtime value. Refuse
      // anything that does not, rather than inventing a number.
      const value = Number((node as ts.NumericLiteral).text);
      return Number.isNaN(value) ? NOT_DATA : { ok: true, value };
    }
    case ts.SyntaxKind.TrueKeyword:
      return { ok: true, value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { ok: true, value: false };
    case ts.SyntaxKind.NullKeyword:
      return { ok: true, value: null };
    default:
      break;
  }

  // Negative and explicitly positive numbers: `-1`, `+1`.
  if (ts.isPrefixUnaryExpression(node)) {
    if (!ts.isNumericLiteral(node.operand)) return NOT_DATA;
    const magnitude = Number(node.operand.text);
    if (Number.isNaN(magnitude)) return NOT_DATA;
    if (node.operator === ts.SyntaxKind.MinusToken) return { ok: true, value: -magnitude };
    if (node.operator === ts.SyntaxKind.PlusToken) return { ok: true, value: magnitude };
    return NOT_DATA;
  }

  // `{...} as EmailAction` / `{...} satisfies EmailAction` are type-level only.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    // `as`/`satisfies` are TypeScript-only; in a .js file they never run.
    if (ctx.isJs) return NOT_DATA;
    return evaluatePureData(node.expression, ctx);
  }

  if (ts.isParenthesizedExpression(node)) {
    return evaluatePureData(node.expression, ctx);
  }

  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      // A hole (`[, 1]`) and a spread are both not plain data.
      if (!ts.isExpression(element) || element.kind === ts.SyntaxKind.OmittedExpression) {
        return NOT_DATA;
      }
      const evaluated = evaluatePureData(element, ctx);
      if (!evaluated.ok) return evaluated;
      values.push(evaluated.value);
    }
    return { ok: true, value: values };
  }

  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const prop of node.properties) {
      // Shorthand (`{ a }`), spread (`{ ...x }`), methods, getters and setters
      // all either reference or run something. Only `key: <data>` is allowed.
      if (!ts.isPropertyAssignment(prop)) return NOT_DATA;
      // A computed key can evaluate an expression, so require a literal name.
      const key = staticPropertyKey(prop.name);
      if (key === undefined) return NOT_DATA;
      // `{ __proto__: x }` does NOT bind a property called `__proto__` — in an
      // object literal (identifier or string key alike; only a COMPUTED key is
      // exempt, and those are already refused) it invokes the prototype setter.
      // Same lesson as `declare`: ask whether the syntax binds what it appears
      // to bind. Refusing keeps the extracted object identical to the source's
      // apparent shape instead of quietly differing from it.
      if (key === "__proto__") {
        return {
          ok: false,
          reason: {
            rule: "proto-key",
            detail:
              "`__proto__` in an object literal sets the prototype instead of defining a property; use a different key",
          },
        };
      }
      const evaluated = evaluatePureData(prop.initializer, ctx);
      if (!evaluated.ok) return evaluated;
      // Later duplicates win, as they would at runtime.
      value[key] = evaluated.value;
    }
    return { ok: true, value };
  }

  return NOT_DATA;
}

/**
 * The result of one traversal: every reason the source is not a safe action
 * file, plus the values of whatever it legitimately exports. Both the save-time
 * guard and the load-time extractor read this, so they can never disagree.
 */
interface ActionSourceAnalysis {
  violations: ActionSourceViolation[];
  /**
   * Value of `export default <data>`. `export default` SNAPSHOTS its operand
   * where it appears — it is not a live binding — so this is recorded at the
   * statement, which is what the runtime does too.
   */
  defaultExport?: { value: unknown };
  /**
   * Value of the exported `action` binding at the END of module evaluation,
   * mirroring `mod.action`. A named ESM export is a LIVE binding, so it must be
   * read after the whole file has been walked; snapshotting it at the exported
   * declaration would report a value a legal later `var action = …` overwrote.
   */
  namedActionExport?: { value: unknown };
}

function analyzeActionSource(source: string, filename: string): ActionSourceAnalysis {
  const violations: ActionSourceViolation[] = [];
  const analysis: ActionSourceAnalysis = { violations };
  // Actions may be saved as .action.js as well as .action.ts. TypeScript-only
  // syntax in a .js file saves fine and then fails to import — a dead action.
  // ScriptKind alone does not catch it (the parser accepts TS syntax in JS mode
  // and only complains in a later grammar pass), so the small set of TS-only
  // constructs this allowlist permits is rejected explicitly below.
  const isJs = /\.[cm]?js$/i.test(filename);
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

  // A file we cannot parse is a file we cannot reason about. Refuse it rather
  // than scanning a tree that may not reflect what Node will actually run.
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0] as ts.Diagnostic;
    violations.push({
      rule: "unparseable",
      detail: `the file is not valid TypeScript: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
    });
    return analysis;
  }

  // Names this file has bound to static data, mapped to the value bound, built
  // up in source order so a declaration can only reference something declared
  // above it.
  const safeNames = new Map<string, unknown>();
  const ctx: DataContext = { safeNames, isJs };

  // Module-scope binding bookkeeping, for the early errors `parseDiagnostics`
  // cannot see (they are binding-time, not parse-time). Every top-level name
  // this file declares, whether or not its initializer turned out to be data —
  // an illegal redeclaration is illegal regardless of what it was assigned.
  const declaredNames = new Map<string, BindingKind>();
  // Exported names, for the "duplicate export" early error. `default` is
  // tracked under its own key, which no binding name can collide with because
  // `default` is an always-reserved word and cannot be bound.
  const exportedNames = new Set<string>();
  // Whether the file exports a binding literally called `action`, which is what
  // `mod.action` would have read. Its VALUE is resolved after the walk.
  let exportsNamedAction = false;

  const declareName = (name: ts.Identifier, kind: BindingKind, node: ts.Node): void => {
    const text = name.text;
    if (FORBIDDEN_BINDING_NAMES.has(text)) {
      violations.push({
        rule: "reserved-binding",
        detail:
          `\`${text}\` cannot be bound in a module — module code is strict, so Node throws SyntaxError before the file loads (${describe(node, sourceFile)})`,
      });
      return;
    }
    const previous = declaredNames.get(text);
    // `var` may redeclare `var`. Anything involving a lexical binding is an
    // early error, so the file would never load.
    if (previous !== undefined && (previous === "lexical" || kind === "lexical")) {
      violations.push({
        rule: "duplicate-declaration",
        detail:
          `\`${text}\` is already declared in this file, and a lexical redeclaration makes Node throw SyntaxError before the file loads (${describe(node, sourceFile)})`,
      });
      return;
    }
    // Only `var` after `var` reaches here, so the recorded kind stays `var`.
    declaredNames.set(text, kind);
  };

  const declareExport = (name: string, node: ts.Node): void => {
    if (exportedNames.has(name)) {
      violations.push({
        rule: "duplicate-export",
        detail:
          `\`${name}\` is exported twice, which Node rejects as a duplicate export before the file loads (${describe(node, sourceFile)})`,
      });
      return;
    }
    exportedNames.add(name);
  };

  for (const statement of sourceFile.statements) {
    const modifierViolation = forbiddenModifier(statement);
    if (modifierViolation) {
      violations.push({
        rule: modifierViolation.rule,
        detail: `${modifierViolation.detail} (${describe(statement, sourceFile)})`,
      });
      continue;
    }

    // `import type { EmailAction } from "..."` — erased before the module runs.
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) {
        if (isJs) {
          violations.push({
            rule: "typescript-in-js",
            detail: `\`import type\` is TypeScript syntax and will not load from a .js file (${describe(statement, sourceFile)})`,
          });
        }
        continue;
      }
      violations.push({
        rule: "value-import",
        detail:
          `only \`import type\` is allowed, because it is erased before the module runs (${describe(statement, sourceFile)})`,
      });
      continue;
    }

    // `export type { X }` is fine. `export { default as type } from "data:..."`
    // is NOT — the module specifier is fetched and executed on import, and only
    // `isTypeOnly` distinguishes the two reliably.
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        if (isJs) {
          violations.push({
            rule: "typescript-in-js",
            detail: `\`export type\` is TypeScript syntax and will not load from a .js file (${describe(statement, sourceFile)})`,
          });
        }
        continue;
      }
      violations.push({
        rule: "value-export",
        detail: `re-exporting loads and runs the other module (${describe(statement, sourceFile)})`,
      });
      continue;
    }

    // `export default action;` or `export default { ... };`
    if (ts.isExportAssignment(statement)) {
      // `export =` is CommonJS-only TypeScript. It cannot execute anything on
      // its own, but Node's type stripper cannot erase it either, so the file
      // would save and then fail to import — a silent dead action.
      if (statement.isExportEquals) {
        violations.push({
          rule: "export-equals",
          detail: `use \`export default\`; \`export =\` cannot be type-stripped, so the action would never load (${describe(statement, sourceFile)})`,
        });
        continue;
      }
      // Two `export default`s is a duplicate-export early error, not a
      // last-one-wins overwrite.
      declareExport("default", statement);
      const evaluated = evaluatePureData(statement.expression, ctx);
      if (evaluated.ok) {
        analysis.defaultExport = { value: evaluated.value };
        continue;
      }
      violations.push(
        evaluated.reason ?? {
          rule: "computed-export",
          detail: `export default must be a name declared in this file or a literal, not an expression (${describe(statement, sourceFile)})`,
        },
      );
      continue;
    }

    // `const action: EmailAction = { ... };`
    if (ts.isVariableStatement(statement)) {
      // `using` / `await using` parse as ordinary variable statements, but
      // leaving the module scope looks up and CALLS Symbol.dispose /
      // Symbol.asyncDispose on the value. That is a call this file never
      // spells, so it would run behind the allowlist's back. (NodeFlags.Using
      // is a distinct bit from Const/Let, so this matches both forms and no
      // plain declaration.)
      if ((statement.declarationList.flags & ts.NodeFlags.Using) !== 0) {
        violations.push({
          rule: "using-declaration",
          detail: `\`using\` invokes a disposal hook when the module finishes; declare with \`const\` (${describe(statement, sourceFile)})`,
        });
        continue;
      }
      const kind = bindingKindOf(statement.declarationList);
      const exported = isExported(statement);
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          violations.push({
            rule: "destructuring",
            detail: `only plain names may be declared (${describe(decl, sourceFile)})`,
          });
          continue;
        }
        // Record the binding before looking at the initializer: an illegal
        // name, or an illegal redeclaration, makes the file fail to load
        // whatever it was assigned.
        declareName(decl.name, kind, decl);
        if (exported) {
          declareExport(decl.name.text, decl);
          // `export const action = {...}` is what a runtime import surfaces as
          // `mod.action`. An unexported `const action` exports nothing, so it
          // is deliberately not treated as an export here. The VALUE is read
          // after the walk, because a named export is a live binding.
          if (decl.name.text === "action") exportsNamedAction = true;
        }
        if (isJs && decl.type !== undefined) {
          violations.push({
            rule: "typescript-in-js",
            detail: `a type annotation will not load from a .js file (${describe(decl, sourceFile)})`,
          });
          continue;
        }
        if (decl.initializer === undefined) {
          // A missing initializer means two different things, and conflating
          // them was a bypass. For `var`/`let` it is legal and simply leaves
          // the binding `undefined` — and `var x;` after `var x = <data>` does
          // NOT reset the binding, so `safeNames` must be left alone. For
          // `const` it is an EARLY ERROR: Node refuses the module outright with
          // `SyntaxError: 'const' declarations must be initialized`, so a file
          // containing one describes a module that cannot exist.
          //
          // `ts.createSourceFile().parseDiagnostics` does not report it — like
          // the other early errors above, TypeScript checks it in a later
          // grammar pass, not in the parser — so it is detected explicitly.
          //
          // The rest of the "no initializer" family is already covered: `using`
          // and `await using` also require an initializer, and both are refused
          // wholesale further up for their disposal hook.
          if (isConstDeclaration(statement.declarationList)) {
            violations.push({
              rule: "uninitialized-const",
              detail:
                `\`${decl.name.text}\` is declared \`const\` with no value, and Node throws SyntaxError before the file loads (${describe(decl, sourceFile)})`,
            });
          }
          continue;
        }
        const evaluated = evaluatePureData(decl.initializer, ctx);
        if (evaluated.ok) {
          safeNames.set(decl.name.text, evaluated.value);
          continue;
        }
        violations.push(
          evaluated.reason ?? {
            rule: "computed-value",
            detail:
              `an action is static data, so values may only be literals, objects and arrays — no calls, member access, \`new\`, functions or interpolation (${describe(decl, sourceFile)})`,
          },
        );
      }
      continue;
    }

    // Pure type declarations disappear at runtime.
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      statement.kind === ts.SyntaxKind.EmptyStatement
    ) {
      if (isJs && statement.kind !== ts.SyntaxKind.EmptyStatement) {
        violations.push({
          rule: "typescript-in-js",
          detail: `type declarations will not load from a .js file (${describe(statement, sourceFile)})`,
        });
      }
      continue;
    }

    violations.push({
      rule: "statement-not-allowed",
      detail:
        `an action file may only contain \`import type\`, type declarations, a data assignment and \`export default\` (${describe(statement, sourceFile)})`,
    });
  }

  // A named ESM export is a LIVE binding: `mod.action` reads whatever the name
  // holds when the importer looks, not what it held at the `export` keyword. So
  // the value is taken from `safeNames` AFTER the whole file has been walked.
  //
  //     export var action = { id: "junk", … };
  //     var action = null;                      // legal `var` redeclaration
  //
  // is `mod.action === null` at runtime. Snapshotting at the exported
  // declaration reported the object instead, which would resurrect an action
  // the file deliberately unset. `export var action;` with no initializer
  // anywhere leaves the binding `undefined`, and `safeNames` has no entry, so
  // no export is recorded — matching the runtime again.
  if (exportsNamedAction && safeNames.has("action")) {
    analysis.namedActionExport = { value: safeNames.get("action") };
  }

  return analysis;
}

/**
 * Collect every reason `source` is not a safe action file. Empty array means
 * the source is acceptable. This is `analyzeActionSource()` with the extracted
 * values discarded — same traversal, same allowlist, by construction.
 */
export function findActionSourceViolations(
  source: string,
  filename = "action.ts",
): ActionSourceViolation[] {
  return analyzeActionSource(source, filename).violations;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Why a syntactically fine action file still yields no action, or undefined
 * when it yields one.
 *
 * DELIBERATE TIGHTENING, stated rather than hidden: the loaders this replaced
 * only tested `action?.id && action?.name && action?.prompt` for truthiness, so
 * `{ id: 1, name: true, prompt: ["p"] }` used to load and then flow a number
 * into every place an action id is treated as a string. This requires the three
 * fields to be non-empty strings. That is a stricter rule than the old loader's
 * — the point of saying so here is that the file is refused OUT LOUD, with the
 * field that is wrong, instead of vanishing from the action list.
 */
function describeUnusableAction(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `its exported value is ${describeType(value)}, not an action object`;
  }
  const record = value as Record<string, unknown>;
  const bad = (["id", "name", "prompt"] as const).filter((k) => !isNonEmptyString(record[k]));
  if (bad.length === 0) return undefined;
  return `${bad
    .map((k) => `\`${k}\` is ${record[k] === undefined ? "missing" : describeType(record[k])}`)
    .join(", ")} — an action needs \`id\`, \`name\` and \`prompt\` as non-empty strings`;
}

/** Options for `extractActionData()`. */
export interface ExtractActionDataOptions {
  /**
   * Called when the file parses as pure data and exports something, but that
   * something is not a usable action. Nothing on this path may fail silently:
   * without this, a file with a numeric `id` just disappeared from the list
   * with no way to find out why.
   */
  onDiagnostic?: (message: string) => void;
}

/**
 * Statically evaluate a pure-data action file and return the action it
 * describes, WITHOUT ever executing it. Throws `UnsafeActionSourceError` when
 * the source is not the pure-data shape — the same allowlist enforced at save
 * time — and returns undefined when the file is safe but exports no usable
 * action, reporting why through `onDiagnostic`.
 *
 * This replaces `import()` on the load path. Nothing from `ACTIONS_DIR` enters
 * the module graph, so a file that was hand-dropped, or written before the
 * save-time guard existed, gets the same treatment as a generated one.
 */
export function extractActionData(
  source: string,
  filename = "action.ts",
  options: ExtractActionDataOptions = {},
): EmailAction | undefined {
  const analysis = analyzeActionSource(source, filename);
  if (analysis.violations.length > 0) {
    throw new UnsafeActionSourceError(analysis.violations);
  }

  // Mirrors the runtime resolution this replaces: `mod.default ?? mod.action`.
  // `??` acts on the VALUE, not on "was a default export present": a file with
  // `export default null` alongside `export const action = {…}` resolves to the
  // NAMED action at runtime, because `null ?? mod.action` is `mod.action`. An
  // absent default export is `undefined`, which the same expression covers, so
  // presence never needs to be consulted separately.
  //
  // CORRECTION to commit 9461eef, which claimed `export default undefined` gets
  // the same fallback "for free". It does not, and the parity it claimed does
  // not exist: bare `undefined` is an unbound identifier, so the file is refused
  // with `computed-export` above and never reaches this line. Refusing is the
  // safe direction — the file would have fallen back to the named export at
  // runtime, so we return less, never more — but that is a fail-closed
  // divergence, not parity, and saying otherwise is the defect. Two operands
  // reach here nullish: an ABSENT default export, and `export default null`.
  const value = analysis.defaultExport?.value ?? analysis.namedActionExport?.value;

  // Nothing exported at all, or everything exported was nullish — the runtime
  // would have produced no action either, and there is nothing to report.
  if (value === undefined || value === null) return undefined;

  const problem = describeUnusableAction(value);
  if (problem !== undefined) {
    options.onDiagnostic?.(`${filename} exports no usable action: ${problem}`);
    return undefined;
  }

  // Anything else the file declares is carried through untouched, as an import
  // would.
  return value as EmailAction;
}

/** Thrown when action source fails the guard, at save time or at load time. */
export class UnsafeActionSourceError extends Error {
  readonly violations: ActionSourceViolation[];

  constructor(violations: ActionSourceViolation[]) {
    const lines = violations.map((v) => `  - ${v.rule}: ${v.detail}`).join("\n");
    super(
      `Refusing this action file: its code does more than describe an analysis.\n${lines}\n` +
        "Actions are pure data (id, name, description, prompt). Gmail changes happen " +
        "through the approval queue after the user approves them, never inside an action file.",
    );
    this.name = "UnsafeActionSourceError";
    this.violations = violations;
  }
}

/**
 * A one-string explanation of why a file on disk was not loaded, listing every
 * violation. A refused file must be diagnosable — silently skipping one is how
 * "my action disappeared" becomes unanswerable.
 */
export function describeActionSourceRefusal(filename: string, err: unknown): string {
  if (err instanceof UnsafeActionSourceError) {
    const lines = err.violations.map((v) => `  - ${v.rule}: ${v.detail}`).join("\n");
    return (
      `Refusing to load ${filename}: an action file must be pure data, and this one is not. ` +
      `Its code is NOT executed — it is parsed, and parsing found:\n${lines}`
    );
  }
  return `Failed to read ${filename}: ${String(err)}`;
}

/**
 * Throw `UnsafeActionSourceError` unless `source` is a pure-data action file.
 * Call this before persisting any generated action.
 */
export function assertSafeActionSource(source: string, filename?: string): void {
  const violations = findActionSourceViolations(source, filename);
  if (violations.length > 0) {
    throw new UnsafeActionSourceError(violations);
  }
}
