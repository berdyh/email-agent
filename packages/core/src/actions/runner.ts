import { randomUUID } from "node:crypto";
import { AgentRouter } from "../agents/router.js";
import { saveActionResult } from "../db/actions.js";
import { loadSettings } from "../config/settings.js";
import type { GmailMessage } from "../gmail/types.js";
import type {
  EmailAction,
  ActionRunResult,
} from "./types.js";
import {
  mapResultToOperations,
  scopeOperationsToAccounts,
  type OperationAccountLookup,
} from "./apply.js";
import {
  applyPendingOperationsByIds,
  enqueueOperations,
} from "./approval.js";
import { parseActionOutput } from "./output-parser.js";

const router = new AgentRouter();

/**
 * Derives the accountId to persist on an action result row.
 *
 * When an explicit account scoped the run, that account is authoritative and
 * is used directly by the caller. This helper covers the "all accounts" run
 * (no explicit accountEmail): it inspects the per-message account lookup for
 * the processed emails and returns the single distinct account id if the whole
 * batch resolves to exactly one account. If several accounts are involved, any
 * message is ambiguous (null), any id is missing from the lookup, or there is
 * no lookup at all, it returns "" — the legacy/unscoped-OR-mixed sentinel.
 */
export function deriveResultAccountId(
  emailIds: string[],
  accountEmailByMessageId?: OperationAccountLookup,
): string {
  if (!accountEmailByMessageId) return "";

  const accountIds = new Set<string>();
  for (const emailId of emailIds) {
    const accountId = accountEmailByMessageId.get(emailId);
    // undefined = not in lookup, null = message exists in multiple accounts.
    if (accountId === undefined || accountId === null) return "";
    accountIds.add(accountId);
  }

  const [only] = accountIds;
  return accountIds.size === 1 && only !== undefined ? only : "";
}

function buildPrompt(action: EmailAction, emails: GmailMessage[]): string {
  const emailSummaries = emails.map((e) => ({
    id: e.id,
    from: e.from,
    subject: e.subject,
    date: e.date,
    snippet: e.snippet,
    body: e.bodyText.slice(0, 2000),
  }));

  const parts = [
    action.prompt,
    "",
    "Emails to analyze:",
    "```json",
    JSON.stringify(emailSummaries, null, 2),
    "```",
    "",
    'Respond with a JSON array of objects, each with an "emailId" field matching the email ID plus your analysis fields.',
  ];

  if (action.outputSchema) {
    parts.push("", `Expected output shape per email: ${action.outputSchema}`);
  }

  return parts.join("\n");
}

export class ActionRunner {
  async run(
    action: EmailAction,
    emails: GmailMessage[],
    accountEmail?: string,
    accountEmailByMessageId?: OperationAccountLookup,
  ): Promise<ActionRunResult> {
    const prompt = buildPrompt(action, emails);
    const emailIds = emails.map((e) => e.id);

    try {
      const agentResult = await router.execute({ prompt });

      const output = parseActionOutput(agentResult.text, emailIds);

      const resultId = randomUUID();
      const result: ActionRunResult = {
        actionId: action.id,
        status: "success",
        output,
        agentUsed: agentResult.agentUsed,
        tokensUsed: agentResult.tokensUsed,
        durationMs: agentResult.durationMs,
      };

      // Map action results to Gmail operations
      const pendingOps = scopeOperationsToAccounts(
        mapResultToOperations(action.id, output.results),
        accountEmail,
        accountEmailByMessageId,
      );

      // Gmail mutations always go through the approval queue first, so every
      // proposed change is recorded before anything touches Gmail. They are
      // applied here only when the user opted into auto-apply AND accepted its
      // warnings in Settings; otherwise they wait for an explicit approval in
      // the web panel or CLI. The batch id ties queue rows to the action result.
      if (pendingOps.length > 0) {
        let queuedIds: string[] = [];
        try {
          queuedIds = await enqueueOperations({
            batchId: resultId,
            actionId: action.id,
            actionName: action.name,
            operations: pendingOps,
          });
          // Only claim the batch is awaiting approval once it is actually
          // persisted. Reporting pendingOperations for a batch that failed to
          // queue tells the UI to show "N changes await your approval" for
          // changes no approval surface can ever find.
          result.pendingOperations = pendingOps;
          result.batchId = resultId;
        } catch (queueErr) {
          const message =
            queueErr instanceof Error ? queueErr.message : String(queueErr);
          console.error(
            `Failed to queue pending operations for "${action.id}": ${message}`,
          );
          result.queueError = message;
        }

        if (queuedIds.length > 0) {
          try {
            const settings = await loadSettings();
            if (settings.gmail.autoApplyActions) {
              result.applyResult =
                await applyPendingOperationsByIds(queuedIds);
              // Set only after the apply resolves, so `autoApplied` never
              // claims a batch was applied when the attempt threw.
              result.autoApplied = true;
            }
          } catch (applyErr) {
            const message =
              applyErr instanceof Error ? applyErr.message : String(applyErr);
            console.error(
              `Failed to auto-apply operations for "${action.id}": ${message}`,
            );
            // The rows stay queued, so the user can still approve them by hand.
            result.queueError = message;
          }
        }
      }

      // Persist to DB in its own try/catch: the run itself succeeded and its
      // operations are already queued, so a persistence failure must not be
      // reported to the caller as a failed run.
      try {
        // An explicit accountEmail is authoritative. Otherwise (an "all
        // accounts" run) derive the account from the per-message lookup so a
        // single-account batch is still attributed correctly, rather than
        // collapsing to the unscoped "" sentinel.
        const resultAccountId =
          accountEmail ??
          deriveResultAccountId(emailIds, accountEmailByMessageId);

        await saveActionResult({
          id: resultId,
          actionId: action.id,
          accountId: resultAccountId,
          status: "success",
          emailIds: JSON.stringify(emailIds),
          resultData: JSON.stringify(output),
          agentUsed: agentResult.agentUsed,
          tokensUsed: agentResult.tokensUsed,
          durationMs: agentResult.durationMs,
          createdAt: new Date().toISOString(),
        });
      } catch (persistErr) {
        const message =
          persistErr instanceof Error ? persistErr.message : String(persistErr);
        console.error(
          `Failed to persist action result for "${action.id}": ${message}`,
        );
      }

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
