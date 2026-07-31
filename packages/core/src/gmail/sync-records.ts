import type { EmailRecord } from "../db/schema.js";
import { createLocalEmbeddingVector } from "../shared/vector.js";
import type { GmailMessage } from "./types.js";

export function emailEmbeddingText(email: GmailMessage): string {
  return `${email.subject}\n${email.from}\n${email.bodyText.slice(0, 500)}`;
}

export function buildEmailRecords(
  accountId: string,
  emails: GmailMessage[],
  vectors: number[][],
): EmailRecord[] {
  return emails.map((email, index) => ({
    id: email.id,
    accountId,
    threadId: email.threadId,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    bodyText: email.bodyText,
    bodyHtml: email.bodyHtml,
    labels: JSON.stringify(email.labels),
    isUnread: email.isUnread,
    senderDomain: email.senderDomain,
    snippet: email.snippet,
    vector: vectors[index] ?? createLocalEmbeddingVector(emailEmbeddingText(email)),
  }));
}
