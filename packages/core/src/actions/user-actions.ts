import { readdir, readFile, unlink } from "node:fs/promises";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "../shared/private-files.js";
import { join, basename } from "node:path";
import { ACTIONS_DIR } from "../config/defaults.js";
import {
  assertSafeActionSource,
  describeActionSourceRefusal,
  extractActionData,
} from "./action-source-guard.js";
import type { EmailAction } from "./types.js";
import {
  normalizeSnapshotFilename,
  normalizeUserActionFilename,
  resolveUserActionFilePath,
} from "./user-action-paths.js";

export interface UserActionMeta {
  id: string;
  name: string;
  description: string;
  filename: string;
  /**
   * Why this file is listed but will not run, when that is the case. A listed
   * action that cannot be loaded is the thing this module got wrong before: the
   * list showed one identity and the loader looked for another, so running it
   * produced a bare "Action not found" with no way to learn why.
   */
  problem?: string;
}

/**
 * One file in `ACTIONS_DIR`, read ONCE, by ONE reader.
 *
 * `listUserActions()` used to derive the id with a regex over the source and
 * `loadUserAction()` used to find a file with that regex and then return the
 * PARSED id — two readers, so a file could present two different identities.
 * `numeric.action.ts` containing `export default { id: 1, … }` listed as
 * `numeric` (the regex finds no quoted id, so the filename stem was used), and
 * then `loadUserAction("numeric")` compared the regex id — `undefined` — against
 * `"numeric"`, skipped the file before extraction, and returned nothing. The
 * diagnostic that exists precisely to explain that file never ran.
 *
 * So identity comes from the evaluator, once, and everything downstream reads
 * this. A file that yields no action still gets an identity — its filename stem
 * — because it must stay listable and editable; what it also gets is `problem`,
 * so the reason travels with it instead of being rediscovered per call site.
 */
export interface UserActionFile {
  filename: string;
  /** The identity this file presents to every caller. */
  id: string;
  /** The action, when the file describes a usable one. */
  action?: EmailAction;
  /** Why it does not, when it does not. Always set when `action` is undefined. */
  problem?: string;
}

const actionIdFromFilename = (filename: string): string =>
  filename.replace(/\.action\.[tj]s$/, "");

/**
 * Which directory an operation applies to.
 *
 * `ACTIONS_DIR` is `~/.email-agent/actions`, a homedir constant, and every
 * function here used to read it directly. That made the load path untestable
 * end to end: proving "a malicious action file does not execute" means putting
 * a genuinely malicious file somewhere and loading it for real, and no test may
 * write to the developer's home directory to do it. So the directory is an
 * argument, defaulting to the app's — the production call sites are unchanged,
 * and a test can point the loader at a temp directory instead.
 */
const resolveActionsDir = (dir?: string): string => dir ?? ACTIONS_DIR;

const snapshotsDirFor = (dir?: string): string => join(resolveActionsDir(dir), ".snapshots");

/**
 * Read and statically evaluate every action file in `ACTIONS_DIR`.
 *
 * Files are PARSED, never imported (see `action-source-guard.ts`), so this is
 * also the only place that decides what an action file's id is.
 */
export async function readUserActionFiles(dir?: string): Promise<UserActionFile[]> {
  const actionsDir = resolveActionsDir(dir);
  let entries: string[];
  try {
    entries = await readdir(actionsDir);
  } catch {
    return [];
  }

  const files: UserActionFile[] = [];

  for (const entry of entries) {
    let filename: string;
    try {
      filename = normalizeUserActionFilename(entry);
    } catch {
      continue;
    }

    let content: string;
    try {
      content = await readFile(resolveUserActionFilePath(actionsDir, filename), "utf-8");
    } catch {
      // Unreadable between `readdir` and here — deleted, or not ours. That is
      // "no such file", not "a broken action", so it is not listed at all.
      continue;
    }

    let action: EmailAction | undefined;
    let problem: string | undefined;
    try {
      action = extractActionData(content, filename, {
        onDiagnostic: (message) => {
          problem = message;
        },
      });
      if (action) action.builtIn = false;
      else problem ??= `${filename} exports no action`;
    } catch (err) {
      action = undefined;
      problem = describeActionSourceRefusal(filename, err);
    }

    files.push({
      filename,
      // A file with no usable action still has to be findable, or it cannot be
      // fixed. It presents its filename stem, and it presents it to the list
      // and to the loader alike.
      id: action?.id ?? actionIdFromFilename(filename),
      ...(action === undefined ? {} : { action }),
      ...(problem === undefined ? {} : { problem }),
    });
  }

  return files;
}

export interface SnapshotEntry {
  filename: string;
  timestamp: string;
  snapshotPath: string;
}

/**
 * List every action file in `ACTIONS_DIR` with the identity it presents.
 *
 * The id here is the id `loadUserAction()` will look for, by construction: both
 * come from `readUserActionFiles()`. A file that yields no action is still
 * listed — it has to be, or it cannot be edited or deleted — but it carries the
 * reason in `problem` rather than a name and description scraped out of source
 * that does not load.
 */
export async function listUserActions(dir?: string): Promise<UserActionMeta[]> {
  return (await readUserActionFiles(dir)).map((file) => ({
    id: file.id,
    name: file.action?.name ?? file.id,
    description: file.action?.description ?? "",
    filename: file.filename,
    ...(file.problem === undefined ? {} : { problem: file.problem }),
  }));
}

/** Save (or overwrite) a user action file. Snapshots previous version if it exists. */
export async function saveUserAction(
  filename: string,
  content: string,
  dir?: string,
): Promise<void> {
  const actionsDir = resolveActionsDir(dir);
  // Reject before anything touches disk. The load path no longer executes
  // action files, so this is not the last line of defence any more — it is the
  // point where refusing is cheap and the reason can be fed straight back to
  // the model that wrote the file, instead of surfacing later as an action
  // that mysteriously never appears.
  const safeFilename = normalizeUserActionFilename(filename);
  // Pass the name so a .action.js file is parsed as JavaScript; parsing it as
  // TypeScript would wave through syntax Node cannot actually run.
  assertSafeActionSource(content, safeFilename);

  // NOT a bare mkdir, and NOT a bare writeFile below. Under the common
  // `umask 022` those produced a 0755 directory of 0644 files, which is the
  // same defect the mail database had: AGENTS.md claims everything under
  // `~/.email-agent/` is 0600 inside 0700, and this path was one of the places
  // that made the claim false. An action file is not a credential, but it is
  // the user's own automation over their mailbox — its prompt says what it
  // looks for and what it does about it — and there is no reason for another
  // local user to read it.
  await ensurePrivateDir(actionsDir);

  const filePath = resolveUserActionFilePath(actionsDir, safeFilename);

  // Snapshot existing file before overwrite
  try {
    const previous = await readFile(filePath, "utf-8");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotName = `${safeFilename}.${ts}.ts`;
    // Written through the private writer rather than `copyFile`, which
    // reproduces the SOURCE's mode — so a snapshot of a file an older version
    // left at 0644 would have been created at 0644 too, and the loose modes
    // would keep propagating forward one version at a time. The bytes are the
    // ones just read, so nothing is copied twice.
    await writePrivateFile(join(snapshotsDirFor(dir), snapshotName), previous);
  } catch {
    // No existing file to snapshot
  }

  await writePrivateFile(filePath, content);
}

/** Delete a user action file. */
export async function deleteUserAction(filename: string, dir?: string): Promise<void> {
  await unlink(resolveUserActionFilePath(resolveActionsDir(dir), filename));
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
 *
 * Returns undefined for an id nothing on disk answers to. When a file DOES
 * present that id and still yields no action, the reason is warned before
 * returning — that is the case a caller reports as "not found", and "not found"
 * with no explanation is exactly how a tightened validation rule goes silent.
 */
export async function loadUserAction(id: string, dir?: string): Promise<EmailAction | undefined> {
  const files = await readUserActionFiles(dir);

  const loadable = files.find((file) => file.action?.id === id);
  if (loadable?.action) return loadable.action;

  // Nothing loadable under that id. If a file nonetheless PRESENTS it — which
  // is the id `listUserActions()` showed the user — say why it did not load.
  for (const file of files) {
    if (file.id === id && file.problem !== undefined) {
      console.warn(`[loadUserAction] ${file.problem}`);
    }
  }

  return undefined;
}

/** Read raw source code of a user action file. */
export async function readUserActionSource(filename: string, dir?: string): Promise<string> {
  return readFile(resolveUserActionFilePath(resolveActionsDir(dir), filename), "utf-8");
}

/** List snapshots for a given action filename. */
export async function listSnapshots(filename: string, dir?: string): Promise<SnapshotEntry[]> {
  const safeFilename = normalizeUserActionFilename(filename);
  let entries: string[];
  try {
    entries = await readdir(snapshotsDirFor(dir));
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
export async function restoreSnapshot(
  snapshotFilename: string,
  originalFilename: string,
  dir?: string,
): Promise<void> {
  const safeSnapshotFilename = normalizeSnapshotFilename(snapshotFilename);
  const safeOriginalFilename = normalizeUserActionFilename(originalFilename);
  if (!safeSnapshotFilename.startsWith(`${safeOriginalFilename}.`)) {
    throw new Error("Snapshot does not belong to the requested action");
  }

  const snapshotContent = await readFile(join(snapshotsDirFor(dir), safeSnapshotFilename), "utf-8");
  await saveUserAction(safeOriginalFilename, snapshotContent, dir);
}
