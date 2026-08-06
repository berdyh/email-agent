import { NextResponse, type NextRequest } from "next/server";
import { countPendingOperations, initDb } from "@email-agent/core/db";
import { internalErrorResponse, readGuardResponse } from "@/modules/api/validation";

/**
 * Badge-only endpoint. The sidebar polls this on every page, so it must stay a
 * single row count — GET /api/approvals builds the full payload and does a
 * per-email lookup, which is far too much work for a number in the nav.
 */
export async function GET(request: NextRequest) {
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    await initDb();
    const pendingCount = await countPendingOperations("pending");
    return NextResponse.json({ pendingCount });
  } catch (err) {
    return internalErrorResponse(err, "Failed to count pending approvals");
  }
}
