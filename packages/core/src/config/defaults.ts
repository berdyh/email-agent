import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "./types.js";

export const DATA_DIR = join(homedir(), ".gmail-reader", "data");
export const SETTINGS_PATH = join(homedir(), ".gmail-reader", "settings.json");
export const ACTIONS_DIR = join(homedir(), ".gmail-reader", "actions");
export const LANCEDB_DIR = join(DATA_DIR, "lancedb");

export const defaultConfig: AppConfig = {
  agentMode: "all-agents",
  preferredAgent: "claude",
  gcp: {
    projectId: "",
    pubsubTopic: "gmail-reader-notifications",
    pubsubSubscription: "gmail-reader-sub",
  },
  notifications: {
    desktop: {
      enabled: true,
      priorityOnly: true,
    },
    webhooks: [],
  },
  prompts: {
    summary: `Summarize the following email concisely. Return a JSON object with:
- overview: 1-2 sentence summary
- sections: array of { text, citation: { startOffset, endOffset, previewText } }
- keyActions: array of action items mentioned`,
    priority: `Analyze the email and determine its priority level. Consider urgency, sender importance, action required, and deadlines. Return: { level: "high" | "medium" | "low", reason: string, actionRequired: boolean, deadline?: string }`,
    clustering: `Given these email summaries, group them into semantic clusters. Each cluster should have a name, description, and list of email IDs.`,
    digest: `Create a daily digest from these subscription emails. Group by sender/topic, summarize key points, and highlight anything actionable.`,
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 768,
  },
  ui: {
    theme: "system",
    sidebarCollapsed: false,
    panelWidths: [20, 35, 45],
  },
  dataDir: DATA_DIR,
};
