import { NextResponse, type NextRequest } from "next/server";
import { applyOperations } from "@email-agent/core/actions";
import type { GmailOperation } from "@email-agent/core/actions";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { operations: GmailOperation[] };

    if (!Array.isArray(body.operations) || body.operations.length === 0) {
      return NextResponse.json(
        { error: "operations array is required" },
        { status: 400 },
      );
    }

    const result = await applyOperations(body.operations);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
