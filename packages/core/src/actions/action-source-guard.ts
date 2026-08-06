/**
 * Save-time guard for generated action source.
 *
 * Actions are pure data: an id, a name, a description, and a prompt. They are
 * written by an LLM (`POST /api/actions/generate`) and then dynamically
 * imported IN-PROCESS with full Node privileges, and their top-level code runs
 * before anything inspects the exported object. That ordering is why this
 * guard exists at SAVE time: once the module is imported, it is too late.
 *
 * Scope, honestly: this stops an innocently generated action from reaching
 * capabilities it was never supposed to have (the realistic failure, since the
 * author is a language model following a prompt). It is a denylist over source
 * text, so it is not a containment boundary against a determined attacker, and
 * it does not see a file dropped into ACTIONS_DIR by hand. See the approval
 * gate section of TODOS.md for the full threat model.
 */

/** A single reason a source file was rejected. */
export interface ActionSourceViolation {
  rule: string;
  detail: string;
}

/**
 * Replace every comment and string/template literal body with spaces, so the
 * remaining "skeleton" contains only code structure.
 *
 * This matters because an action's `prompt` is arbitrary English inside a
 * template literal. Scanning raw source would reject a perfectly good action
 * whose prompt says "look for emails about import tariffs" or "ignore fetch
 * confirmations". Only what survives stripping is real code.
 *
 * Length is preserved so any offsets stay meaningful for future callers.
 */
export function stripStringsAndComments(source: string): {
  skeleton: string;
  hasTemplateInterpolation: boolean;
} {
  let skeleton = "";
  let hasTemplateInterpolation = false;

  type Mode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";
  let mode: Mode = "code";

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    const next = source[i + 1];

    // Preserve newlines in every mode so line numbers survive.
    const blank = char === "\n" ? "\n" : " ";

    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line-comment";
        skeleton += "  ";
        i += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block-comment";
        skeleton += "  ";
        i += 1;
        continue;
      }
      if (char === "'") {
        mode = "single";
        skeleton += " ";
        continue;
      }
      if (char === '"') {
        mode = "double";
        skeleton += " ";
        continue;
      }
      if (char === "`") {
        mode = "template";
        skeleton += " ";
        continue;
      }
      skeleton += char;
      continue;
    }

    if (mode === "line-comment") {
      if (char === "\n") {
        mode = "code";
        skeleton += "\n";
        continue;
      }
      skeleton += blank;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        skeleton += "  ";
        i += 1;
        continue;
      }
      skeleton += blank;
      continue;
    }

    // String and template modes below.
    if (char === "\\") {
      // Skip the escaped character so a trailing \" does not end the literal.
      skeleton += " ";
      if (i + 1 < source.length) {
        skeleton += source[i + 1] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    if (mode === "single" && char === "'") {
      mode = "code";
      skeleton += " ";
      continue;
    }
    if (mode === "double" && char === '"') {
      mode = "code";
      skeleton += " ";
      continue;
    }
    if (mode === "template") {
      if (char === "`") {
        mode = "code";
        skeleton += " ";
        continue;
      }
      // `${...}` can smuggle executable code into what should be static data.
      // Flag it and keep the body blanked; the file is rejected either way.
      if (char === "$" && next === "{") {
        hasTemplateInterpolation = true;
        skeleton += "  ";
        i += 1;
        continue;
      }
    }

    skeleton += blank;
  }

  return { skeleton, hasTemplateInterpolation };
}

/** Patterns that must never appear in an action's executable code. */
const forbiddenPatterns: ReadonlyArray<{ rule: string; pattern: RegExp; detail: string }> = [
  {
    rule: "dynamic-import",
    pattern: /\bimport\s*\(/,
    detail: "dynamic import() can load any module at runtime",
  },
  {
    rule: "import-meta",
    pattern: /\bimport\s*\.\s*meta\b/,
    detail: "import.meta exposes the module URL, which resolves paths to the rest of the app",
  },
  {
    rule: "require",
    pattern: /\brequire\s*\(/,
    detail: "require() can load any module at runtime",
  },
  {
    rule: "eval",
    pattern: /\beval\s*\(/,
    detail: "eval() executes arbitrary code",
  },
  {
    rule: "function-constructor",
    pattern: /\bFunction\s*\(/,
    detail: "the Function constructor executes arbitrary code",
  },
  {
    rule: "process",
    pattern: /\bprocess\b/,
    detail: "process exposes the environment, credentials, and the ability to spawn commands",
  },
  {
    rule: "globalThis",
    pattern: /\bglobalThis\b/,
    detail: "globalThis reaches every runtime capability",
  },
  {
    rule: "network",
    pattern: /\b(?:fetch|XMLHttpRequest)\s*\(/,
    detail: "an action must not make network calls; it returns data for the runner to act on",
  },
];

/**
 * Collect every reason `source` is not a safe action file. Empty array means
 * the source is acceptable.
 */
export function findActionSourceViolations(source: string): ActionSourceViolation[] {
  const { skeleton, hasTemplateInterpolation } = stripStringsAndComments(source);
  const violations: ActionSourceViolation[] = [];

  if (hasTemplateInterpolation) {
    violations.push({
      rule: "template-interpolation",
      detail:
        "template literals must be static text; `${...}` can evaluate arbitrary code at module load",
    });
  }

  // Any import that is not erased at runtime is a capability. `import type`
  // survives because TypeScript strips it before the module ever executes.
  for (const match of skeleton.matchAll(/\bimport\b/g)) {
    const rest = skeleton.slice(match.index + "import".length);
    if (/^\s*type\b/.test(rest)) continue;
    // Dynamic import and import.meta get their own, clearer messages below.
    if (/^\s*[(.]/.test(rest)) continue;
    violations.push({
      rule: "value-import",
      detail:
        "actions may only `import type { EmailAction } from \"@email-agent/core\"`; a value import gives the action runtime capabilities",
    });
    break;
  }

  // `export ... from` is a value import wearing a different hat.
  if (/\bexport\b(?![^;\n]*\btype\b)[^;\n]*\bfrom\b/.test(skeleton)) {
    violations.push({
      rule: "re-export",
      detail: "re-exporting from another module pulls that module's values into the action",
    });
  }

  for (const { rule, pattern, detail } of forbiddenPatterns) {
    if (pattern.test(skeleton)) {
      violations.push({ rule, detail });
    }
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
export function assertSafeActionSource(source: string): void {
  const violations = findActionSourceViolations(source);
  if (violations.length > 0) {
    throw new UnsafeActionSourceError(violations);
  }
}
