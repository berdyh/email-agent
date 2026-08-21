import { NextResponse, type NextRequest } from "next/server";
import { loadSettings, saveSettings } from "@email-agent/core/config";
import {
  internalErrorResponse,
  mergeSettingsUpdate,
  mutationGuardResponse,
  parseJsonBody,
  parseSettingsUpdateRequest,
  readGuardResponse,
  sanitizeSettingsForResponse,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  // Secrets are stripped by `sanitizeSettingsForResponse`, but the response
  // still names every configured account, the GCP project and the data dir.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  try {
    const settings = await loadSettings();
    return NextResponse.json(sanitizeSettingsForResponse(settings));
  } catch (err) {
    return internalErrorResponse(err, "Failed to load settings");
  }
}

export async function PUT(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseSettingsUpdateRequest(await parseJsonBody(request));
    const current = await loadSettings();
    const merged = mergeSettingsUpdate(current, body);
    await saveSettings(merged);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to save settings");
  }
}
