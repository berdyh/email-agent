import { readdir, readFile, writeFile, unlink, mkdir, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { ACTIONS_DIR } from "../config/defaults.js";
import {
  assertSafeActionSource,
  describeActionSourceRefusal,
  extractActionData,
} from "./action-source-guard.js";
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
  // Reject before anything touches disk. The load path no longer executes
  // action files, so this is not the last line of defence any more — it is the
  // point where refusing is cheap and the reason can be fed straight back to
  // the model that wrote the file, instead of surfacing later as an action
  // that mysteriously never appears.
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

/**
 * Read a single user action by ID (server-side only).
 *
 * The file is PARSED, never imported. An action is pure data, so the parser
 * can hand back the same object an import would have produced without the file
 * ever entering the module graph. That is what makes the save-time guard
 * unnecessary for safety here: a file hand-dropped into `ACTIONS_DIR`, or
 * written before the guard existed, gets exactly the same treatment as a
 * generated one — its code does not run either way.
 */
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

      let action: EmailAction | undefined;
      try {
        action = extractActionData(content, filename, {
          onDiagnostic: (message) => console.warn(`[loadUserAction] ${message}`),
        });
      } catch (err) {
        console.warn(`[loadUserAction] ${describeActionSourceRefusal(filename, err)}`);
        continue;
      }
      if (action) {
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
