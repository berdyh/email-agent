import type { EmailRecord } from "./schema.js";
import type { GmailMessage } from "../gmail/types.js";

/**
 * Maps a LanceDB EmailRecord (stored form, with labels JSON-encoded as a
 * string) to the GmailMessage shape used by actions, analysis, and agent
 * prompts (labels as a string array).
 */
export function recordToGmailMessage(record: EmailRecord): GmailMessage {
  return {
    id: record.id,
    threadId: record.threadId,
    from: record.from,
    to: record.to,
    subject: record.subject,
    date: record.date,
    bodyText: record.bodyText,
    bodyHtml: record.bodyHtml,
    labels: JSON.parse(record.labels) as string[],
    isUnread: record.isUnread,
    senderDomain: record.senderDomain,
    snippet: record.snippet,
  };
}
