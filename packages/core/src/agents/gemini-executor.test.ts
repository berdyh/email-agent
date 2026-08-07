import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeGeminiAuthFailure,
  geminiCredentialSource,
  isGeminiAuthFailure,
  parseGeminiOutput,
} from "./gemini-executor.js";

/**
 * The gemini CLI on this machine is installed but unauthenticated (it demands
 * an interactive browser OAuth flow), so no live run has ever exercised the
 * execute path. These fixtures are built from the shapes read out of the
 * installed `@google/gemini-cli` 0.54.0 package itself — its `JsonFormatter`,
 * its `uiTelemetry` metrics initialiser, and its shipped `docs/cli/headless.md`
 * — not from a live invocation. See TODOS.md for what that does and does not
 * establish.
 */
describe("parseGeminiOutput", () => {
  it("reads tokens from stats.models[*].tokens.total", () => {
    const stdout = JSON.stringify({
      session_id: "s1",
      response: "pong",
      stats: {
        models: {
          "gemini-2.5-pro": {
            api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 900 },
            tokens: {
              input: 12,
              prompt: 12,
              candidates: 5,
              total: 17,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
        },
        tools: { totalCalls: 0 },
      },
    });

    const result = parseGeminiOutput(stdout);
    assert.equal(result.text, "pong");
    assert.equal(result.tokensUsed, 17);
  });

  it("sums totals across models when a session touches more than one", () => {
    const stdout = JSON.stringify({
      response: "ok",
      stats: {
        models: {
          "gemini-2.5-pro": { tokens: { total: 100 } },
          "gemini-2.5-flash": { tokens: { total: 40 } },
        },
      },
    });
    assert.equal(parseGeminiOutput(stdout).tokensUsed, 140);
  });

  it("does not read the nonexistent stats.totalTokenCount field", () => {
    // Regression guard: the previous parser read `stats.totalTokenCount`, which
    // the CLI never emits, so every gemini run recorded 0 tokens. A fixture
    // carrying ONLY that camelCase field must still yield 0 — and the real
    // snake_case shape above must yield a real number.
    const stdout = JSON.stringify({
      response: "pong",
      stats: { totalTokenCount: 999 },
    });
    assert.equal(parseGeminiOutput(stdout).tokensUsed, 0);
  });

  it("falls back to a raw usageMetadata.totalTokenCount body", () => {
    const stdout = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { totalTokenCount: 55 },
    });
    const result = parseGeminiOutput(stdout);
    assert.equal(result.text, "hi");
    assert.equal(result.tokensUsed, 55);
  });

  it("throws on the CLI's error envelope instead of returning empty text", () => {
    // JsonFormatter.formatError() emits `error` with no `response`; returning
    // "" here would persist a failed run as a successful empty answer.
    const stdout = JSON.stringify({
      session_id: "s1",
      error: { type: "ApiError", message: "quota exceeded", code: "429" },
    });
    assert.throws(() => parseGeminiOutput(stdout), /quota exceeded/);
  });

  it("treats non-JSON output as plain text", () => {
    const result = parseGeminiOutput("  plain answer  ");
    assert.equal(result.text, "plain answer");
    assert.equal(result.tokensUsed, 0);
  });

  it("returns empty text and zero tokens when stats are absent", () => {
    const result = parseGeminiOutput(JSON.stringify({ response: "hey" }));
    assert.equal(result.text, "hey");
    assert.equal(result.tokensUsed, 0);
  });
});

// ---------------------------------------------------------------------------
// Availability: "can it run a prompt?", not "is the binary there?"
// ---------------------------------------------------------------------------
//
// `isAvailable()` used to probe `--version`, so on this machine — gemini 0.54.4
// installed, never signed in — it answered TRUE. `AgentRouter` then picked
// gemini as a fallback, the CLI opened an interactive browser OAuth prompt and
// blocked until the 120s `execFile` timeout killed it. One dead agent run per
// attempt, reported as a timeout. That is the state of every fresh install.
//
// The credential locations below were read out of the INSTALLED package
// (`@google/gemini-cli` 0.54.4, 2026-08-07): `getApiKeyFromEnv()` for the two
// key variables, `fetchCachedCredentialsList()` for
// `<homedir>/.gemini/oauth_creds.json` and `GOOGLE_APPLICATION_CREDENTIALS`,
// and `getUseEncryptedStorageFlag()` for the keychain opt-in.

describe("geminiCredentialSource", () => {
  const noFiles = () => false;

  it("finds nothing when nothing is configured — the fresh-install case", () => {
    assert.equal(
      geminiCredentialSource({ env: {}, home: "/nowhere", fileExists: noFiles }),
      null,
    );
  });

  it("recognises each credential location the CLI actually reads", () => {
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [{ GOOGLE_API_KEY: "k" }, "GOOGLE_API_KEY"],
      [{ GEMINI_API_KEY: "k" }, "GEMINI_API_KEY"],
      [{ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json" }, "GOOGLE_APPLICATION_CREDENTIALS"],
      [
        { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p" },
        "Vertex AI (GOOGLE_CLOUD_PROJECT)",
      ],
      [{ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "true" }, "encrypted credential storage"],
    ];
    for (const [env, expected] of cases) {
      assert.equal(
        geminiCredentialSource({ env, home: "/nowhere", fileExists: noFiles }),
        expected,
      );
    }
  });

  it("finds the cached OAuth credentials file at the path the CLI composes", () => {
    const seen: string[] = [];
    const source = geminiCredentialSource({
      env: {},
      home: "/home/u",
      fileExists: (path) => {
        seen.push(path);
        return path === "/home/u/.gemini/oauth_creds.json";
      },
    });
    assert.equal(source, "~/.gemini/oauth_creds.json");
    assert.ok(seen.includes("/home/u/.gemini/oauth_creds.json"));
  });

  it("treats an empty or whitespace value as absent, not as a credential", () => {
    assert.equal(
      geminiCredentialSource({
        env: { GEMINI_API_KEY: "   ", GOOGLE_API_KEY: "" },
        home: "/nowhere",
        fileExists: noFiles,
      }),
      null,
    );
  });

  it("needs BOTH halves of the Vertex pair", () => {
    assert.equal(
      geminiCredentialSource({
        env: { GOOGLE_GENAI_USE_VERTEXAI: "true" },
        home: "/nowhere",
        fileExists: noFiles,
      }),
      null,
    );
  });
});

describe("the unauthenticated failure a run now gets", () => {
  it("recognises gemini's non-interactive auth refusal", () => {
    // The exact text observed live from `NO_BROWSER=1 gemini -p ... ` on an
    // unauthenticated install (2026-08-07, exit code 41, ~2s).
    const observed =
      "Error authenticating: FatalAuthenticationError: Manual authorization is required " +
      "but the current session is non-interactive. Please run the Gemini CLI in an " +
      "interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application " +
      "Default Credentials are configured.";
    assert.equal(isGeminiAuthFailure(observed), true);
  });

  it("does not swallow an unrelated failure as an auth problem", () => {
    assert.equal(isGeminiAuthFailure("Error: connect ECONNREFUSED"), false);
    assert.equal(isGeminiAuthFailure("gemini returned an error: quota exceeded"), false);
  });

  it("names the fix, which the CLI's own message cannot", () => {
    // gemini says "run the Gemini CLI in an interactive terminal" — true, and
    // not something this process can do on the user's behalf. The message has
    // to say which command and which variable.
    const message = describeGeminiAuthFailure("FatalAuthenticationError: ...");
    assert.match(message, /installed but not authenticated/);
    assert.match(message, /GEMINI_API_KEY/);
    assert.match(message, /Original error/);
  });
});
