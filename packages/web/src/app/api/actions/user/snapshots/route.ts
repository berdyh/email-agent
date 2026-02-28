import { NextResponse, type NextRequest } from "next/server";
import { listSnapshots, restoreSnapshot } from "@email-agent/core/actions";

export async function GET(request: NextRequest) {
  try {
    const filename = request.nextUrl.searchParams.get("filename");
    if (!filename) {
      return NextResponse.json({ error: "filename query param is required" }, { status: 400 });
    }

    const snapshots = await listSnapshots(filename);
    return NextResponse.json(snapshots);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { snapshotFilename: string; originalFilename: string };

    if (!body.snapshotFilename || !body.originalFilename) {
      return NextResponse.json(
        { error: "snapshotFilename and originalFilename are required" },
        { status: 400 },
      );
    }

    await restoreSnapshot(body.snapshotFilename, body.originalFilename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
