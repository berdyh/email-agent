#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();

const requiredCards = [
  "packages/core/src/actions/MODULE.md",
  "packages/core/src/agents/MODULE.md",
  "packages/core/src/analysis/MODULE.md",
  "packages/core/src/config/MODULE.md",
  "packages/core/src/db/MODULE.md",
  "packages/core/src/gmail/MODULE.md",
  "packages/core/src/notifications/MODULE.md",
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
}

if (violations.length > 0) {
  console.error("Module boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Module boundary check passed (${requiredCards.length} cards checked).`);
