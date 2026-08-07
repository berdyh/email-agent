export {
  type AppConfig,
  type AgentMode,
  type AgentId,
  type GmailAutoApplyConfig,
  type RetentionConfig,
  type AccountConfig,
} from "./types.js";
export { defaultConfig } from "./defaults.js";
export {
  loadSettings,
  saveSettings,
  normalizeSettings,
  // The single implementation of "autoApplyActions requires
  // autoApplyAcknowledged". Exported so the web API boundary can enforce the
  // same rule rather than its own copy of it.
  normalizeAutoApplyConsent,
  clearSettingsCache,
} from "./settings.js";
