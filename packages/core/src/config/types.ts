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

/**
 * The `gmail` section of `AppConfig`: the two booleans that decide whether an
 * action run may mutate Gmail without a further prompt.
 *
 * Named for what it holds. It used to be `GmailSyncConfig`, from a `syncActions`
 * field that no longer exists, and the name sent readers to `gmail/sync.ts` —
 * the fetch→embed→store pipeline, which has nothing to do with these flags.
 */
export interface GmailAutoApplyConfig {
  /**
   * Apply AI-proposed Gmail changes (trash, spam, archive, labels) immediately
   * instead of queueing them for approval. Opt-in and off by default; it only
   * takes effect while `autoApplyAcknowledged` is also true.
   */
  autoApplyActions: boolean;
  /**
   * Records that the user read and accepted the auto-apply risk warnings in
   * Settings. `normalizeAutoApplyConsent` (which `normalizeSettings` calls)
   * forces `autoApplyActions` back to false whenever this is false, so no
   * config path can enable unattended Gmail mutations without an explicit
   * acknowledgement.
   */
  autoApplyAcknowledged: boolean;
}

/**
 * Retention policy for append-only audit tables.
 *
 * REQUIRED on `AppConfig`. `normalizeSettings` and `defaultConfig` always
 * populate it, so a value read out of `loadSettings()` never lacks it — it was
 * declared optional for one wave only, so that adding it did not invalidate the
 * explicit `AppConfig` literals the web and CLI fixtures already declared on a
 * branch that could not edit those packages. An optional declaration on a field
 * that is always present invites callers to write a fallback, and the fallback
 * a reader reaches for here is `0`, which means "keep every record forever" —
 * the opposite of what core's sweep does with a missing block.
 */
export interface RetentionConfig {
  /**
   * Days a RESOLVED `pending_operations` row is kept before it may be pruned.
   * 0 (or negative) disables pruning entirely. Only `applied`/`rejected` rows
   * are ever eligible — see `buildPruneFilter` in `db/pending-operations.ts`.
   */
  approvalQueueDays: number;
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

export interface AppConfig {
  agentMode: AgentMode;
  preferredAgent: AgentId;
  gcp: GcpConfig;
  prompts: PromptsConfig;
  embedding: EmbeddingConfig;
  gmail: GmailAutoApplyConfig;
  ui: UiConfig;
  retention: RetentionConfig;
  dataDir: string;
  accounts: AccountConfig[];
}
