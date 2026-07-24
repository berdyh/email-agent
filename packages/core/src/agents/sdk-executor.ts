import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentExecutor,
  AgentRequest,
  AgentResult,
  AgentStreamChunk,
} from "./types.js";

/** Bridge an AbortSignal into the AbortController the SDK expects. */
function toAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  return controller;
}

export class SdkExecutor implements AgentExecutor {
  readonly id = "claude-sdk" as const;

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env["ANTHROPIC_API_KEY"]);
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();
    let text = "";
    let tokensUsed = 0;

    for await (const message of query({
      prompt: request.prompt,
      options: {
        model: "claude-sonnet-4-6",
        systemPrompt: request.systemPrompt,
        maxTurns: 1,
        permissionMode: "plan",
        abortController: toAbortController(request.signal),
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          text = message.result;
          tokensUsed =
            (message.usage.output_tokens ?? 0) +
            (message.usage.input_tokens ?? 0);
        } else {
          // Non-success subtypes (max turns, budget, execution error) must not
          // be persisted as an empty successful result — surface them instead.
          const detail = message.errors?.length
            ? `: ${message.errors.join("; ")}`
            : "";
          throw new Error(
            `Claude SDK returned non-success result "${message.subtype}"${detail}`,
          );
        }
      }
    }

    return {
      text,
      agentUsed: "claude-sdk",
      tokensUsed,
      durationMs: Date.now() - start,
    };
  }

  async *executeStream(request: AgentRequest): AsyncGenerator<AgentStreamChunk> {
    for await (const message of query({
      prompt: request.prompt,
      options: {
        model: "claude-sonnet-4-6",
        systemPrompt: request.systemPrompt,
        maxTurns: 1,
        permissionMode: "plan",
        includePartialMessages: true,
        abortController: toAbortController(request.signal),
      },
    })) {
      if (message.type === "stream_event") {
        const event = message.event as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          yield { text: event.delta.text, done: false };
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          const detail = message.errors?.length
            ? `: ${message.errors.join("; ")}`
            : "";
          throw new Error(
            `Claude SDK returned non-success result "${message.subtype}"${detail}`,
          );
        }
        yield { text: "", done: true };
      }
    }
  }
}
