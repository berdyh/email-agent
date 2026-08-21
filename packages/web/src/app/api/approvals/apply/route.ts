import { NextResponse, type NextRequest } from "next/server";
import { applyPendingOperationsByIds } from "@email-agent/core/actions";
import { initDb } from "@email-agent/core/db";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseJsonBody,
  parseApprovalIdsRequest,
  validationResponse,
} from "@/modules/api/validation";
import {
  claimedNothing,
  unclaimedApplyMessage,
  summarizeApplyResult,
  type ApplyApprovalsResult,
} from "@/modules/api/approvals-contract";

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const { ids } = parseApprovalIdsRequest(await parseJsonBody(request));

    await initDb();
    const result = await applyPendingOperationsByIds(ids, "web");
    const { requested, skipped } = summarizeApplyResult(ids, result);
    const body: ApplyApprovalsResult = { ...result, requested, skipped };

    // A no-op is not a success. Core returns all-zero counts both when a batch
    // was empty and when this call could claim none of the rows — and the UI
    // used to toast the second case as "Applied 0 changes". 409 says the
    // client's view of the queue conflicts with the server's, which is exactly
    // what is known; the message does not guess at why each row was unclaimable.
    if (claimedNothing(ids, result)) {
      return NextResponse.json(
        { ...body, error: unclaimedApplyMessage(requested) },
        { status: 409 },
      );
    }

    // `applied === 0 && failed > 0` — every claimed row failed at Gmail — is a
    // deliberate 200, not an oversight. It is a different event from the 409
    // above and the status has to keep saying so: there, the server could claim
    // NOTHING and the client's view of the queue is stale; here the server
    // owned every row it was given, called Gmail for each, and recorded a
    // terminal `failed` — a complete, authoritative result. The per-operation
    // record IS the answer, and it only survives on this path: the client's
    // `errorFromResponse` collapses a non-2xx into a single `Error` and throws
    // `outcomes`/`errors` away, so a non-2xx would trade N specific reasons for
    // one generic toast. The rows also changed state, so the caller must
    // refresh — which is what the mutation's success path does.
    //
    // The cost, stated rather than hidden: a caller keying off HTTP status
    // ALONE reads this as "the changes landed". No status can carry that
    // distinction; `applied`/`failed`/`outcomes` in the body can, and every
    // client here reads them (`describeApplyOutcome` toasts `failed > 0` as an
    // error). A non-browser client must read the body too.
    return NextResponse.json(body);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to apply approved operations");
  }
}
