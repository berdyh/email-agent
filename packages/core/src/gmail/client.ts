import { google, type gmail_v1 } from "googleapis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createGmailClientForAccount,
  getDefaultAccount,
  getStoredTokens,
} from "./account-manager.js";

const execFileAsync = promisify(execFile);

const CLIENT_TTL_MS = 5 * 60_000; // 5 minutes
const CLIENT_CACHE = new Map<string, { client: gmail_v1.Gmail; expiresAt: number }>();

function getCachedClient(key: string): gmail_v1.Gmail | null {
  const entry = CLIENT_CACHE.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.client;
  if (entry) CLIENT_CACHE.delete(key);
  return null;
}

function setCachedClient(key: string, client: gmail_v1.Gmail): gmail_v1.Gmail {
  CLIENT_CACHE.set(key, { client, expiresAt: Date.now() + CLIENT_TTL_MS });
  return client;
}

async function getAccessToken(): Promise<string> {
  const { stdout } = await execFileAsync("gcloud", [
    "auth",
    "application-default",
    "print-access-token",
  ]);
  return stdout.trim();
}

async function createGmailClientFromGcloud(): Promise<gmail_v1.Gmail> {
  const token = await getAccessToken();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token });

  return google.gmail({ version: "v1", auth });
}

export async function createGmailClient(
  accountEmail?: string,
): Promise<gmail_v1.Gmail> {
  // Explicit account requested — delegate to account manager
  if (accountEmail) {
    const cached = getCachedClient(accountEmail);
    if (cached) return cached;
    return setCachedClient(accountEmail, await createGmailClientForAccount(accountEmail));
  }

  // No explicit account — try the default account if it has stored tokens
  const defaultAccount = await getDefaultAccount();
  if (defaultAccount) {
    const tokens = await getStoredTokens(defaultAccount.email);
    if (tokens) {
      const cached = getCachedClient(defaultAccount.email);
      if (cached) return cached;
      return setCachedClient(
        defaultAccount.email,
        await createGmailClientForAccount(defaultAccount.email),
      );
    }
  }

  // Fall back to gcloud ADC flow
  const gcloudKey = "__gcloud__";
  const cached = getCachedClient(gcloudKey);
  if (cached) return cached;
  return setCachedClient(gcloudKey, await createGmailClientFromGcloud());
}

export function resetGmailClient(): void {
  CLIENT_CACHE.clear();
}

export async function resolveAccountEmail(accountEmail?: string): Promise<string> {
  if (accountEmail) return accountEmail;
  const defaultAccount = await getDefaultAccount();
  return defaultAccount?.email ?? "";
}
