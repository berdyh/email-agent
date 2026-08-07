import { NextResponse, type NextRequest } from "next/server";
import {
  getStaleApplyingOperations,
  initDb,
  STALE_APPLYING_THRESHOLD_MS,
} from "@email-agent/core/db";
import { adjudicateStrandedOperations } from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseStrandedResolutionRequest,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";
import { toApprovalOperations } from "@/modules/api/approval-rows";
import type {
  ResolveStrandedResult,
  StrandedApprovalsResponse,
  StrandedOperation,
} from "@/modules/api/approvals-contract";

/**
 * Queue rows a crash left claimed mid-apply.
 *
 * These are `applying`, not `pending`, so `GET /api/approvals` cannot see them
 * and neither approve nor reject will touch them. Until this route existed they
 * were invisible on every surface: a change that may really have trashed mail,
 * with nothing anywhere to tell the user it happened.
 *
 * A REPORT, NOT A RECOVERY. Nothing here re-applies, rolls back or verifies
 * anything — see the POST below for what the user can do about them.
 */
export async function GET(request: NextRequest) {
  // Returns subjects, senders and snippets, exactly like the pending list.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const rows = await getStaleApplyingOperations();
    const operations = await toApprovalOperations(rows);
    const claimedAtById = new Map(rows.map((row) => [row.id, row.claimedAt]));

    return NextResponse.json({
      operations: operations.map(
        (operation): StrandedOperation => ({
          ...operation,
          // Falls back to createdAt for rows migrated in from a table that
          // predates the column, matching how core ages them.
          claimedAt: claimedAtById.get(operation.id) || operation.createdAt,
        }),
      ),
      thresholdMinutes: Math.round(STALE_APPLYING_THRESHOLD_MS / 60_000),
    } satisfies StrandedApprovalsResponse);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load stranded Gmail changes");
  }
}

/**
 * Records what the user found when they checked Gmail.
 *
 * `applied` retires the row into the audit trail with a note saying the user —
 * not the app — decided it. `notApplied` returns it to `pending`, where it is an
 * ordinary proposal again. There is deliberately no third option and no retry:
 * core claimed the row before it called Gmail, so re-applying could be a second
 * trash of an already-trashed message, and no check we can run distinguishes
 * "we did this" from "it was already like that".
 */
export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const { ids, decision } = parseStrandedResolutionRequest(await request.json());
    await initDb();
    const resolved = await adjudicateStrandedOperations(ids, decision);

    return NextResponse.json({
      decision,
      requested: ids.length,
      resolved,
      // Not an error. The ids come from the client's snapshot of the stale
      // list, and a row an in-flight apply finished in the meantime is no
      // longer `applying` — core leaves its real outcome alone, and the client
      // says so rather than claiming the user's answer was recorded.
      skipped: Math.max(0, ids.length - resolved),
    } satisfies ResolveStrandedResult);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to record your decision");
  }
}
