import {
  defaultConfig,
  normalizeAutoApplyConsent,
  type AppConfig,
} from "@email-agent/core/config";
import type { FetchOptions } from "@email-agent/core/gmail";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SETTING_KEYS = new Set([
  "agentMode",
  "preferredAgent",
  "gcp",
  "prompts",
  "embedding",
  "gmail",
  "ui",
  "retention",
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
    | "gcp"
    | "prompts"
    | "embedding"
    | "gmail"
    | "ui"
    | "retention"
    | "accounts"
    | "oauth"
  >
> & {
  gcp?: Partial<AppConfig["gcp"]>;
  prompts?: Partial<AppConfig["prompts"]>;
  embedding?: Partial<AppConfig["embedding"]>;
  gmail?: Partial<AppConfig["gmail"]>;
  ui?: Partial<AppConfig["ui"]>;
  retention?: Partial<NonNullable<AppConfig["retention"]>>;
  accounts?: AppConfig["accounts"];
  oauth?: AppConfig["oauth"];
};

/**
 * Settings shape returned to clients: the full runtime config minus secrets.
 * Shared with web hooks so consumers get a real type instead of
 * `Record<string, unknown>`.
 *
 * `retention` is required here even though it is optional on `AppConfig`:
 * `sanitizeSettingsForResponse` always fills it in, because a settings page
 * that cannot see the window silently deletes audit rows on a schedule the user
 * never chose. It was omitted from this response for exactly that reason once.
 */
export type SanitizedSettings = Omit<AppConfig, "oauth" | "retention"> & {
  retention: NonNullable<AppConfig["retention"]>;
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

/**
 * A user's judgement about rows a crash left mid-apply.
 *
 * The decision is a closed set of exactly two answers, and it is required —
 * there is no default, because both of them assert something about the user's
 * mailbox that only they can know. Anything else is a 400 rather than a guess.
 */
export function parseStrandedResolutionRequest(
  input: unknown,
): { ids: string[]; decision: "applied" | "notApplied" } {
  const body = asRecord(input);
  const { ids } = parseApprovalIdsRequest(input);
  const decision = body["decision"];
  if (decision !== "applied" && decision !== "notApplied") {
    throw new RequestValidationError("decision must be applied or notApplied");
  }
  return { ids, decision };
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

  if (body["retention"] !== undefined) {
    const retention = asRecord(body["retention"]);
    const update: Partial<NonNullable<AppConfig["retention"]>> = {};
    if ("approvalQueueDays" in retention) {
      const days = optionalNumber(
        retention["approvalQueueDays"],
        "retention.approvalQueueDays",
      );
      if (days === undefined) {
        throw new RequestValidationError("retention.approvalQueueDays is required");
      }
      // Whole days only, and bounded. The upper bound is generous rather than
      // meaningful; what it actually prevents is a value so large that a
      // `new Date(now - days * 86400000)` cutoff stops being a valid date and
      // the sweep silently becomes a no-op the user believes is a window.
      if (!Number.isInteger(days) || days < 0 || days > 36500) {
        throw new RequestValidationError(
          "retention.approvalQueueDays must be a whole number of days between 0 and 36500",
        );
      }
      update.approvalQueueDays = days;
    }
    settings.retention = update;
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
    retention: normalizeRetentionConfig({ ...current.retention, ...update.retention }),
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

interface RequestAuthority {
  /** Lower-cased, brackets stripped from IPv6 — comparable against LOCAL_HOSTS. */
  hostname: string;
  /** Always explicit; the scheme default is filled in. */
  port: string;
}

function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  return lowered.startsWith("[") && lowered.endsWith("]")
    ? lowered.slice(1, -1)
    : lowered;
}

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(normalizeHostname(hostname));
}

function explicitPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * The authority the caller actually addressed, taken from the `Host` header.
 *
 * NOT from `request.url`. Installed Next builds `NextRequest.url` from the
 * hostname the server process was configured with, never from the request —
 * `attachRequestMeta` in `next/dist/server/next-server.js` composes
 * `${protocol}://${this.fetchHostname}:${this.port}${req.url}`, and the render
 * server defaults that hostname to `localhost`. Measured against this app:
 * under both `next dev --hostname 127.0.0.1` and `next start --hostname
 * 127.0.0.1`, `new URL(request.url).origin` is `http://localhost:<port>` for
 * every request, whatever `Host` arrived. Deriving "is this local?" from it
 * therefore did two wrong things at once: it refused the browser that opened
 * the `http://127.0.0.1:3847` URL Next itself prints (every mutation 403'd),
 * and it never saw a DNS-rebound `Host: evil.example` at all, so the
 * anti-rebinding property the guard claimed did not exist.
 *
 * `X-Forwarded-Host` is deliberately NOT consulted. It is not a forbidden
 * header name, so a rebound page — which is same-origin with itself and can set
 * whatever it likes — could send `X-Forwarded-Host: localhost:3847` and walk
 * back through the allowlist. There is no reverse proxy in front of this app.
 */
function requestAuthority(request: Request): RequestAuthority | undefined {
  const header = request.headers.get("host")?.trim();
  let source = header;
  if (!source) {
    try {
      source = new URL(request.url).host;
    } catch {
      return undefined;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${source}`);
  } catch {
    return undefined;
  }
  // `new URL` happily swallows a path, credentials or a query in the authority
  // position; none of those belong in a Host header, so treat them as junk.
  if (
    !parsed.hostname ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }

  return { hostname: parsed.hostname, port: explicitPort(parsed) };
}

/**
 * Is this `Origin` one of the addresses that legitimately reach this server?
 *
 * `localhost:3847` and `127.0.0.1:3847` are the same server and both are
 * printed to the user, so both must pass — but a *different* local app on
 * `localhost:8080` must not, which is what makes this a CSRF check rather than
 * a formality. Hence: local hostname, and the same port the caller addressed.
 */
function isAllowedOrigin(origin: string, authority: RequestAuthority): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Includes the literal `Origin: null` an opaque/sandboxed context sends.
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isLocalHostname(parsed.hostname)) return false;
  return explicitPort(parsed) === authority.port;
}

/**
 * Header-level checks shared by the mutation and read guards.
 *
 * IMPORTANT — what this is and is not. Every input here is a request header,
 * and a non-browser client controls all of them: `Host`, `Origin`, and
 * `Sec-Fetch-*`. This function is therefore NOT the security boundary. It buys
 * exactly two things, and only against browsers:
 *
 *  1. **Anti DNS-rebinding.** A page on `evil.com` that rebinds its name to
 *     127.0.0.1 still makes the browser send `Host: evil.com`, so the host
 *     allowlist refuses it. This only works because the check reads the `Host`
 *     header itself — see `requestAuthority`.
 *  2. **Anti CSRF.** Browsers always attach `Origin`/`Sec-Fetch-Site` to
 *     cross-origin fetches, so a hostile page — including one on another
 *     localhost port — cannot ride the user's session.
 *
 * The boundary that a header genuinely cannot defeat is the listener binding:
 * `email-agent serve` binds the dev server to loopback unless
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`, so an off-box process cannot open the
 * socket at all, no matter what `Host` it would have sent. A process on this
 * machine running as this user is out of scope for both — it can read the
 * OAuth tokens off disk and skip the app entirely.
 */
function localRequestViolation(
  request: Request,
  kind: "Mutation" | "Read",
): Response | undefined {
  // The documented "I meant to expose this" switch. It turns every header check
  // off rather than a subset: the checks all assume a loopback-only deployment,
  // and leaving the origin comparison on while the bind is open is how the LAN
  // browser used to get a 403 from a server it was allowed to reach.
  if (process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] === "1") return undefined;

  const authority = requestAuthority(request);
  if (!authority || !isLocalHostname(authority.hostname)) {
    return Response.json(
      { error: `${kind} requests must use the local Email Agent origin` },
      { status: 403 },
    );
  }

  const origin = request.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(origin, authority)) {
    return Response.json(
      { error: `Cross-origin ${kind.toLowerCase()} requests are not allowed` },
      { status: 403 },
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    return Response.json(
      { error: `Cross-site ${kind.toLowerCase()} requests are not allowed` },
      { status: 403 },
    );
  }

  return undefined;
}

export function mutationGuardResponse(request: Request): Response | undefined {
  const violation = localRequestViolation(request, "Mutation");
  if (violation) return violation;

  // Require the fetch metadata rather than only validating it when present.
  // This is safe because it accepts EITHER header: `Origin` is sent by every
  // browser on every non-GET fetch and has been for far longer than Fetch
  // Metadata, which Chrome/Edge shipped in 2020, Firefox in 90 (2021) and
  // Safari only in 16.4 (2023). So a real UI mutation always carries at least
  // one of the two, while the `curl -X POST -H 'Host: localhost' …` one-liner
  // that used to satisfy the whole guard now fails. Honest framing: an attacker
  // who adds the header still gets through. This is a speed bump, not the
  // boundary; the boundary is the loopback bind (see `localRequestViolation`).
  if (
    process.env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] !== "1" &&
    !request.headers.get("origin") &&
    !request.headers.get("sec-fetch-site")
  ) {
    return Response.json(
      {
        error:
          "Mutation requests must come from the Email Agent UI (missing Origin/Sec-Fetch-Site)",
      },
      { status: 403 },
    );
  }

  return undefined;
}

/**
 * Guard for read routes that return mail content (subjects, senders, snippets)
 * rather than just a count. `GET /api/approvals` had no guard at all, so any
 * page the user visited could read the whole approval queue cross-origin.
 *
 * Unlike the mutation guard this does NOT require the fetch metadata: a user
 * typing the URL into the address bar sends `Sec-Fetch-Site: none` (fine), but
 * `curl` sends nothing, and refusing that would break local debugging for no
 * security gain — reads are already reachable by anything that can open the
 * socket.
 */
export function readGuardResponse(request: Request): Response | undefined {
  return localRequestViolation(request, "Read");
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
    // Always present in the response. This used to be omitted, so the Settings
    // page could not show that resolved approval-queue rows — the audit trail
    // of real Gmail mutations — are deleted after a window the user never saw.
    retention: normalizeRetentionConfig(settings.retention),
    dataDir: settings.dataDir,
    accounts: settings.accounts,
  };
}

/**
 * The consent invariant at the API boundary: enabling auto-apply requires a
 * recorded acknowledgement of its warnings, so a client can never flip the
 * toggle alone (and revoking consent disables it again).
 *
 * ENFORCED TWICE, IMPLEMENTED ONCE. Keeping the second enforcement point is
 * deliberate defense in depth — a settings PUT that somehow bypassed core's
 * `normalizeSettings` must still not be able to arm unattended Gmail writes.
 * What must not exist is a second IMPLEMENTATION, and until now this was one:
 * a hand-written copy of `normalizeAutoApplyConsent`'s body with the same
 * signature. Two copies of a consent rule is the shape that drifts, and the
 * direction it drifts in is "the toggle is honoured without the
 * acknowledgement". It is a call now.
 */
function normalizeGmailConfig(
  gmail: Partial<AppConfig["gmail"]> | undefined,
): AppConfig["gmail"] {
  return normalizeAutoApplyConsent(gmail);
}

/**
 * Fills in the retention window so every response carries one.
 *
 * Falls back to the built-in default rather than to 0. The two are not
 * interchangeable and the difference is destructive in the direction that
 * matters least obviously: 0 means "never prune", so defaulting to it would
 * quietly promise a user with no `retention` block that their audit rows are
 * kept forever, while `loadSettings` in core hands the sweep the 365-day
 * default and deletes them.
 */
function normalizeRetentionConfig(
  retention: Partial<NonNullable<AppConfig["retention"]>> | undefined,
): NonNullable<AppConfig["retention"]> {
  const days = retention?.approvalQueueDays;
  return {
    approvalQueueDays:
      typeof days === "number" && Number.isFinite(days)
        ? days
        : (defaultConfig.retention?.approvalQueueDays ?? 0),
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
