import { google, type gmail_v1 } from "googleapis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let gmailClient: gmail_v1.Gmail | null = null;

async function getAccessToken(): Promise<string> {
  const { stdout } = await execFileAsync("gcloud", [
    "auth",
    "application-default",
    "print-access-token",
  ]);
  return stdout.trim();
}

export async function createGmailClient(): Promise<gmail_v1.Gmail> {
  if (gmailClient) return gmailClient;

  const token = await getAccessToken();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token });

  // Refresh token when it expires
  auth.on("tokens", () => {
    // Token refreshed via gcloud ADC automatically
  });

  gmailClient = google.gmail({ version: "v1", auth });
  return gmailClient;
}

export function resetGmailClient(): void {
  gmailClient = null;
}
