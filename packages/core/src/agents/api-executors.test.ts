import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { DirectApiExecutor } from "./direct-api-executor.js";
import { OpenRouterExecutor } from "./openrouter-executor.js";

/**
 * The API executors have never made a live call, so the first real use would
 * also be the first test of request shape, error handling and abort
 * propagation. These tests drive them against a local `node:http` stub on an
 * ephemeral port via the base-URL override — no network, no API keys, no spend.
 *
 * What this does NOT establish: that the real providers accept this request
 * shape or return these error shapes. The stub asserts the shape we send
 * against the documented OpenAI chat-completions contract; it cannot validate
 * the contract itself. See TODOS.md.
 */

interface StubOptions {
  status?: number;
  body?: string;
  /** Delay before responding, so an abort can land mid-flight. */
  delayMs?: number;
  onRequest?: (body: unknown, headers: Record<string, unknown>) => void;
}

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

/** Start a stub chat-completions endpoint and return its base URL. */
async function startStub(options: StubOptions = {}): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* leave null — the shape assertions will fail loudly */
      }
      options.onRequest?.(parsed, req.headers as Record<string, unknown>);

      const send = () => {
        res.writeHead(options.status ?? 200, {
          "content-type": "application/json",
        });
        res.end(
          options.body ??
            JSON.stringify({
              id: "chatcmpl-stub",
              object: "chat.completion",
              created: 1,
              model: "stub-model",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "stub answer" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
              },
            }),
        );
      };

      if (options.delayMs) setTimeout(send, options.delayMs);
      else send();
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

describe("API executors against a stub server", () => {
  it("sends the documented chat-completions request shape", async () => {
    let seenBody: unknown;
    let seenHeaders: Record<string, unknown> = {};
    const baseURL = await startStub({
      onRequest: (body, headers) => {
        seenBody = body;
        seenHeaders = headers;
      },
    });

    const executor = new DirectApiExecutor({
      baseURL,
      apiKey: "test-key",
      model: "stub-model",
    });
    await executor.execute({
      prompt: "user question",
      systemPrompt: "system instruction",
      maxTokens: 256,
      temperature: 0.7,
    });

    const body = seenBody as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      temperature: number;
    };

    assert.equal(body.model, "stub-model");
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.7);
    // System prompt must be a leading system message, not concatenated in.
    assert.deepEqual(body.messages, [
      { role: "system", content: "system instruction" },
      { role: "user", content: "user question" },
    ]);
    assert.equal(seenHeaders["authorization"], "Bearer test-key");
  });

  it("omits the system message when no system prompt is given", async () => {
    let seenBody: unknown;
    const baseURL = await startStub({
      onRequest: (body) => {
        seenBody = body;
      },
    });

    await new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({
      prompt: "just a question",
    });

    const body = seenBody as { messages: Array<{ role: string }> };
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["user"],
    );
  });

  it("defaults temperature to 0.3 when unspecified", async () => {
    let seenBody: unknown;
    const baseURL = await startStub({
      onRequest: (body) => {
        seenBody = body;
      },
    });

    await new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({
      prompt: "q",
    });

    assert.equal((seenBody as { temperature: number }).temperature, 0.3);
  });

  it("maps a successful response to an AgentResult", async () => {
    const baseURL = await startStub();
    const result = await new DirectApiExecutor({
      baseURL,
      apiKey: "k",
    }).execute({ prompt: "q" });

    assert.equal(result.text, "stub answer");
    assert.equal(result.agentUsed, "direct-api");
    assert.equal(result.tokensUsed, 18); // provider total_tokens
    assert.ok(result.durationMs >= 0);
  });

  it("reports openrouter as its own agentUsed", async () => {
    const baseURL = await startStub();
    const result = await new OpenRouterExecutor({
      baseURL,
      apiKey: "k",
    }).execute({ prompt: "q" });

    assert.equal(result.agentUsed, "openrouter");
    assert.equal(result.text, "stub answer");
  });

  it("propagates an HTTP error instead of returning empty text", async () => {
    // 400 rather than 5xx: the SDK retries 5xx/429, which would slow the test
    // without changing what is being asserted.
    const baseURL = await startStub({
      status: 400,
      body: JSON.stringify({
        error: { message: "bad request from stub", type: "invalid_request" },
      }),
    });

    await assert.rejects(
      () => new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({ prompt: "q" }),
      /bad request from stub/,
    );
  });

  it("propagates a malformed response body as an error", async () => {
    const baseURL = await startStub({ body: "this is not json{" });

    await assert.rejects(() =>
      new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({ prompt: "q" }),
    );
  });

  it("surfaces a missing choices array as empty text, not a crash", async () => {
    const baseURL = await startStub({
      body: JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "stub-model",
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      }),
    });

    const result = await new DirectApiExecutor({
      baseURL,
      apiKey: "k",
    }).execute({ prompt: "q" });
    assert.equal(result.text, "");
    assert.equal(result.tokensUsed, 3);
  });

  it("reports zero tokens when the provider omits usage", async () => {
    const baseURL = await startStub({
      body: JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "stub-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
      }),
    });

    const result = await new DirectApiExecutor({
      baseURL,
      apiKey: "k",
    }).execute({ prompt: "q" });
    assert.equal(result.text, "hi");
    assert.equal(result.tokensUsed, 0);
  });

  it("propagates an abort signal to the in-flight request", async () => {
    const baseURL = await startStub({ delayMs: 5_000 });
    const controller = new AbortController();

    const pending = new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({
      prompt: "q",
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    // Must reject rather than hang until the stub's 5s delay elapses.
    await assert.rejects(() => pending);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const baseURL = await startStub({ delayMs: 5_000 });
    await assert.rejects(() =>
      new DirectApiExecutor({ baseURL, apiKey: "k" }).execute({
        prompt: "q",
        signal: AbortSignal.abort(),
      }),
    );
  });
});

describe("API executor availability", () => {
  it("reports available when an explicit apiKey is supplied", async () => {
    assert.equal(
      await new DirectApiExecutor({ apiKey: "k" }).isAvailable(),
      true,
    );
    assert.equal(
      await new OpenRouterExecutor({ apiKey: "k" }).isAvailable(),
      true,
    );
  });

  it("falls back to the environment when no apiKey is supplied", async () => {
    const saved = process.env["OPENROUTER_API_KEY"];
    try {
      delete process.env["OPENROUTER_API_KEY"];
      assert.equal(await new OpenRouterExecutor().isAvailable(), false);
      process.env["OPENROUTER_API_KEY"] = "from-env";
      assert.equal(await new OpenRouterExecutor().isAvailable(), true);
    } finally {
      if (saved === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = saved;
    }
  });
});
