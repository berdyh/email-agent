import { google, type gmail_v1 } from "googleapis";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountConfig } from "../config/types.js";
import type { OAuthCredentials, StoredTokens } from "./account-types.js";
import { resetGmailClient } from "./client.js";

const execFileAsync = promisify(execFile);

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
  "https://www.googleapis.com/auth/pubsub",
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

export async function saveOAuthCredentials(creds: OAuthCredentials): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await writeFile(OAUTH_PATH, JSON.stringify(creds, null, 2));
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

export async function listAccounts(): Promise<AccountConfig[]> {
  try {
    const { loadSettings } = await import("../config/settings.js");
    const settings = await loadSettings();
    return settings.accounts ?? [];
  } catch {
    return [];
  }
}

export async function addAccount(account: AccountConfig): Promise<void> {
  const { loadSettings, saveSettings } = await import("../config/settings.js");
  const settings = await loadSettings();
  const accounts = [...settings.accounts];

  const existing = accounts.findIndex((a) => a.email === account.email);
  if (existing >= 0) {
    accounts[existing] = account;
  } else {
    accounts.push(account);
  }

  // If this is the first account or marked default, clear other defaults
  if (account.isDefault || accounts.length === 1) {
    for (const a of accounts) {
      a.isDefault = a.email === account.email;
    }
  }

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

export async function createGmailClientForAccount(
  email: string,
): Promise<gmail_v1.Gmail> {
  const creds = await getOAuthCredentials();
  const stored = await getStoredTokens(email);

  if (!creds || !stored) {
    // Fallback to gcloud ADC
    return createGmailClientFromGcloud();
  }

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

async function createGmailClientFromGcloud(): Promise<gmail_v1.Gmail> {
  const { stdout } = await execFileAsync("gcloud", [
    "auth",
    "application-default",
    "print-access-token",
  ]);
  const token = stdout.trim();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token });

  return google.gmail({ version: "v1", auth });
}
