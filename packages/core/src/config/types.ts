export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "openrouter"
  | "claude-sdk"
  | "direct-api";
export type AgentMode = "all-agents" | "hybrid" | "direct-api";
export type EmbeddingProvider = "openai" | "openrouter" | "local";

export interface GcpConfig {
  projectId: string;
}

export interface PromptsConfig {
  summary: string;
  digest: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

export interface GmailSyncConfig {
  /**
   * Apply AI-proposed Gmail changes (trash, spam, archive, labels) immediately
   * instead of queueing them for approval. Opt-in and off by default; it only
   * takes effect while `autoApplyAcknowledged` is also true.
   */
  autoApplyActions: boolean;
  /**
   * Records that the user read and accepted the auto-apply risk warnings in
   * Settings. `normalizeSettings` forces `autoApplyActions` back to false
   * whenever this is false, so no config path can enable unattended Gmail
   * mutations without an explicit acknowledgement.
   */
  autoApplyAcknowledged: boolean;
}

export interface UiConfig {
  fetchInterval: number;
  fetchScope: "unread" | "all";
}

export interface AccountConfig {
  email: string;
  name?: string;
  isDefault?: boolean;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  agentMode: AgentMode;
  preferredAgent: AgentId;
  gcp: GcpConfig;
  prompts: PromptsConfig;
  embedding: EmbeddingConfig;
  gmail: GmailSyncConfig;
  ui: UiConfig;
  dataDir: string;
  accounts: AccountConfig[];
  oauth?: OAuthConfig;
}
