import { join } from "node:path";
import { homedir } from "node:os";
import { VECTOR_DIMENSION } from "../shared/vector.js";
import type { AppConfig } from "./types.js";

export const DATA_DIR = join(homedir(), ".email-agent", "data");
export const SETTINGS_PATH = join(homedir(), ".email-agent", "settings.json");
export const ACTIONS_DIR = join(homedir(), ".email-agent", "actions");
// The unlock-token and session store behind the local web UI. Same
// homedir()-at-module-load hazard as the paths above: a test that imports a core
// module before `useTempHome()` runs has already resolved this against the
// developer's real $HOME. See `config/session.ts`.
export const SESSION_PATH = join(homedir(), ".email-agent", "session.json");
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
    autoApplyActions: false,
    autoApplyAcknowledged: false,
  },
  ui: {
    fetchInterval: 0,
    fetchScope: "unread",
  },
  retention: {
    // Deliberately generous: these rows are the audit trail of real Gmail
    // mutations, and the failure direction of a wrong value here is losing
    // evidence the user cannot reconstruct. A year keeps the table bounded
    // without making the trail useless.
    approvalQueueDays: 365,
  },
  dataDir: DATA_DIR,
  accounts: [],
};
