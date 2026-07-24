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
  pubsubTopic: string;
  pubsubSubscription: string;
  watchExpiration?: string;
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
  syncActions: boolean;
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
