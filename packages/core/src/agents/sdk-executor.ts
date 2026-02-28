import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentExecutor,
  AgentRequest,
  AgentResult,
  AgentStreamChunk,
} from "./types.js";

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
      },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        text = message.result;
        tokensUsed =
          (message.usage.output_tokens ?? 0) +
          (message.usage.input_tokens ?? 0);
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
        yield { text: "", done: true };
      }
    }
  }
}
