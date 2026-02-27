import { AgentRouter } from "../agents/router.js";
import { loadSettings } from "../config/settings.js";
import type { GmailMessage } from "../gmail/types.js";

const router = new AgentRouter();

export interface DigestEntry {
  sender: string;
  domain: string;
  emailCount: number;
  summary: string;
  highlights: string[];
  actionItems: string[];
}

export interface Digest {
  date: string;
  entries: DigestEntry[];
  overview: string;
}

/** Group subscription emails by sender and generate a summarized digest. */
export async function generateDigest(
  emails: GmailMessage[],
): Promise<Digest> {
  const settings = await loadSettings();

  // Group emails by sender domain
  const grouped = new Map<string, GmailMessage[]>();
  for (const email of emails) {
    const key = email.senderDomain || email.from;
    const list = grouped.get(key) ?? [];
    list.push(email);
    grouped.set(key, list);
  }

  const groupSummaries = [...grouped.entries()].map(([domain, msgs]) => ({
    sender: msgs[0]!.from,
    domain,
    count: msgs.length,
    subjects: msgs.map((m) => m.subject),
    snippets: msgs.map((m) => m.snippet),
  }));

  const prompt = [
    settings.prompts.digest,
    "",
    "Subscription emails grouped by sender:",
    "```json",
    JSON.stringify(groupSummaries, null, 2),
    "```",
    "",
    "Return a JSON object with:",
    '- overview: 1-2 sentence digest overview',
    '- entries: array of { sender, domain, emailCount, summary, highlights: string[], actionItems: string[] }',
  ].join("\n");

  const result = await router.execute({ prompt, temperature: 0.3 });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Omit<Digest, "date">;
      return { ...parsed, date: new Date().toISOString() };
    }
  } catch {
    // Fall through
  }

  return {
    date: new Date().toISOString(),
    overview: result.text.slice(0, 500),
    entries: [],
  };
}
