export {
  type AppConfig,
  type AgentMode,
  type AgentId,
  type GmailAutoApplyConfig,
  type RetentionConfig,
  type AccountConfig,
} from "./types.js";
export { defaultConfig, SESSION_PATH } from "./defaults.js";
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
export {
  UNSAFE_PATH_SEGMENTS,
  UnsafeConfigPathError,
  getNestedConfigValue,
  setNestedConfigValue,
} from "./dotted-path.js";
export {
  // The unlock-token + session store behind the local web UI. ONE
  // implementation, reached by three callers that must agree: the CLI (mint),
  // the API guard layer (validate), and the server-component page gate
  // (validate). A second spelling of any of this is a silent lockout.
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  UNLOCK_REQUIRED_CODE,
  SESSION_TTL_MS,
  UNLOCK_TOKEN_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_FAILURES,
  type UnlockMint,
  type UnlockExchangeFailure,
  type UnlockExchangeResult,
  isUnlockGateEnabled,
  mintUnlockToken,
  exchangeUnlockToken,
  hasValidSession,
  revokeAllSessions,
} from "./session.js";
