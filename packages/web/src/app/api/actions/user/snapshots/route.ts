import { NextResponse, type NextRequest } from "next/server";
import { listSnapshots, restoreSnapshot } from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseSnapshotRestoreRequest,
  parseUserActionDeleteRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const filename = parseUserActionDeleteRequest({
      filename: request.nextUrl.searchParams.get("filename"),
    }).filename;

    const snapshots = await listSnapshots(filename);
    return NextResponse.json(snapshots);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to list action snapshots");
  }
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseSnapshotRestoreRequest(await request.json());

    await restoreSnapshot(body.snapshotFilename, body.originalFilename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to restore action snapshot");
  }
}
