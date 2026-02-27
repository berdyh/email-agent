import { NextResponse } from "next/server";
import { clusterEmails } from "@gmail-reader/core/analysis";

export async function POST() {
  try {
    const clusters = await clusterEmails();
    return NextResponse.json(clusters);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
