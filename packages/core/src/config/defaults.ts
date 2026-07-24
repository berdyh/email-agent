import { join } from "node:path";
import { homedir } from "node:os";
import { VECTOR_DIMENSION } from "../shared/vector.js";
import type { AppConfig } from "./types.js";

export const DATA_DIR = join(homedir(), ".email-agent", "data");
export const SETTINGS_PATH = join(homedir(), ".email-agent", "settings.json");
export const ACTIONS_DIR = join(homedir(), ".email-agent", "actions");
export const LANCEDB_DIR = join(DATA_DIR, "lancedb");

export const defaultConfig: AppConfig = {
  agentMode: "all-agents",
  preferredAgent: "claude",
  gcp: {
    projectId: "",
  },
  prompts: {
    summary: `Summarize the following email concisely. Return a JSON object with:
- overview: 1-2 sentence summary
- sections: array of { text, citation: { startOffset, endOffset, previewText } }
- keyActions: array of action items mentioned`,
    digest: `Create a daily digest from these subscription emails. Group by sender/topic, summarize key points, and highlight anything actionable.`,
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: VECTOR_DIMENSION,
  },
  gmail: {
    syncActions: false,
  },
  ui: {
    fetchInterval: 0,
    fetchScope: "unread",
  },
  dataDir: DATA_DIR,
  accounts: [],
};
