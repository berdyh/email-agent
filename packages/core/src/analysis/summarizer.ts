import { AgentRouter } from "../agents/router.js";
import { loadSettings } from "../config/settings.js";
import type { GmailMessage } from "../gmail/types.js";

const router = new AgentRouter();

export interface EmailSummary {
  overview: string;
  sections: SummarySection[];
  keyActions: string[];
}

export interface SummarySection {
  text: string;
  citation: {
    startOffset: number;
    endOffset: number;
    previewText: string;
  };
}

export async function summarizeEmail(
  email: GmailMessage,
): Promise<EmailSummary> {
  const settings = await loadSettings();

  const prompt = [
    settings.prompts.summary,
    "",
    `Subject: ${email.subject}`,
    `From: ${email.from}`,
    `Date: ${email.date}`,
    "",
    email.bodyText.slice(0, 8000),
  ].join("\n");

  const result = await router.execute({ prompt, temperature: 0.2 });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as EmailSummary;
    }
  } catch {
    // Fall through
  }

  return {
    overview: result.text.slice(0, 500),
    sections: [],
    keyActions: [],
  };
}
