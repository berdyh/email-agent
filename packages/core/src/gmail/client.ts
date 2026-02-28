import { google, type gmail_v1 } from "googleapis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createGmailClientForAccount,
  getDefaultAccount,
  getStoredTokens,
} from "./account-manager.js";

const execFileAsync = promisify(execFile);

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
    return createGmailClientForAccount(accountEmail);
  }

  // No explicit account — try the default account if it has stored tokens
  const defaultAccount = await getDefaultAccount();
  if (defaultAccount) {
    const tokens = await getStoredTokens(defaultAccount.email);
    if (tokens) {
      return createGmailClientForAccount(defaultAccount.email);
    }
  }

  // Fall back to gcloud ADC flow
  return createGmailClientFromGcloud();
}

export function resetGmailClient(): void {
  // No-op — kept for backward compatibility.
  // Clients are no longer cached, so there's nothing to reset.
}
