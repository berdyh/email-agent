import { NextResponse, type NextRequest } from "next/server";
import {
  listUserActions,
  saveUserAction,
  deleteUserAction,
  readUserActionSource,
  builtInActions,
  extractActionData,
  UnsafeActionSourceError,
} from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseJsonBody,
  parseUserActionDeleteRequest,
  parseUserActionSaveRequest,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";

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
    const body = parseUserActionSaveRequest(await parseJsonBody(request));

    // Check for ID conflict with built-in actions. Reads identity the same
    // way core's own loader does — `extractActionData()` statically evaluates
    // the file's AST and resolves identifiers against names the file bound
    // earlier, so `const ID = "junk"; export default { id: ID, ... }`
    // resolves to "junk" here exactly as it would at load time. The old
    // regex (`extractActionId`, since deleted) only matched a literal on the
    // `id:` line, so a const-bound id returned null and this whole check was
    // skipped — the file saved to disk shadowing a built-in action. Letting
    // `UnsafeActionSourceError` propagate to the catch block below is
    // deliberate: a file that is both unsafe AND collides is reported for the
    // guard violation, the more fundamental problem, and the one the chat UI
    // needs `.violations` to fix. `saveUserAction()` below still
    // independently re-validates via `assertSafeActionSource` internally —
    // a deliberate, accepted double-parse of the same content, not a bug to
    // dedupe.
    const parsedAction = extractActionData(body.content, body.filename, {
      onDiagnostic: (message) => console.warn(message),
    });
    if (parsedAction) {
      const conflicting = builtInActions.find((a) => a.id === parsedAction.id);
      if (conflicting) {
        return NextResponse.json(
          {
            error: `Action ID "${parsedAction.id}" conflicts with built-in action "${conflicting.name}"`,
          },
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
    const body = parseUserActionDeleteRequest(await parseJsonBody(request));

    await deleteUserAction(body.filename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to delete action");
  }
}
