import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIONS_DIR } from "../config/defaults.js";
import type { EmailAction } from "./types.js";

const BUILT_IN_DIR = new URL("./built-in/", import.meta.url);

export class ActionRegistry {
  private actions = new Map<string, EmailAction>();

  async loadAll(): Promise<void> {
    this.actions.clear();
    await this.loadFromDirectory(BUILT_IN_DIR, true);
    await this.loadFromDirectory(pathToFileURL(ACTIONS_DIR + "/"), false);
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

  private async loadFromDirectory(
    dirUrl: URL,
    builtIn: boolean,
  ): Promise<void> {
    let entries: string[];
    try {
      const dirPath =
        dirUrl.protocol === "file:" ? new URL(dirUrl).pathname : String(dirUrl);
      entries = await readdir(dirPath);
    } catch {
      return; // Directory doesn't exist yet
    }

    for (const entry of entries) {
      if (!entry.endsWith(".action.ts") && !entry.endsWith(".action.js"))
        continue;

      try {
        const fileUrl = new URL(entry, dirUrl);
        const mod = (await import(fileUrl.href)) as {
          default?: EmailAction;
          action?: EmailAction;
        };
        const action = mod.default ?? mod.action;
        if (action?.id && action?.name && action?.prompt) {
          action.builtIn = builtIn;
          this.actions.set(action.id, action);
        }
      } catch {
        // Skip invalid action files
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
