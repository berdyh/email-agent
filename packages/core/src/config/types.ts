export type AgentId = "claude" | "codex" | "gemini" | "openrouter";
export type AgentMode = "all-agents" | "hybrid" | "direct-api";
export type EmbeddingProvider = "openai" | "openrouter" | "local";

export interface GcpConfig {
  projectId: string;
  pubsubTopic: string;
  pubsubSubscription: string;
  watchExpiration?: string;
}

export interface NotificationConfig {
  desktop: {
    enabled: boolean;
    priorityOnly: boolean;
  };
  webhooks: WebhookConfig[];
}

export interface WebhookConfig {
  name: string;
  url: string;
  type: "slack" | "discord" | "generic";
  enabled: boolean;
}

export interface PromptsConfig {
  summary: string;
  priority: string;
  clustering: string;
  digest: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

export interface UiConfig {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  panelWidths: [number, number, number];
}

export interface AppConfig {
  agentMode: AgentMode;
  preferredAgent: AgentId;
  gcp: GcpConfig;
  notifications: NotificationConfig;
  prompts: PromptsConfig;
  embedding: EmbeddingConfig;
  ui: UiConfig;
  dataDir: string;
}
