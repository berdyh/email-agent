#!/usr/bin/env node
import { access, lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();

const requiredCards = [
  "packages/core/src/actions/MODULE.md",
  "packages/core/src/agents/MODULE.md",
  "packages/core/src/analysis/MODULE.md",
  "packages/core/src/config/MODULE.md",
  "packages/core/src/db/MODULE.md",
  "packages/core/src/gmail/MODULE.md",
  "packages/core/src/shared/MODULE.md",
  "packages/web/src/app/MODULE.md",
  "packages/web/src/components/actions/MODULE.md",
  "packages/web/src/components/mail/MODULE.md",
  "packages/web/src/components/shared/MODULE.md",
  "packages/web/src/components/ui/MODULE.md",
  "packages/web/src/hooks/MODULE.md",
  "packages/web/src/modules/api/MODULE.md",
  "packages/web/src/store/MODULE.md",
  "packages/cli/src/MODULE.md",
  "action-skills-workspace/MODULE.md",
];

const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  "dist",
  "node_modules",
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSourceFiles(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(path, files);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];

/**
 * `CLAUDE.md` and `AGENTS.md` must be ONE FILE.
 *
 * They used to be two separate files with heavily overlapping content, hand-
 * synced, and they drifted — repeatedly, and in the direction that costs most:
 * a `mergeInsert` recommendation survived in one after being disproved and
 * removed from the other, `getEmails` was still described as chaining
 * `.where()` long after it stopped, and a find/replace had rewritten the whole
 * Agent Executors section into advice about a `Codex-executor.ts` and a `Codex`
 * env var that do not exist. Every agent session loads one of these two files,
 * so a wrong line in the copy nobody fixed teaches the wrong thing until
 * somebody notices — which is how it produced real defects rather than just
 * untidiness.
 *
 * A symlink makes the drift IMPOSSIBLE rather than detectable-after-the-fact,
 * and it matches the convention the bare-repo container already documents. This
 * check exists for the ways a symlink can quietly stop being one: a checkout on
 * a filesystem without symlink support materialises it as a text file
 * containing the target path, and an editor or a script can replace it with a
 * regular copy. Either way the two files are separate again, and nothing else
 * would say so.
 */
async function checkInstructionFilesAreOneFile() {
  let stats;
  try {
    stats = await lstat(join(root, "CLAUDE.md"));
  } catch {
    violations.push("CLAUDE.md is missing; it must be a symlink to AGENTS.md");
    return;
  }

  if (!stats.isSymbolicLink()) {
    violations.push(
      "CLAUDE.md is a regular file. It must be a symlink to AGENTS.md — two separate " +
        "instruction files drift, and the drift teaches the wrong thing to whichever " +
        "agent reads the copy nobody fixed. Restore it with: " +
        "rm CLAUDE.md && ln -s AGENTS.md CLAUDE.md",
    );
    return;
  }

  const target = await readlink(join(root, "CLAUDE.md"));
  if (target !== "AGENTS.md") {
    violations.push(
      `CLAUDE.md points at "${target}"; it must point at AGENTS.md (a relative link, ` +
        "so it survives being cloned to any path)",
    );
  }

  if (!(await exists(join(root, "AGENTS.md")))) {
    violations.push("AGENTS.md is missing; it is the real instruction file");
  }
}

await checkInstructionFilesAreOneFile();

for (const card of requiredCards) {
  if (!(await exists(join(root, card)))) {
    violations.push(`missing module card: ${card}`);
  }
}

for (const file of await collectSourceFiles(join(root, "packages"))) {
  const rel = relative(root, file);
  const source = await readFile(file, "utf-8");

  if (rel.startsWith("packages/cli/src/") && source.includes("@email-agent/core/")) {
    violations.push(`${rel}: CLI must import from @email-agent/core barrel, not subpaths`);
  }

  if (
    rel.startsWith("packages/web/src/") &&
    !rel.startsWith("packages/web/src/app/api/") &&
    !rel.startsWith("packages/web/src/modules/api/") &&
    source.includes("@email-agent/core")
  ) {
    violations.push(`${rel}: non-API web code must not import core runtime directly`);
  }

  // The deep operations path is the approval gate's one sanctioned webpack-only
  // access to Gmail write ops (manual mail actions, click-is-the-approval).
  // Every other consumer must go through the approval queue instead.
  if (
    rel.startsWith("packages/web/src/") &&
    source.includes("@email-agent/core/gmail/operations") &&
    rel !== "packages/web/src/app/api/gmail/[id]/route.ts"
  ) {
    violations.push(
      `${rel}: @email-agent/core/gmail/operations is reserved for the manual mail route; use the approval queue`,
    );
  }
}

if (violations.length > 0) {
  console.error("Module boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Module boundary check passed (${requiredCards.length} cards checked, ` +
    "CLAUDE.md -> AGENTS.md verified).",
);
