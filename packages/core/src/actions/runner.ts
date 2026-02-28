import { randomUUID } from "node:crypto";
import { AgentRouter } from "../agents/router.js";
import { saveActionResult } from "../db/actions.js";
import { loadSettings } from "../config/settings.js";
import type { GmailMessage } from "../gmail/types.js";
import type {
  EmailAction,
  ActionOutput,
  ActionRunResult,
  ActionEmailResult,
} from "./types.js";
import { mapResultToOperations, applyOperations } from "./apply.js";

const router = new AgentRouter();

function buildPrompt(action: EmailAction, emails: GmailMessage[]): string {
  const emailSummaries = emails.map((e) => ({
    id: e.id,
    from: e.from,
    subject: e.subject,
    date: e.date,
    snippet: e.snippet,
    body: e.bodyText.slice(0, 2000),
  }));

  return [
    action.prompt,
    "",
    "Emails to analyze:",
    "```json",
    JSON.stringify(emailSummaries, null, 2),
    "```",
    "",
    'Respond with a JSON array of objects, each with an "emailId" field matching the email ID plus your analysis fields.',
  ].join("\n");
}

function parseOutput(raw: string, emailIds: string[]): ActionOutput {
  const results: ActionEmailResult[] = [];

  // Try to extract JSON from the response
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as ActionEmailResult[];
      if (Array.isArray(parsed)) {
        return { results: parsed, rawText: raw };
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: create a result per email with the raw text
  for (const emailId of emailIds) {
    results.push({ emailId, rawResult: raw });
  }

  return { results, rawText: raw };
}

export class ActionRunner {
  async run(
    action: EmailAction,
    emails: GmailMessage[],
  ): Promise<ActionRunResult> {
    const prompt = buildPrompt(action, emails);
    const emailIds = emails.map((e) => e.id);

    try {
      const agentResult = await router.execute({ prompt });

      const output = parseOutput(agentResult.text, emailIds);

      const result: ActionRunResult = {
        actionId: action.id,
        status: "success",
        output,
        agentUsed: agentResult.agentUsed,
        tokensUsed: agentResult.tokensUsed,
        durationMs: agentResult.durationMs,
      };

      // Map action results to Gmail operations
      const pendingOps = mapResultToOperations(action.id, output.results);

      if (pendingOps.length > 0) {
        const settings = await loadSettings();
        if (settings.gmail.syncActions) {
          result.applyResult = await applyOperations(pendingOps);
        } else {
          result.pendingOperations = pendingOps;
        }
      }

      // Persist to DB
      await saveActionResult({
        id: randomUUID(),
        actionId: action.id,
        status: "success",
        emailIds: JSON.stringify(emailIds),
        resultData: JSON.stringify(output),
        agentUsed: agentResult.agentUsed,
        tokensUsed: agentResult.tokensUsed,
        durationMs: agentResult.durationMs,
        createdAt: new Date().toISOString(),
      });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        actionId: action.id,
        status: "error",
        error,
        agentUsed: "unknown",
        tokensUsed: 0,
        durationMs: 0,
      };
    }
  }
}
