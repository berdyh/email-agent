import { defaultConfig, type AppConfig } from "@email-agent/core/config";
import type { FetchOptions } from "@email-agent/core/gmail";
import type { GmailOperation } from "@email-agent/core/actions";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SETTING_KEYS = new Set([
  "agentMode",
  "preferredAgent",
  "gcp",
  "notifications",
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
    "gcp" | "notifications" | "prompts" | "embedding" | "gmail" | "ui" | "accounts" | "oauth"
  >
> & {
  gcp?: Partial<AppConfig["gcp"]>;
  notifications?: {
    desktop?: Partial<AppConfig["notifications"]["desktop"]>;
    webhooks?: AppConfig["notifications"]["webhooks"];
  };
  prompts?: Partial<AppConfig["prompts"]>;
  embedding?: Partial<AppConfig["embedding"]>;
  gmail?: Partial<AppConfig["gmail"]>;
  ui?: Partial<AppConfig["ui"]>;
  accounts?: AppConfig["accounts"];
  oauth?: AppConfig["oauth"];
};

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

export function parseApplyActionsRequest(input: unknown): {
  operations: GmailOperation[];
  accountEmail?: string;
} {
  const body = asRecord(input);
  if (!Array.isArray(body["operations"]) || body["operations"].length === 0) {
    throw new RequestValidationError("operations array is required");
  }

  const operations: GmailOperation[] = body["operations"].map((operation, index) => {
    const record = asRecord(operation);
    const emailId = requiredString(record["emailId"], `operations[${index}].emailId`);
    const type = record["type"];
    if (
      type !== "trash" &&
      type !== "spam" &&
      type !== "markRead" &&
      type !== "markUnread" &&
      type !== "addLabels" &&
      type !== "removeLabels"
    ) {
      throw new RequestValidationError(`operations[${index}].type is invalid`);
    }

    const labels = record["labelIds"];
    if ((type === "addLabels" || type === "removeLabels") && (!Array.isArray(labels) || labels.some((label) => typeof label !== "string"))) {
      throw new RequestValidationError(`operations[${index}].labelIds must be a string array`);
    }
    const operationType: GmailOperation["type"] = type;

    return {
      emailId,
      type: operationType,
      labelIds: Array.isArray(labels) ? labels as string[] : undefined,
      accountEmail: optionalPresentString(
        record["accountEmail"],
        `operations[${index}].accountEmail`,
      ),
    };
  });

  return {
    operations,
    accountEmail: optionalPresentString(body["accountEmail"], "accountEmail"),
  };
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
      body["preferredAgent"] !== "claude-sdk"
    ) {
      throw new RequestValidationError("preferredAgent is invalid");
    }
    settings.preferredAgent = body["preferredAgent"];
  }

  if (body["gmail"] !== undefined) {
    const gmail = asRecord(body["gmail"]);
    const update: Partial<AppConfig["gmail"]> = {};
    if ("syncActions" in gmail) {
      update.syncActions = optionalBoolean(gmail["syncActions"], "gmail.syncActions") ?? false;
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
    if ("pubsubTopic" in gcp) update.pubsubTopic = optionalString(gcp["pubsubTopic"], "gcp.pubsubTopic") ?? "";
    if ("pubsubSubscription" in gcp) {
      update.pubsubSubscription = optionalString(gcp["pubsubSubscription"], "gcp.pubsubSubscription") ?? "";
    }
    if ("watchExpiration" in gcp) {
      update.watchExpiration = optionalString(gcp["watchExpiration"], "gcp.watchExpiration");
    }
    settings.gcp = update;
  }

  if (body["prompts"] !== undefined) {
    const prompts = asRecord(body["prompts"]);
    const update: Partial<AppConfig["prompts"]> = {};
    if ("summary" in prompts) update.summary = optionalString(prompts["summary"], "prompts.summary") ?? "";
    if ("priority" in prompts) update.priority = optionalString(prompts["priority"], "prompts.priority") ?? "";
    if ("clustering" in prompts) update.clustering = optionalString(prompts["clustering"], "prompts.clustering") ?? "";
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
    if ("theme" in ui) {
      const theme = ui["theme"];
      if (theme !== "light" && theme !== "dark" && theme !== "system") {
        throw new RequestValidationError("ui.theme is invalid");
      }
      update.theme = theme;
    }
    if ("fetchScope" in ui) {
      const fetchScope = ui["fetchScope"];
      if (fetchScope !== "unread" && fetchScope !== "all") {
        throw new RequestValidationError("ui.fetchScope is invalid");
      }
      update.fetchScope = fetchScope;
    }
    if ("sidebarCollapsed" in ui) {
      update.sidebarCollapsed = optionalBoolean(ui["sidebarCollapsed"], "ui.sidebarCollapsed") ?? false;
    }
    if ("fetchInterval" in ui) {
      update.fetchInterval = optionalNumber(ui["fetchInterval"], "ui.fetchInterval") ?? 0;
    }
    settings.ui = update;
  }

  if (body["notifications"] !== undefined) {
    const notifications = asRecord(body["notifications"]);
    const update: NonNullable<SettingsUpdate["notifications"]> = {};
    if ("desktop" in notifications) {
      const desktop = asRecord(notifications["desktop"]);
      update.desktop = {};
      if ("enabled" in desktop) {
        update.desktop.enabled = optionalBoolean(desktop["enabled"], "notifications.desktop.enabled") ?? false;
      }
      if ("priorityOnly" in desktop) {
        update.desktop.priorityOnly = optionalBoolean(desktop["priorityOnly"], "notifications.desktop.priorityOnly") ?? false;
      }
    }
    if ("webhooks" in notifications) {
      const webhooksValue = notifications["webhooks"];
      if (webhooksValue === null) {
        update.webhooks = [];
      } else if (!Array.isArray(webhooksValue)) {
        throw new RequestValidationError("notifications.webhooks must be an array");
      } else {
        update.webhooks = webhooksValue.map((webhook, index) => {
          const record = asRecord(webhook);
          const type = record["type"];
          if (type !== "slack" && type !== "discord" && type !== "generic") {
            throw new RequestValidationError(`notifications.webhooks[${index}].type is invalid`);
          }
          return {
            name: requiredString(record["name"], `notifications.webhooks[${index}].name`),
            url: requiredString(record["url"], `notifications.webhooks[${index}].url`),
            type,
            enabled: optionalBoolean(record["enabled"], `notifications.webhooks[${index}].enabled`) ?? false,
          };
        });
      }
    }
    settings.notifications = update;
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
    notifications: {
      desktop: {
        ...current.notifications.desktop,
        ...update.notifications?.desktop,
      },
      webhooks: update.notifications?.webhooks ?? normalizeWebhooks(current.notifications.webhooks),
    },
    prompts: { ...current.prompts, ...update.prompts },
    embedding: {
      ...current.embedding,
      ...update.embedding,
      dimensions: defaultConfig.embedding.dimensions,
    },
    gmail: { ...current.gmail, ...update.gmail },
    ui: normalizeUiConfig({ ...current.ui, ...update.ui }),
    accounts: update.accounts ?? current.accounts,
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

export function sanitizeSettingsForResponse(settings: AppConfig): Omit<AppConfig, "oauth"> {
  return {
    agentMode: settings.agentMode,
    preferredAgent: settings.preferredAgent,
    gcp: settings.gcp,
    embedding: {
      ...settings.embedding,
      dimensions: defaultConfig.embedding.dimensions,
    },
    gmail: settings.gmail,
    notifications: {
      desktop: settings.notifications.desktop,
      webhooks: normalizeWebhooks(settings.notifications.webhooks),
    },
    prompts: settings.prompts,
    ui: normalizeUiConfig(settings.ui),
    dataDir: settings.dataDir,
    accounts: settings.accounts,
  };
}

function normalizeUiConfig(ui: AppConfig["ui"]): AppConfig["ui"] {
  return {
    theme: ui.theme,
    sidebarCollapsed: ui.sidebarCollapsed,
    fetchInterval: ui.fetchInterval,
    fetchScope: ui.fetchScope,
  };
}

function normalizeWebhooks(
  webhooks: AppConfig["notifications"]["webhooks"] | null | undefined,
): AppConfig["notifications"]["webhooks"] {
  return Array.isArray(webhooks) ? webhooks : [];
}

export function internalErrorResponse(
  error: unknown,
  message = "Internal server error",
): Response {
  console.error(error);
  return Response.json({ error: message }, { status: 500 });
}
