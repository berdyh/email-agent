import { createGmailClient } from "./client.js";
import type { GmailMessage, GmailThread } from "./types.js";

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractBody(
  payload: any,
  mimeType: string,
): string {
  if (payload.body?.data) {
    if (payload.mimeType === mimeType) {
      return decodeBase64Url(payload.body.data);
    }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part, mimeType);
      if (result) return result;
    }
  }
  return "";
}

function extractDomain(from: string): string {
  const match = from.match(/@([^>]+)>?$/);
  return match?.[1] ?? "";
}

function parseGmailMessage(msg: any): GmailMessage {
  const headers = msg.payload?.headers ?? [];
  const from = extractHeader(headers, "From");
  const to = extractHeader(headers, "To");
  const subject = extractHeader(headers, "Subject");
  const date = extractHeader(headers, "Date");
  const bodyText = extractBody(msg.payload, "text/plain");
  const bodyHtml = extractBody(msg.payload, "text/html");
  const labels: string[] = msg.labelIds ?? [];
  const isUnread = labels.includes("UNREAD");

  return {
    id: msg.id!,
    threadId: msg.threadId!,
    from,
    to,
    subject,
    date,
    bodyText,
    bodyHtml,
    labels,
    isUnread,
    senderDomain: extractDomain(from),
    snippet: msg.snippet ?? "",
  };
}

export interface FetchOptions {
  scope: "unread" | "all";
  maxResults?: number;
  accountEmail?: string;
}

export async function fetchEmails(
  options: FetchOptions,
): Promise<GmailMessage[]> {
  const gmail = await createGmailClient(options.accountEmail);
  const response = await gmail.users.messages.list({
    userId: "me",
    q: options.scope === "unread" ? "is:unread" : undefined,
    maxResults: options.maxResults ?? 50,
  });

  const messageIds = response.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const results = await Promise.allSettled(
    messageIds.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: id!,
        format: "full",
      });
      return parseGmailMessage(msg.data);
    }),
  );

  const messages: GmailMessage[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      messages.push(result.value);
    } else {
      console.error("Failed to fetch message:", result.reason);
    }
  }

  return messages;
}

export async function fetchUnreadEmails(
  maxResults = 50,
): Promise<GmailMessage[]> {
  return fetchEmails({ scope: "unread", maxResults });
}

export async function fetchEmail(id: string, accountEmail?: string): Promise<GmailMessage> {
  const gmail = await createGmailClient(accountEmail);
  const msg = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  return parseGmailMessage(msg.data);
}

export async function fetchThread(threadId: string, accountEmail?: string): Promise<GmailThread> {
  const gmail = await createGmailClient(accountEmail);
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = (thread.data.messages ?? []).map(parseGmailMessage);
  const subject = messages[0]?.subject ?? "";
  const snippet = thread.data.snippet ?? "";

  return { id: threadId, messages, subject, snippet };
}
