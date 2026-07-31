import type { ActionEmailResult, ActionOutput } from "./types.js";

export function parseActionOutput(raw: string, emailIds: string[]): ActionOutput {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        return { results: parsed as ActionEmailResult[], rawText: raw };
      }
    } catch {
      // Fall through to raw-text fallback.
    }
  }

  return {
    results: emailIds.map((emailId) => ({ emailId, rawResult: raw })),
    rawText: raw,
  };
}
