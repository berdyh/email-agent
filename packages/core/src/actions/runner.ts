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
  enqueueOperationsDetailed,
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

/**
 * Wording for an auto-apply that threw.
 *
 * NOT YET SHOWN TO ANYONE. This string, `result.applyError`, and
 * `result.persistError` all exist and are populated, but **no surface reads
 * them**: the web result type omits both fields.
 *
 * Be precise about what each surface does instead, because "both print the
 * `queueError` copy" is not accurate for this branch. On an auto-apply failure
 * `queueError` is UNSET — the rows queued fine. So `packages/web/src/app/
 * actions/page.tsx` falls through to its "N changes await your approval"
 * branch and reports rows that are now `applying`, not `pending`; and
 * `packages/cli/src/commands/run-action.ts` queries `status: "pending"`, finds
 * none, and prints its "nothing was applied" copy. Different routes, same
 * outcome: both tell the user nothing happened to mail that may really have
 * been trashed. What this branch changed is the core data, not what anybody
 * sees. The adoption is tracked in TODOS.md ("Surfaces still read only
 * `queueError`") and names the exact files.
 *
 * The wording itself must not claim more than we know.
 * `applyPendingOperationsByIds` claims rows before any Gmail call, which means
 * it can only throw before the first mutation OR after mutations have already
 * completed but their outcome could not be written back. From here the two are
 * indistinguishable, so the honest statement is "may have been applied".
 */
export function describeAutoApplyFailure(message: string): string {
  return `Auto-apply failed after the changes were queued: ${message}. Some Gmail changes may already have been applied; their outcome could not be recorded. Review the approval queue for operations stuck in "applying" before re-running this action.`;
}

/**
 * Wording for a run whose `action_results` row could not be written.
 *
 * Nothing is queued in that case, so unlike the auto-apply message this one
 * CAN state plainly that the mailbox is untouched. It is assigned to
 * `queueError`, which the surfaces DO read, so this string does reach the
 * user — unlike `describeAutoApplyFailure` above.
 */
export function describeUnrecordedBatchFailure(message: string): string {
  return `The action result could not be recorded (${message}), so its Gmail changes were not queued. Nothing was applied — re-run the action to propose them again.`;
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

      // PARENT ROW FIRST. Queue rows are stamped `batchId = resultId`, so
      // writing them before the `action_results` row can leave the queue
      // referencing a batch that was never recorded, with nothing to
      // reconcile it against. Persisting the parent first makes the batch id
      // meaningful by the time anything points at it.
      //
      // Its own try/catch: the run itself succeeded, so a persistence failure
      // must not be reported to the caller as a failed run.
      let batchRecorded = true;
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
        batchRecorded = false;
        const message =
          persistErr instanceof Error ? persistErr.message : String(persistErr);
        console.error(
          `Failed to persist action result for "${action.id}": ${message}`,
        );
        result.persistError = message;
      }

      // Gmail mutations always go through the approval queue first, so every
      // proposed change is recorded before anything touches Gmail. They are
      // applied here only when the user opted into auto-apply AND accepted its
      // warnings in Settings; otherwise they wait for an explicit approval in
      // the web panel or CLI. The batch id ties queue rows to the action result.
      if (pendingOps.length > 0) {
        if (!batchRecorded) {
          // Fail closed rather than orphan the rows. The proposals are only
          // proposals — re-running reproduces them — whereas queue rows whose
          // batch does not exist are unattributable forever.
          result.queueError = describeUnrecordedBatchFailure(
            result.persistError ?? "unknown error",
          );
          return result;
        }

        let queuedIds: string[] = [];
        try {
          const queued = await enqueueOperationsDetailed({
            batchId: resultId,
            actionId: action.id,
            actionName: action.name,
            operations: pendingOps,
          });
          queuedIds = queued.ids;
          // Only claim the batch is awaiting approval once it is actually
          // persisted, and only for the rows that were really written —
          // reporting pendingOperations for a batch that failed to queue (or
          // for proposals dropped as duplicates of rows already awaiting
          // approval) tells the UI to show "N changes await your approval" for
          // changes this batch has no rows for.
          if (queued.duplicates > 0) {
            result.duplicateOperations = queued.duplicates;
          }
          if (queued.ids.length > 0) {
            result.pendingOperations = queued.operations;
            result.batchId = resultId;
          }
        } catch (queueErr) {
          const message =
            queueErr instanceof Error ? queueErr.message : String(queueErr);
          console.error(
            `Failed to queue pending operations for "${action.id}": ${message}`,
          );
          result.queueError = message;
        }

        if (queuedIds.length > 0) {
          // Read the toggle OUTSIDE the apply try. `loadSettings()` fails
          // closed on an unreadable settings file, and that failure is
          // strictly pre-Gmail: nothing was claimed, nothing was mutated.
          // Reporting it through `applyError` would tell the user their mail
          // "may already have been applied" when it provably was not — an
          // overclaim, even though it errs toward caution.
          let autoApply = false;
          try {
            autoApply = (await loadSettings()).gmail.autoApplyActions;
          } catch (settingsErr) {
            const message =
              settingsErr instanceof Error
                ? settingsErr.message
                : String(settingsErr);
            // We do not know whether auto-apply is armed, so we do not arm it.
            // The batch stays queued and every surface's "N changes await your
            // approval" is then literally true — the rows really are `pending`
            // and really do need an explicit approval.
            console.error(
              `Could not read settings while running "${action.id}", so auto-apply was not attempted and the batch is left awaiting approval: ${message}`,
            );
          }

          try {
            if (autoApply) {
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
            // NOT queueError. The rows were queued; what failed is the apply,
            // and by this point Gmail may already have been mutated (see
            // `describeAutoApplyFailure`). Reusing queueError made every
            // surface print "nothing was applied" for mail that had really
            // been trashed.
            //
            // NOTE: no surface reads `applyError` yet, so the user still sees
            // the wrong message here. Separating the field is a prerequisite
            // for the fix, not the fix. See TODOS.md "Surfaces still read only
            // `queueError`" for the files that must change.
            result.applyError = describeAutoApplyFailure(message);
          }
        }
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
