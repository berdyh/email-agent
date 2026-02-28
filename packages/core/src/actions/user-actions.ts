import { readdir, readFile, writeFile, unlink, mkdir, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIONS_DIR } from "../config/defaults.js";
import type { EmailAction } from "./types.js";

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
    if (!entry.endsWith(".action.ts") && !entry.endsWith(".action.js")) continue;

    try {
      const content = await readFile(join(ACTIONS_DIR, entry), "utf-8");
      const id = content.match(/id:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? entry.replace(/\.action\.[tj]s$/, "");
      const name = content.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? id;
      const description = content.match(/description:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
      results.push({ id, name, description, filename: entry });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/** Save (or overwrite) a user action file. Snapshots previous version if it exists. */
export async function saveUserAction(filename: string, content: string): Promise<void> {
  await mkdir(ACTIONS_DIR, { recursive: true });

  const filePath = join(ACTIONS_DIR, filename);

  // Snapshot existing file before overwrite
  try {
    await readFile(filePath, "utf-8");
    await mkdir(SNAPSHOTS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotName = `${filename}.${ts}.ts`;
    await copyFile(filePath, join(SNAPSHOTS_DIR, snapshotName));
  } catch {
    // No existing file to snapshot
  }

  await writeFile(filePath, content, "utf-8");
}

/** Delete a user action file. */
export async function deleteUserAction(filename: string): Promise<void> {
  const filePath = join(ACTIONS_DIR, filename);
  await unlink(filePath);
}

/** Dynamic-import a single user action by ID (server-side only). */
export async function loadUserAction(id: string): Promise<EmailAction | undefined> {
  let entries: string[];
  try {
    entries = await readdir(ACTIONS_DIR);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".action.ts") && !entry.endsWith(".action.js")) continue;

    try {
      const content = await readFile(join(ACTIONS_DIR, entry), "utf-8");
      const fileId = content.match(/id:\s*["'`]([^"'`]+)["'`]/)?.[1];
      if (fileId !== id) continue;

      const fileUrl = pathToFileURL(join(ACTIONS_DIR, entry));
      const mod = (await import(fileUrl.href)) as {
        default?: EmailAction;
        action?: EmailAction;
      };
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
  return readFile(join(ACTIONS_DIR, filename), "utf-8");
}

/** List snapshots for a given action filename. */
export async function listSnapshots(filename: string): Promise<SnapshotEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(SNAPSHOTS_DIR);
  } catch {
    return [];
  }

  const prefix = `${filename}.`;
  const snapshots: SnapshotEntry[] = [];

  for (const entry of entries) {
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
      snapshotPath: join(SNAPSHOTS_DIR, entry),
    });
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Restore a snapshot — copies snapshot file back to ACTIONS_DIR, snapshotting current first. */
export async function restoreSnapshot(snapshotFilename: string, originalFilename: string): Promise<void> {
  const snapshotContent = await readFile(join(SNAPSHOTS_DIR, snapshotFilename), "utf-8");
  await saveUserAction(originalFilename, snapshotContent);
}
