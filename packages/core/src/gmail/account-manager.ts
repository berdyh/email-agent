import { google, type gmail_v1 } from "googleapis";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AccountConfig } from "../config/types.js";
import type { OAuthCredentials, StoredTokens } from "./account-types.js";
import { resetGmailClient } from "./client.js";

const BASE_DIR = join(homedir(), ".email-agent");
const OAUTH_PATH = join(BASE_DIR, "oauth.json");
const ACCOUNTS_DIR = join(BASE_DIR, "accounts");

function safeAccountDir(email: string): string {
  const dir = resolve(ACCOUNTS_DIR, email);
  if (!dir.startsWith(ACCOUNTS_DIR + "/")) {
    throw new Error(`Invalid account email: path traversal detected`);
  }
  return dir;
}

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "openid",
  "email",
  "profile",
];

function tokenPath(email: string): string {
  return join(safeAccountDir(email), "token.json");
}

// --- OAuth Credentials ---

export async function getOAuthCredentials(): Promise<OAuthCredentials | null> {
  try {
    const raw = await readFile(OAUTH_PATH, "utf-8");
    return JSON.parse(raw) as OAuthCredentials;
  } catch {
    return null;
  }
}

// --- Token Storage ---

export async function getStoredTokens(email: string): Promise<StoredTokens | null> {
  try {
    const raw = await readFile(tokenPath(email), "utf-8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(email: string, tokens: StoredTokens): Promise<void> {
  const dir = safeAccountDir(email);
  await mkdir(dir, { recursive: true });
  await writeFile(tokenPath(email), JSON.stringify(tokens, null, 2));
}

// --- OAuth2 Flow ---

export function generateAuthUrl(
  creds: OAuthCredentials,
  redirectUri: string,
  state?: string,
): string {
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
    state,
  });
}

export async function exchangeCode(
  creds: OAuthCredentials,
  code: string,
  redirectUri: string,
): Promise<{ email: string; tokens: StoredTokens }> {
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("OAuth2 exchange did not return required tokens");
  }

  const stored: StoredTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ?? Date.now() + 3600_000,
    scope: tokens.scope ?? OAUTH_SCOPES.join(" "),
  };

  // Get the user's email from the token
  oauth2.setCredentials(tokens);
  const oauth2Client = google.oauth2({ version: "v2", auth: oauth2 });
  const userInfo = await oauth2Client.userinfo.get();
  const email = userInfo.data.email;
  if (!email) throw new Error("Could not determine email from OAuth2 response");

  await saveTokens(email, stored);
  return { email, tokens: stored };
}

async function refreshAccessToken(
  creds: OAuthCredentials,
  email: string,
  stored: StoredTokens,
): Promise<StoredTokens> {
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();

  const updated: StoredTokens = {
    accessToken: credentials.access_token ?? stored.accessToken,
    refreshToken: credentials.refresh_token ?? stored.refreshToken,
    expiresAt: credentials.expiry_date ?? Date.now() + 3600_000,
    scope: stored.scope,
  };

  await saveTokens(email, updated);
  return updated;
}

// --- Account CRUD ---

/**
 * NO try/catch, and no `?? []`, DELIBERATELY.
 *
 * `loadSettings()` already owns the whole "what does an unusable settings file
 * mean?" policy, and it is the only place that may: ENOENT alone means "first
 * run", and it answers with defaults whose `accounts` is `[]`. Every other
 * errno, and a file that exists but does not parse, THROW — see
 * `readSettingsBytes` / `loadSettingsFromPath` in `config/settings.ts`.
 *
 * Swallowing that throw here turned "I cannot read your configuration" into
 * "you have no accounts configured", and an empty account list is not an absence
 * of information — it is a MAILBOX DECISION. `getDefaultAccount()` below answers
 * `null` for it, and `gmail/client.ts` turns that `null` into the gcloud ADC
 * branch of `createGmailClient()` and into `""` from `resolveAccountEmail()`.
 * Since `syncEmails()` uses that same resolved value both as the fetch identity
 * AND as the `accountId` it stores, a momentarily unreadable settings.json
 * silently moved a whole fetch — and every row it wrote — onto whatever mailbox
 * ADC happens to be signed in as, under the legacy `accountId: ""` sentinel.
 *
 * A narrowed `catch (err) { if (err.code !== "ENOENT") throw; return []; }` is
 * not the fix either: it would be a second copy of a policy `loadSettings`
 * already implements, and it could not work anyway — the non-ENOENT failures are
 * re-thrown as plain `Error`s with the errno interpolated into the MESSAGE, so
 * there is no `.code` for such a guard to test.
 *
 * `AppConfig.accounts` is a required `AccountConfig[]` and `normalizeSettings()`
 * always produces an array, so `?? []` was unreachable — the same fail-open
 * reflex in miniature.
 *
 * Callers already handle the throw: CLI `accounts list` prints the error text
 * and exits 1, and `GET /api/accounts` answers 500.
 */
export async function listAccounts(): Promise<AccountConfig[]> {
  const { loadSettings } = await import("../config/settings.js");
  const settings = await loadSettings();
  return settings.accounts;
}

export function upsertAccountEntry(
  accounts: readonly AccountConfig[],
  account: AccountConfig,
): AccountConfig[] {
  const existing = accounts.find((a) => a.email === account.email);
  // Re-adding (re-authing) an existing account must not silently demote it
  // from default — preserve its isDefault unless the new entry claims it.
  const merged: AccountConfig = {
    ...account,
    isDefault: account.isDefault === true || existing?.isDefault === true,
  };

  const next = existing
    ? accounts.map((a) => (a.email === account.email ? merged : { ...a }))
    : [...accounts.map((a) => ({ ...a })), merged];

  // If this is the first account or marked default, clear other defaults
  if (merged.isDefault || next.length === 1) {
    for (const a of next) {
      a.isDefault = a.email === account.email;
    }
  }

  return next;
}

export async function addAccount(account: AccountConfig): Promise<void> {
  const { loadSettings, saveSettings } = await import("../config/settings.js");
  const settings = await loadSettings();
  const accounts = upsertAccountEntry(settings.accounts, account);
  await saveSettings({ ...settings, accounts });
}

export async function removeAccount(email: string): Promise<void> {
  const { loadSettings, saveSettings } = await import("../config/settings.js");
  const settings = await loadSettings();
  const accounts = settings.accounts.filter((a) => a.email !== email);

  // If we removed the default, make the first remaining account default
  if (accounts.length > 0 && !accounts.some((a) => a.isDefault)) {
    accounts[0]!.isDefault = true;
  }

  await saveSettings({ ...settings, accounts });
  resetGmailClient();

  // Clean up stored tokens
  try {
    await rm(safeAccountDir(email), { recursive: true });
  } catch {
    // Token dir may not exist
  }
}

export async function getDefaultAccount(): Promise<AccountConfig | null> {
  const accounts = await listAccounts();
  return accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
}

export async function setDefaultAccount(email: string): Promise<void> {
  const { loadSettings, saveSettings } = await import("../config/settings.js");
  const settings = await loadSettings();
  const accounts = [...settings.accounts];

  for (const a of accounts) {
    a.isDefault = a.email === email;
  }

  await saveSettings({ ...settings, accounts });
  resetGmailClient();
}

// --- Gmail Client Creation ---

export function requireAccountAuth(
  email: string,
  creds: OAuthCredentials | null,
  stored: StoredTokens | null,
): { creds: OAuthCredentials; stored: StoredTokens } {
  if (!creds) {
    throw new Error(
      `Cannot access Gmail account "${email}": OAuth client credentials are missing ` +
        `(~/.email-agent/oauth.json). Restore them (re-run setup), then run ` +
        `'npx email-agent accounts add ${email}' to re-authorize the account.`,
    );
  }
  if (!stored) {
    throw new Error(
      `Cannot access Gmail account "${email}": no stored tokens for this account. ` +
        `Run 'npx email-agent accounts add ${email}' to authorize it.`,
    );
  }
  return { creds, stored };
}

export async function createGmailClientForAccount(
  email: string,
): Promise<gmail_v1.Gmail> {
  // A named account must never silently fall back to gcloud ADC — that would
  // read/write a different mailbox under this account's id (cross-account
  // contamination). ADC is reserved for the unscoped path in client.ts.
  const { creds, stored } = requireAccountAuth(
    email,
    await getOAuthCredentials(),
    await getStoredTokens(email),
  );

  let tokens = stored;
  // Refresh if expired (with 5 min buffer)
  if (Date.now() >= tokens.expiresAt - 300_000) {
    tokens = await refreshAccessToken(creds, email, tokens);
  }

  const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  auth.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });

  return google.gmail({ version: "v1", auth });
}
