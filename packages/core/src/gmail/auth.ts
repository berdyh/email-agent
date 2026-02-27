import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AuthStatus {
  authenticated: boolean;
  account?: string;
  projectId?: string;
}

export async function checkGcloudAuth(): Promise<AuthStatus> {
  try {
    const { stdout: account } = await execFileAsync("gcloud", [
      "config",
      "get-value",
      "account",
    ]);
    const { stdout: project } = await execFileAsync("gcloud", [
      "config",
      "get-value",
      "project",
    ]);

    const trimmedAccount = account.trim();
    const trimmedProject = project.trim();

    return {
      authenticated: trimmedAccount !== "" && trimmedAccount !== "(unset)",
      account: trimmedAccount || undefined,
      projectId: trimmedProject || undefined,
    };
  } catch {
    return { authenticated: false };
  }
}

export async function loginGcloud(): Promise<boolean> {
  try {
    await execFileAsync("gcloud", [
      "auth",
      "login",
      "--update-adc",
      "--scopes",
      [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/pubsub",
        "openid",
        "email",
        "profile",
      ].join(","),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function setGcloudProject(projectId: string): Promise<boolean> {
  try {
    await execFileAsync("gcloud", [
      "config",
      "set",
      "project",
      projectId,
    ]);
    return true;
  } catch {
    return false;
  }
}
