import { NextResponse, type NextRequest } from "next/server";
import {
  listUserActions,
  saveUserAction,
  deleteUserAction,
  readUserActionSource,
  builtInActions,
  UnsafeActionSourceError,
} from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseUserActionDeleteRequest,
  parseUserActionSaveRequest,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";
import { extractActionId } from "@/lib/action-id";

export async function GET(request: NextRequest) {
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    const filename = request.nextUrl.searchParams.get("filename");

    // If filename is provided, return the raw source code
    if (filename) {
      // Returning an action's source is held to the stricter mutation guard:
      // it must prove it came from the UI, not just from something local.
      const sourceGuard = mutationGuardResponse(request);
      if (sourceGuard) return sourceGuard;

      const parsed = parseUserActionDeleteRequest({ filename });
      const source = await readUserActionSource(parsed.filename);
      return NextResponse.json({ filename: parsed.filename, source });
    }

    const actions = await listUserActions();
    return NextResponse.json(actions);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to load actions");
  }
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseUserActionSaveRequest(await request.json());

    // Check for ID conflict with built-in actions
    const actionId = extractActionId(body.content);
    if (actionId) {
      const conflicting = builtInActions.find((a) => a.id === actionId);
      if (conflicting) {
        return NextResponse.json(
          { error: `Action ID "${actionId}" conflicts with built-in action "${conflicting.name}"` },
          { status: 409 },
        );
      }
    }

    await saveUserAction(body.filename, body.content);
    return NextResponse.json({ success: true, filename: body.filename });
  } catch (err) {
    // The source guard rejected it. Return the reasons rather than a generic
    // 500: the chat UI shows this back to the model that wrote the action, and
    // it is the only way either the model or the user learns what to change.
    if (err instanceof UnsafeActionSourceError) {
      return NextResponse.json(
        { error: err.message, violations: err.violations },
        { status: 422 },
      );
    }

    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to save action");
  }
}

export async function DELETE(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseUserActionDeleteRequest(await request.json());

    await deleteUserAction(body.filename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to delete action");
  }
}
