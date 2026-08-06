import ts from "typescript";

/**
 * Save-time guard for generated action source.
 *
 * Actions are pure data: an id, a name, a description, and a prompt. They are
 * written by an LLM (`POST /api/actions/generate`) and then dynamically
 * imported IN-PROCESS with full Node privileges, and their top-level code runs
 * before anything inspects the exported object. That ordering is why this
 * guard exists at SAVE time: once the module is imported, it is too late.
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
 * "is this exactly the small shape a data file is allowed to have?" A file
 * with no call expression, no member access, and no `new` anywhere in its tree
 * cannot execute anything at import time, whatever it is spelled like.
 *
 * Remaining limits, stated plainly: this runs only on save, so a file dropped
 * into ACTIONS_DIR by hand is never seen, and files written before the guard
 * existed are not re-checked. See the approval gate section of TODOS.md.
 */

/** A single reason a source file was rejected. */
export interface ActionSourceViolation {
  rule: string;
  detail: string;
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

/** Describes where in the file the problem is, for a human-readable message. */
function describe(node: ts.Node, source: ts.SourceFile): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const text = node.getText(source).replace(/\s+/g, " ").slice(0, 60);
  return `line ${line + 1}:${character + 1} — ${text}`;
}

/**
 * True when an expression is static data: literals, and objects/arrays built
 * only from static data. Anything that could run — a call, a member access, a
 * `new`, a function, a tagged or interpolated template — is not data.
 */
interface DataContext {
  safeNames: ReadonlySet<string>;
  /** True when the target file is .js, where TypeScript syntax cannot run. */
  isJs: boolean;
}

function isPureDataExpression(node: ts.Expression, ctx: DataContext): boolean {
  // A name is data only if this file already bound it to data. That admits the
  // natural `const PROMPT = "..."` then `prompt: PROMPT` shape, while a name
  // this file never declared (`process`, `globalThis`) resolves to a global and
  // is refused.
  if (ts.isIdentifier(node)) {
    return ctx.safeNames.has(node.text);
  }

  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      break;
  }

  // Negative and explicitly positive numbers: `-1`, `+1`.
  if (ts.isPrefixUnaryExpression(node)) {
    const isSign =
      node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken;
    return isSign && ts.isNumericLiteral(node.operand);
  }

  // `{...} as EmailAction` / `{...} satisfies EmailAction` are type-level only.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    // `as`/`satisfies` are TypeScript-only; in a .js file they never run.
    if (ctx.isJs) return false;
    return isPureDataExpression(node.expression, ctx);
  }

  if (ts.isParenthesizedExpression(node)) {
    return isPureDataExpression(node.expression, ctx);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((el) => ts.isExpression(el) && isPureDataExpression(el, ctx));
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((prop) => {
      // Shorthand (`{ a }`), spread (`{ ...x }`), methods, getters and setters
      // all either reference or run something. Only `key: <data>` is allowed.
      if (!ts.isPropertyAssignment(prop)) return false;
      // A computed key can evaluate an expression, so require a literal name.
      if (ts.isComputedPropertyName(prop.name)) return false;
      return isPureDataExpression(prop.initializer, ctx);
    });
  }

  return false;
}

/**
 * Collect every reason `source` is not a safe action file. Empty array means
 * the source is acceptable.
 */
export function findActionSourceViolations(
  source: string,
  filename = "action.ts",
): ActionSourceViolation[] {
  const violations: ActionSourceViolation[] = [];
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
    return violations;
  }

  // Names this file has bound to static data, built up in source order so a
  // declaration can only reference something declared above it.
  const safeNames = new Set<string>();
  const ctx: DataContext = { safeNames, isJs };

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
      if (isPureDataExpression(statement.expression, ctx)) continue;
      violations.push({
        rule: "computed-export",
        detail: `export default must be a name declared in this file or a literal, not an expression (${describe(statement, sourceFile)})`,
      });
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
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          violations.push({
            rule: "destructuring",
            detail: `only plain names may be declared (${describe(decl, sourceFile)})`,
          });
          continue;
        }
        if (isJs && decl.type !== undefined) {
          violations.push({
            rule: "typescript-in-js",
            detail: `a type annotation will not load from a .js file (${describe(decl, sourceFile)})`,
          });
          continue;
        }
        if (decl.initializer === undefined) continue;
        if (isPureDataExpression(decl.initializer, ctx)) {
          safeNames.add(decl.name.text);
          continue;
        }
        violations.push({
          rule: "computed-value",
          detail:
            `an action is static data, so values may only be literals, objects and arrays — no calls, member access, \`new\`, functions or interpolation (${describe(decl, sourceFile)})`,
        });
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

  return violations;
}

/** Thrown when generated action source fails the guard. */
export class UnsafeActionSourceError extends Error {
  readonly violations: ActionSourceViolation[];

  constructor(violations: ActionSourceViolation[]) {
    const lines = violations.map((v) => `  - ${v.rule}: ${v.detail}`).join("\n");
    super(
      `Refusing to save this action: its code does more than describe an analysis.\n${lines}\n` +
        "Actions are pure data (id, name, description, prompt). Gmail changes happen " +
        "through the approval queue after the user approves them, never inside an action file.",
    );
    this.name = "UnsafeActionSourceError";
    this.violations = violations;
  }
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
