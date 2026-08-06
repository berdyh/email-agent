import { defaultConfig, type AppConfig } from "@email-agent/core/config";
import type { FetchOptions } from "@email-agent/core/gmail";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SETTING_KEYS = new Set([
  "agentMode",
  "preferredAgent",
  "gcp",
  "prompts",
  "embedding",
  "gmail",
  "ui",
  "dataDir",
  "accounts",
  "oauth",
]);

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  mode: "create" | "edit";
  currentCode?: string;
}

export interface ActionRunRequest {
  actionId: string;
  accountEmail?: string;
}

export interface UserActionSaveRequest {
  filename: string;
  content: string;
}

export interface UserActionDeleteRequest {
  filename: string;
}

export interface SnapshotRestoreRequest {
  snapshotFilename: string;
  originalFilename: string;
}

export type AccountPostRequest =
  | { action: "add" }
  | { action: "setDefault"; email: string };

export interface AccountDeleteRequest {
  email: string;
}

export interface EmailReadStatusRequest {
  isUnread: boolean;
}

export interface EmailIdRequest {
  emailId: string;
  accountId: string;
}

type SettingsUpdate = Partial<
  Omit<
    AppConfig,
    "gcp" | "prompts" | "embedding" | "gmail" | "ui" | "accounts" | "oauth"
  >
> & {
  gcp?: Partial<AppConfig["gcp"]>;
  prompts?: Partial<AppConfig["prompts"]>;
  embedding?: Partial<AppConfig["embedding"]>;
  gmail?: Partial<AppConfig["gmail"]>;
  ui?: Partial<AppConfig["ui"]>;
  accounts?: AppConfig["accounts"];
  oauth?: AppConfig["oauth"];
};

/**
 * Settings shape returned to clients: the full runtime config minus secrets.
 * Shared with web hooks so consumers get a real type instead of
 * `Record<string, unknown>`.
 */
export type SanitizedSettings = Omit<AppConfig, "oauth">;

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestValidationError("Request body must be an object");
  }
  return input as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} must be a string`);
  }
  return value;
}

function optionalPresentString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredPresentString(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestValidationError(`${field} is required`);
  }
  return value.trim();
}

function requiredPresentString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new RequestValidationError(`${field} is required`);
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} must be a string`);
  }
  if (value !== "" && !value.trim()) {
    throw new RequestValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${field} must be a boolean`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${field} must be a number`);
  }
  return value;
}

function parseMaxResults(value: unknown): number {
  if (value === undefined || value === null) return 500;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new RequestValidationError("maxResults must be an integer between 1 and 1000");
  }
  return value as number;
}

function parseIntegerParam(
  params: URLSearchParams,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = params.get(field);
  if (value === null || value === "") return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RequestValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function validateActionFilename(filename: string): string {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.action\.(ts|js)$/.test(filename)
  ) {
    throw new RequestValidationError("filename must be a local .action.ts or .action.js file");
  }
  return filename;
}

function validateSnapshotFilename(filename: string): string {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]+\.ts$/.test(filename)
  ) {
    throw new RequestValidationError("snapshotFilename must be a local snapshot .ts file");
  }
  return filename;
}

export function parseFetchEmailsRequest(input: unknown): FetchOptions {
  const body = asRecord(input);
  const scope = body["scope"] === "all" ? "all" : "unread";

  return {
    scope,
    maxResults: parseMaxResults(body["maxResults"]),
    accountEmail: optionalPresentString(body["accountEmail"], "accountEmail"),
  };
}

export function parseEmailListQuery(params: URLSearchParams) {
  return {
    unreadOnly: params.get("unreadOnly") === "true",
    limit: parseIntegerParam(params, "limit", 50, 1, 500),
    offset: parseIntegerParam(params, "offset", 0, 0, 100000),
    accountId: optionalPresentString(
      params.has("accountId") ? params.get("accountId") : undefined,
      "accountId",
    ),
  };
}

export function parseActionGenerateRequest(input: unknown): GenerateRequest {
  const body = asRecord(input);
  const mode = body["mode"];
  if (mode !== "create" && mode !== "edit") {
    throw new RequestValidationError("mode must be create or edit");
  }
  if (!Array.isArray(body["messages"]) || body["messages"].length === 0) {
    throw new RequestValidationError("messages are required");
  }

  const messages: ChatMessage[] = body["messages"].map((message, index) => {
    const record = asRecord(message);
    const role = record["role"];
    if (role !== "user" && role !== "assistant") {
      throw new RequestValidationError(`messages[${index}].role must be user or assistant`);
    }
    const messageRole: ChatMessage["role"] = role;
    return {
      role: messageRole,
      content: requiredString(record["content"], `messages[${index}].content`),
    };
  });

  return {
    mode,
    messages,
    currentCode: optionalString(body["currentCode"], "currentCode"),
  };
}

export function parseActionRunRequest(input: unknown): ActionRunRequest {
  const body = asRecord(input);
  return {
    actionId: requiredString(body["actionId"], "actionId"),
    accountEmail: optionalPresentString(body["accountEmail"], "accountEmail"),
  };
}

export function parseAccountPostRequest(input: unknown): AccountPostRequest {
  const body = asRecord(input);
  if (body["action"] === "add") {
    return { action: "add" };
  }
  if (body["action"] === "setDefault") {
    return {
      action: "setDefault",
      email: requiredString(body["email"], "email"),
    };
  }
  throw new RequestValidationError("action must be add or setDefault");
}

export function parseAccountDeleteRequest(input: unknown): AccountDeleteRequest {
  const body = asRecord(input);
  return {
    email: requiredString(body["email"], "email"),
  };
}

export function parseEmailReadStatusRequest(input: unknown): EmailReadStatusRequest {
  const body = asRecord(input);
  const isUnread = optionalBoolean(body["isUnread"], "isUnread");
  if (isUnread === undefined) {
    throw new RequestValidationError("isUnread is required");
  }
  return { isUnread };
}

export function parseEmailIdRequest(input: unknown): EmailIdRequest {
  const body = asRecord(input);
  return {
    emailId: requiredString(body["emailId"], "emailId"),
    accountId: requiredPresentString(body["accountId"], "accountId"),
  };
}

export function parseEmailIdentityQuery(params: URLSearchParams): { accountId: string } {
  return {
    accountId: requiredPresentString(
      params.has("accountId") ? params.get("accountId") : undefined,
      "accountId",
    ),
  };
}

export function parseUserActionSaveRequest(input: unknown): UserActionSaveRequest {
  const body = asRecord(input);
  return {
    filename: validateActionFilename(requiredString(body["filename"], "filename")),
    content: requiredString(body["content"], "content"),
  };
}

export function parseUserActionDeleteRequest(input: unknown): UserActionDeleteRequest {
  const body = asRecord(input);
  return {
    filename: validateActionFilename(requiredString(body["filename"], "filename")),
  };
}

export function parseSnapshotRestoreRequest(input: unknown): SnapshotRestoreRequest {
  const body = asRecord(input);
  return {
    snapshotFilename: validateSnapshotFilename(requiredString(body["snapshotFilename"], "snapshotFilename")),
    originalFilename: validateActionFilename(requiredString(body["originalFilename"], "originalFilename")),
  };
}

/** One approval request cannot reasonably target more rows than this. */
const MAX_APPROVAL_IDS = 1000;

export function parseApprovalIdsRequest(input: unknown): { ids: string[] } {
  const body = asRecord(input);
  if (!Array.isArray(body["ids"]) || body["ids"].length === 0) {
    throw new RequestValidationError("ids array is required");
  }
  if (body["ids"].length > MAX_APPROVAL_IDS) {
    throw new RequestValidationError(
      `ids may not contain more than ${MAX_APPROVAL_IDS} entries`,
    );
  }

  const ids = body["ids"].map((id, index) => {
    const trimmed = requiredString(id, `ids[${index}]`).trim();
    // A blank id would widen the generated `id IN (...)` filter, so reject it.
    if (trimmed.length === 0) {
      throw new RequestValidationError(`ids[${index}] must not be blank`);
    }
    return trimmed;
  });
  // Duplicates would resolve the same row twice; collapse them here.
  return { ids: [...new Set(ids)] };
}

export function parseSettingsUpdateRequest(input: unknown): SettingsUpdate {
  const body = asRecord(input);
  for (const key of Object.keys(body)) {
    if (!SETTING_KEYS.has(key)) {
      throw new RequestValidationError(`Unknown setting: ${key}`);
    }
  }

  const settings: SettingsUpdate = {};

  if (body["agentMode"] !== undefined) {
    if (
      body["agentMode"] !== "all-agents" &&
      body["agentMode"] !== "hybrid" &&
      body["agentMode"] !== "direct-api"
    ) {
      throw new RequestValidationError("agentMode is invalid");
    }
    settings.agentMode = body["agentMode"];
  }

  if (body["preferredAgent"] !== undefined) {
    if (
      body["preferredAgent"] !== "claude" &&
      body["preferredAgent"] !== "codex" &&
      body["preferredAgent"] !== "gemini" &&
      body["preferredAgent"] !== "openrouter" &&
      body["preferredAgent"] !== "claude-sdk" &&
      body["preferredAgent"] !== "direct-api"
    ) {
      throw new RequestValidationError("preferredAgent is invalid");
    }
    settings.preferredAgent = body["preferredAgent"];
  }

  if (body["gmail"] !== undefined) {
    const gmail = asRecord(body["gmail"]);
    const update: Partial<AppConfig["gmail"]> = {};
    if ("autoApplyAcknowledged" in gmail) {
      update.autoApplyAcknowledged =
        optionalBoolean(gmail["autoApplyAcknowledged"], "gmail.autoApplyAcknowledged") ?? false;
    }
    if ("autoApplyActions" in gmail) {
      update.autoApplyActions =
        optionalBoolean(gmail["autoApplyActions"], "gmail.autoApplyActions") ?? false;
    }
    settings.gmail = update;
  }

  if (body["dataDir"] !== undefined) {
    settings.dataDir = requiredString(body["dataDir"], "dataDir");
  }

  if (body["gcp"] !== undefined) {
    const gcp = asRecord(body["gcp"]);
    const update: Partial<AppConfig["gcp"]> = {};
    if ("projectId" in gcp) update.projectId = optionalString(gcp["projectId"], "gcp.projectId") ?? "";
    settings.gcp = update;
  }

  if (body["prompts"] !== undefined) {
    const prompts = asRecord(body["prompts"]);
    const update: Partial<AppConfig["prompts"]> = {};
    if ("summary" in prompts) update.summary = optionalString(prompts["summary"], "prompts.summary") ?? "";
    if ("digest" in prompts) update.digest = optionalString(prompts["digest"], "prompts.digest") ?? "";
    settings.prompts = update;
  }

  if (body["embedding"] !== undefined) {
    const embedding = asRecord(body["embedding"]);
    const update: Partial<AppConfig["embedding"]> = {};
    if ("provider" in embedding) {
      const provider = embedding["provider"];
      if (provider !== "openai" && provider !== "openrouter" && provider !== "local") {
        throw new RequestValidationError("embedding.provider is invalid");
      }
      update.provider = provider;
    }
    if ("model" in embedding) {
      update.model = optionalString(embedding["model"], "embedding.model") ?? "";
    }
    if ("dimensions" in embedding) {
      optionalNumber(embedding["dimensions"], "embedding.dimensions");
      update.dimensions = defaultConfig.embedding.dimensions;
    }
    settings.embedding = update;
  }

  if (body["ui"] !== undefined) {
    const ui = asRecord(body["ui"]);
    const update: Partial<AppConfig["ui"]> = {};
    if ("fetchScope" in ui) {
      const fetchScope = ui["fetchScope"];
      if (fetchScope !== "unread" && fetchScope !== "all") {
        throw new RequestValidationError("ui.fetchScope is invalid");
      }
      update.fetchScope = fetchScope;
    }
    if ("fetchInterval" in ui) {
      update.fetchInterval = optionalNumber(ui["fetchInterval"], "ui.fetchInterval") ?? 0;
    }
    settings.ui = update;
  }

  if (body["accounts"] !== undefined) {
    if (!Array.isArray(body["accounts"])) {
      throw new RequestValidationError("accounts must be an array");
    }
    settings.accounts = body["accounts"].map((account, index) => {
      const record = asRecord(account);
      return {
        email: requiredString(record["email"], `accounts[${index}].email`),
        name: optionalString(record["name"], `accounts[${index}].name`),
        isDefault: optionalBoolean(record["isDefault"], `accounts[${index}].isDefault`),
      };
    });
  }

  if (body["oauth"] !== undefined) {
    const oauth = asRecord(body["oauth"]);
    settings.oauth = {
      clientId: requiredString(oauth["clientId"], "oauth.clientId"),
      clientSecret: requiredString(oauth["clientSecret"], "oauth.clientSecret"),
    };
  }

  return settings;
}

export function mergeSettingsUpdate(
  current: AppConfig,
  update: SettingsUpdate,
): AppConfig {
  return {
    ...current,
    ...update,
    gcp: { ...current.gcp, ...update.gcp },
    prompts: { ...current.prompts, ...update.prompts },
    embedding: {
      ...current.embedding,
      ...update.embedding,
      dimensions: defaultConfig.embedding.dimensions,
    },
    gmail: normalizeGmailConfig({ ...current.gmail, ...update.gmail }),
    ui: normalizeUiConfig({ ...current.ui, ...update.ui }),
    // Accounts are owned by the dedicated /api/accounts endpoints; a settings
    // PUT must never mutate them, or a stale client snapshot resurrects a
    // removed account. Ignore any accounts key in the update.
    accounts: current.accounts,
    oauth: update.oauth ?? current.oauth,
  };
}

export function validationResponse(error: unknown): Response | undefined {
  if (error instanceof RequestValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  return undefined;
}

export function mutationGuardResponse(request: Request): Response | undefined {
  const url = new URL(request.url);

  if (
    process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] !== "1" &&
    !LOCAL_HOSTS.has(url.hostname)
  ) {
    return Response.json({ error: "Mutation requests must use the local Email Agent origin" }, { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return Response.json({ error: "Cross-origin mutation requests are not allowed" }, { status: 403 });
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    return Response.json({ error: "Cross-site mutation requests are not allowed" }, { status: 403 });
  }

  return undefined;
}

export function sanitizeSettingsForResponse(settings: AppConfig): SanitizedSettings {
  return {
    agentMode: settings.agentMode,
    preferredAgent: settings.preferredAgent,
    gcp: settings.gcp,
    embedding: {
      ...settings.embedding,
      dimensions: defaultConfig.embedding.dimensions,
    },
    gmail: normalizeGmailConfig(settings.gmail),
    prompts: settings.prompts,
    ui: normalizeUiConfig(settings.ui),
    dataDir: settings.dataDir,
    accounts: settings.accounts,
  };
}

/**
 * Mirrors the core `normalizeSettings` invariant at the API boundary: enabling
 * auto-apply requires a recorded acknowledgement of its warnings, so a client
 * can never flip the toggle alone (and revoking consent disables it again).
 */
function normalizeGmailConfig(
  gmail: Partial<AppConfig["gmail"]> | undefined,
): AppConfig["gmail"] {
  const autoApplyAcknowledged = gmail?.autoApplyAcknowledged === true;
  return {
    autoApplyActions: autoApplyAcknowledged && gmail?.autoApplyActions === true,
    autoApplyAcknowledged,
  };
}

function normalizeUiConfig(ui: AppConfig["ui"]): AppConfig["ui"] {
  return {
    fetchInterval: ui.fetchInterval,
    fetchScope: ui.fetchScope,
  };
}

export function internalErrorResponse(
  error: unknown,
  message = "Internal server error",
): Response {
  console.error(error);
  return Response.json({ error: message }, { status: 500 });
}
