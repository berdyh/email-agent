import type { EmailRecord } from "../db/schema.js";

interface ClusterSummary {
  name: string;
  description: string;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "and",
  "are",
  "body",
  "com",
  "for",
  "from",
  "has",
  "have",
  "hello",
  "into",
  "mail",
  "new",
  "not",
  "the",
  "this",
  "to",
  "with",
  "you",
  "your",
]);

const TOKEN_PATTERN = /[\p{L}\p{N}]{3,}/gu;

export function summarizeCluster(
  emails: Pick<EmailRecord, "subject" | "from" | "senderDomain" | "snippet" | "bodyText">[],
): ClusterSummary {
  const termScores = new Map<string, number>();
  const senderScores = new Map<string, number>();

  for (const email of emails) {
    const sender = email.senderDomain || email.from.split("@").at(-1) || email.from;
    senderScores.set(sender, (senderScores.get(sender) ?? 0) + 1);

    const weightedText = `${email.subject} ${email.subject} ${email.snippet} ${email.bodyText.slice(0, 300)}`;
    for (const match of weightedText.toLowerCase().matchAll(TOKEN_PATTERN)) {
      const term = match[0];
      if (STOP_WORDS.has(term)) continue;
      termScores.set(term, (termScores.get(term) ?? 0) + 1);
    }
  }

  const terms = [...termScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([term]) => term);
  const senders = [...senderScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([sender]) => sender);

  const topic = terms.length > 0 ? terms.join(", ") : senders.join(", ") || "related messages";
  const name = titleCase(terms.slice(0, 3).join(" ") || senders[0] || "Email Cluster");
  const senderPhrase = senders.length > 0 ? ` from ${senders.join(", ")}` : "";

  return {
    name,
    description: `${emails.length} email${emails.length === 1 ? "" : "s"} about ${topic}${senderPhrase}`,
  };
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
