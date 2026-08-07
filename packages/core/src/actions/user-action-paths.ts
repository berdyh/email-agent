import { basename, resolve, sep } from "node:path";

const USER_ACTION_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.action\.(ts|js)$/;

export function normalizeUserActionFilename(filename: string): string {
  const normalized = filename.trim();

  if (
    !normalized ||
    basename(normalized) !== normalized ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error("User action filename must be a simple filename");
  }

  if (!USER_ACTION_FILENAME_RE.test(normalized)) {
    throw new Error("User action filename must end with .action.ts or .action.js");
  }

  return normalized;
}

export function resolveUserActionFilePath(baseDir: string, filename: string): string {
  const root = resolve(baseDir);
  const target = resolve(root, normalizeUserActionFilename(filename));

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("User action filename resolves outside the actions directory");
  }

  return target;
}

export function normalizeSnapshotFilename(filename: string): string {
  const normalized = filename.trim();

  if (
    !normalized ||
    basename(normalized) !== normalized ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error("Snapshot filename must be a simple filename");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]+\.ts$/.test(normalized)) {
    throw new Error("Invalid snapshot filename");
  }

  return normalized;
}
