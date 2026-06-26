import { type NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentRouter } from "@email-agent/core/agents";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseActionGenerateRequest,
  validationResponse,
} from "@/modules/api/validation";

const router = new AgentRouter();

// Cache skills docs in memory after first load
let skillsCache: string | null = null;
let editSkillsCache: string | null = null;

async function loadSkills(): Promise<string> {
  if (!skillsCache) {
    const skillsPath = join(process.cwd(), "..", "..", "CREATE_ACTION_SKILLS.md");
    skillsCache = await readFile(skillsPath, "utf-8");
  }
  return skillsCache;
}

async function loadEditSkills(): Promise<string> {
  if (!editSkillsCache) {
    const editPath = join(process.cwd(), "..", "..", "EDIT_ACTION_SKILLS.md");
    editSkillsCache = await readFile(editPath, "utf-8");
  }
  return editSkillsCache;
}

const encoder = new TextEncoder();

function sseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseActionGenerateRequest(await request.json());

    // Build system prompt based on mode
    let systemPrompt: string;
    if (body.mode === "edit") {
      const editSkills = await loadEditSkills();
      systemPrompt = editSkills;
      if (body.currentCode) {
        systemPrompt +=
          "\n\n## Current Action Code\n\n```typescript\n" +
          body.currentCode +
          "\n```";
      }
    } else {
      systemPrompt = await loadSkills();
    }

    // Flatten conversation into a single prompt
    const conversationText = body.messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    try {
      const result = await router.execute({
        prompt: conversationText,
        systemPrompt,
        signal: request.signal,
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(sseEvent("chunk", { text: result.text }));
          controller.enqueue(sseEvent("done", { message: result.text }));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (err) {
      console.error(err);
      return new Response(
        JSON.stringify({ error: "Failed to generate action" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to generate action");
  }
}
