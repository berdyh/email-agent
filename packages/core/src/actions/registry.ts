import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACTIONS_DIR } from "../config/defaults.js";
import { describeActionSourceRefusal, extractActionData } from "./action-source-guard.js";
import type { EmailAction } from "./types.js";

const BUILT_IN_DIR = new URL("./built-in/", import.meta.url);

const isActionFilename = (name: string): boolean =>
  name.endsWith(".action.ts") || name.endsWith(".action.js");

/**
 * The two action directories are loaded differently on purpose.
 *
 * Built-ins live in this repo, are reviewed like the rest of it, and really are
 * modules — they keep a native `import()`. `ACTIONS_DIR` holds files the app
 * generated or the user dropped in, and those are PARSED as data and never
 * imported, so nothing from that directory ever executes in this process.
 */
export class ActionRegistry {
  private actions = new Map<string, EmailAction>();

  async loadAll(): Promise<void> {
    this.actions.clear();
    await this.loadBuiltIns();
    await this.loadUserActions();
  }

  /** Load pre-imported actions without filesystem discovery (webpack-safe). */
  loadStatic(actions: EmailAction[]): void {
    this.actions.clear();
    for (const action of actions) {
      if (action.id && action.name && action.prompt) {
        this.actions.set(action.id, action);
      }
    }
  }

  /** In-repo actions: trusted, and genuine modules. */
  private async loadBuiltIns(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(new URL(BUILT_IN_DIR).pathname);
    } catch {
      return; // Directory doesn't exist yet
    }

    for (const entry of entries) {
      if (!isActionFilename(entry)) continue;

      try {
        const mod = (await import(new URL(entry, BUILT_IN_DIR).href)) as {
          default?: EmailAction;
          action?: EmailAction;
        };
        const action = mod.default ?? mod.action;
        if (action?.id && action?.name && action?.prompt) {
          action.builtIn = true;
          this.actions.set(action.id, action);
        }
      } catch (err) {
        // A broken built-in is our bug, not the user's — say so.
        console.warn(`[ActionRegistry] Failed to load built-in action ${entry}:`, err);
      }
    }
  }

  /**
   * `ACTIONS_DIR`: parsed as data, never imported. A file that is not pure data
   * is refused WITH its violations — the previous `catch {}` swallowed every
   * failure, so a hand-dropped executable file simply vanished from the list.
   */
  private async loadUserActions(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(ACTIONS_DIR);
    } catch {
      return; // Directory doesn't exist yet
    }

    for (const entry of entries) {
      if (!isActionFilename(entry)) continue;

      let action: EmailAction | undefined;
      try {
        const content = await readFile(join(ACTIONS_DIR, entry), "utf-8");
        action = extractActionData(content, entry, {
          onDiagnostic: (message) => console.warn(`[ActionRegistry] ${message}`),
        });
      } catch (err) {
        console.warn(`[ActionRegistry] ${describeActionSourceRefusal(entry, err)}`);
        continue;
      }
      if (action) {
        action.builtIn = false;
        this.actions.set(action.id, action);
      }
    }
  }

  getAll(): EmailAction[] {
    return Array.from(this.actions.values());
  }

  get(id: string): EmailAction | undefined {
    return this.actions.get(id);
  }
}
