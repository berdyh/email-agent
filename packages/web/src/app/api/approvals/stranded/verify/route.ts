import { NextResponse, type NextRequest } from "next/server";
import { initDb } from "@email-agent/core/db";
import { verifyStrandedApplyingOperations } from "@email-agent/core/actions";
import { internalErrorResponse, mutationGuardResponse } from "@/modules/api/validation";
import type { VerifyStrandedResult } from "@/modules/api/approvals-contract";

/**
 * Checks every row a crash left mid-apply against Gmail's CURRENT label state,
 * and resolves what it can WITHOUT the user.
 *
 * A MUTATION, not a read, on purpose. This calls Gmail and writes rows, so it
 * cannot live behind `readGuardResponse` — `GET /api/approvals/stranded` stays
 * a pure DB read, unchanged, and this is a second, explicit route the panel
 * calls once per page load. It is NOT a background poll: there is no interval
 * here or anywhere upstream of it, matching the repo's stated cadence (only
 * `email-agent serve` startup and `email-agent fetch` run this unprompted —
 * see AGENTS.md/TODOS.md). This route is the on-demand third case: a human
 * explicitly opened the page whose entire job is showing stranded rows, and
 * checking them IS what that page does. Fire this once per mount, never on a
 * background refetch — see `StrandedOperationsPanel`.
 *
 * GATED ON A CHEAP DB READ FIRST, inside `verifyStrandedApplyingOperations`
 * itself: if nothing is stale, this makes zero Gmail calls and writes nothing.
 *
 * BOUNDED IN TIME, also inside core, which is why this route needs nothing of
 * its own. The reads are serial and nothing under `users.messages.get` supplied
 * a timeout until 2026-08-22, so a network that hangs connections rather than
 * resetting them left this request open for as long as the browser would hold
 * it — with the panel spinning and no way to tell a slow check from a dead one.
 * `GMAIL_READ_DEADLINE_MS` (10s per read) under
 * `STRANDED_VERIFICATION_DEADLINE_MS` (20s per pass) caps this handler at 30s
 * however many rows are stranded. Rows the budget did not reach come back in
 * `unresolved` as `not-checked` — untouched, still listed by
 * `GET /api/approvals/stranded`, and checked by the next pass. That is why the
 * panel must render `unresolved` rather than inferring anything from `checked`
 * minus the recorded counts.
 *
 * EVIDENCE. A row this resolves as `applied` is stamped `verified-api` /
 * `STRANDED_VERIFIED_NOTE`, never `STRANDED_APPLIED_NOTE` — the audit trail
 * must keep the two claims (a Gmail read vs a human's word) apart. Reading a
 * message's current labels proves the mailbox is now in the wanted state; it
 * does NOT prove this app's own call put it there — see the module header on
 * `verify-stranded.ts` for the full reasoning, including the one case this can
 * never resolve as `applied`: a row queued under the `""` gcloud-ADC sentinel,
 * because `createGmailClient("")` reads whatever mailbox ADC points at NOW.
 */
export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const result = await verifyStrandedApplyingOperations();

    return NextResponse.json({
      checked: result.checked,
      appliedRecorded: result.appliedRecorded,
      requeuedRecorded: result.requeuedRecorded,
      unresolved: result.unresolved.map((row) => ({
        id: row.id,
        emailId: row.emailId,
        accountId: row.accountId,
        reason: row.reason,
        detail: row.detail,
      })),
    } satisfies VerifyStrandedResult);
  } catch (err) {
    return internalErrorResponse(err, "Failed to check stranded Gmail changes");
  }
}
