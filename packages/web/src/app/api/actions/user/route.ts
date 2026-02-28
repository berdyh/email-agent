import { NextResponse, type NextRequest } from "next/server";
import {
  listUserActions,
  saveUserAction,
  deleteUserAction,
  readUserActionSource,
  builtInActions,
} from "@email-agent/core/actions";

export async function GET(request: NextRequest) {
  try {
    const filename = request.nextUrl.searchParams.get("filename");

    // If filename is provided, return the raw source code
    if (filename) {
      const source = await readUserActionSource(filename);
      return NextResponse.json({ filename, source });
    }

    const actions = await listUserActions();
    return NextResponse.json(actions);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { filename: string; content: string };

    if (!body.filename || !body.content) {
      return NextResponse.json({ error: "filename and content are required" }, { status: 400 });
    }

    if (!body.filename.endsWith(".action.ts")) {
      return NextResponse.json({ error: "Filename must end with .action.ts" }, { status: 400 });
    }

    // Check for ID conflict with built-in actions
    const idMatch = body.content.match(/id:\s*["'`]([^"'`]+)["'`]/);
    if (idMatch?.[1]) {
      const conflicting = builtInActions.find((a) => a.id === idMatch[1]);
      if (conflicting) {
        return NextResponse.json(
          { error: `Action ID "${idMatch[1]}" conflicts with built-in action "${conflicting.name}"` },
          { status: 409 },
        );
      }
    }

    await saveUserAction(body.filename, body.content);
    return NextResponse.json({ success: true, filename: body.filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { filename: string };

    if (!body.filename) {
      return NextResponse.json({ error: "filename is required" }, { status: 400 });
    }

    await deleteUserAction(body.filename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
