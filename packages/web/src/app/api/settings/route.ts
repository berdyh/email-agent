import { NextResponse, type NextRequest } from "next/server";
import { loadSettings, saveSettings } from "@email-agent/core/config";
import type { AppConfig } from "@email-agent/core/config";

export async function GET() {
  try {
    const settings = await loadSettings();
    return NextResponse.json(settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<AppConfig>;
    const current = await loadSettings();
    const merged = { ...current, ...body };
    await saveSettings(merged);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
