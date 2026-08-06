import { readdir, readFile, writeFile, unlink, mkdir, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIONS_DIR } from "../config/defaults.js";
import { assertSafeActionSource } from "./action-source-guard.js";
import type { EmailAction } from "./types.js";
import {
  extractActionIdFromSource,
  normalizeSnapshotFilename,
  normalizeUserActionFilename,
  resolveUserActionFilePath,
} from "./user-action-paths.js";

export interface UserActionMeta {
  id: string;
  name: string;
  description: string;
  filename: string;
}

export interface SnapshotEntry {
  filename: string;
  timestamp: string;
  snapshotPath: string;
}

const SNAPSHOTS_DIR = join(ACTIONS_DIR, ".snapshots");

/** Extract id/name/description from action source via regex (webpack-safe — no dynamic import). */
export async function listUserActions(): Promise<UserActionMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(ACTIONS_DIR);
  } catch {
    return [];
  }

  const results: UserActionMeta[] = [];

  for (const entry of entries) {
    let filename: string;
    try {
      filename = normalizeUserActionFilename(entry);
    } catch {
      continue;
    }

    try {
      const content = await readFile(resolveUserActionFilePath(ACTIONS_DIR, filename), "utf-8");
      const id = extractActionIdFromSource(content) ?? filename.replace(/\.action\.[tj]s$/, "");
      const name = content.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? id;
      const description = content.match(/description:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
      results.push({ id, name, description, filename });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/** Save (or overwrite) a user action file. Snapshots previous version if it exists. */
export async function saveUserAction(filename: string, content: string): Promise<void> {
  // Reject before anything touches disk. A saved action is later imported
  // in-process with full Node privileges, and its top-level code runs before
  // the exported object is ever inspected — so this is the last point at which
  // refusing is still cheap.
  const safeFilename = normalizeUserActionFilename(filename);
  // Pass the name so a .action.js file is parsed as JavaScript; parsing it as
  // TypeScript would wave through syntax Node cannot actually run.
  assertSafeActionSource(content, safeFilename);

  await mkdir(ACTIONS_DIR, { recursive: true });

  const filePath = resolveUserActionFilePath(ACTIONS_DIR, safeFilename);

  // Snapshot existing file before overwrite
  try {
    await readFile(filePath, "utf-8");
    await mkdir(SNAPSHOTS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotName = `${safeFilename}.${ts}.ts`;
    await copyFile(filePath, join(SNAPSHOTS_DIR, snapshotName));
  } catch {
    // No existing file to snapshot
  }

  await writeFile(filePath, content, "utf-8");
}

/** Delete a user action file. */
export async function deleteUserAction(filename: string): Promise<void> {
  await unlink(resolveUserActionFilePath(ACTIONS_DIR, filename));
}

// Bypass webpack's static analysis of dynamic import — defers to Node's native
// loader so .action.ts files can be imported at runtime from outside the bundle.
const nativeImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>;

/** Dynamic-import a single user action by ID (server-side only). */
export async function loadUserAction(id: string): Promise<EmailAction | undefined> {
  let entries: string[];
  try {
    entries = await readdir(ACTIONS_DIR);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    let filename: string;
    try {
      filename = normalizeUserActionFilename(entry);
    } catch {
      continue;
    }

    try {
      const content = await readFile(resolveUserActionFilePath(ACTIONS_DIR, filename), "utf-8");
      const fileId = extractActionIdFromSource(content);
      if (fileId !== id) continue;

      const fileUrl = pathToFileURL(resolveUserActionFilePath(ACTIONS_DIR, filename));
      let mod: { default?: EmailAction; action?: EmailAction };
      try {
        mod = (await nativeImport(fileUrl.href)) as {
          default?: EmailAction;
          action?: EmailAction;
        };
      } catch (err) {
        console.warn(`[loadUserAction] Failed to import ${filename}:`, err);
        continue;
      }
      const action = mod.default ?? mod.action;
      if (action?.id && action?.name && action?.prompt) {
        action.builtIn = false;
        return action;
      }
    } catch {
      // Skip invalid files
    }
  }

  return undefined;
}

/** Read raw source code of a user action file. */
export async function readUserActionSource(filename: string): Promise<string> {
  return readFile(resolveUserActionFilePath(ACTIONS_DIR, filename), "utf-8");
}

/** List snapshots for a given action filename. */
export async function listSnapshots(filename: string): Promise<SnapshotEntry[]> {
  const safeFilename = normalizeUserActionFilename(filename);
  let entries: string[];
  try {
    entries = await readdir(SNAPSHOTS_DIR);
  } catch {
    return [];
  }

  const prefix = `${safeFilename}.`;
  const snapshots: SnapshotEntry[] = [];

  for (const entry of entries) {
    try {
      normalizeSnapshotFilename(entry);
    } catch {
      continue;
    }
    if (!entry.startsWith(prefix)) continue;
    // Format: filename.action.ts.2026-02-28T12-00-00-000Z.ts
    const tsMatch = entry.slice(prefix.length).replace(/\.ts$/, "");
    snapshots.push({
      filename: basename(entry),
      timestamp: tsMatch.replace(/-/g, (m, offset: number) => {
        // Restore ISO format: dashes in date stay, colons and dots restored
        if (offset <= 9) return m; // Date dashes
        return ":";
      }),
      snapshotPath: basename(entry),
    });
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Restore a snapshot — copies snapshot file back to ACTIONS_DIR, snapshotting current first. */
export async function restoreSnapshot(snapshotFilename: string, originalFilename: string): Promise<void> {
  const safeSnapshotFilename = normalizeSnapshotFilename(snapshotFilename);
  const safeOriginalFilename = normalizeUserActionFilename(originalFilename);
  if (!safeSnapshotFilename.startsWith(`${safeOriginalFilename}.`)) {
    throw new Error("Snapshot does not belong to the requested action");
  }

  const snapshotContent = await readFile(join(SNAPSHOTS_DIR, safeSnapshotFilename), "utf-8");
  await saveUserAction(safeOriginalFilename, snapshotContent);
}
