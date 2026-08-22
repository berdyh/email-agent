/**
 * The web process announcing that its unlock gate has been switched off.
 *
 * THE BUG THIS PINS, measured live and not reconstructed: a repo-root `.env`
 * containing only `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — never typed into a
 * shell, and reachable by uncommenting one line of `.env.example` — is loaded
 * into the web process by `packages/web/next.config.ts` before Next boots.
 * Under a real `next dev` that turned off the local-origin header checks, the
 * API session requirement AND the page gate at once: unauthenticated
 * `GET /api/settings` answered 200 with the settings body, `GET /mail` answered
 * 200 with no redirect, a `Host: evil.example` request with neither `Origin`
 * nor `Sec-Fetch-Site` reached the handler, and grepping the server log for any
 * warning found NOTHING. `packages/cli/src/commands/serve.ts` was the only
 * place in the repo that mentioned the flag, and `npm run dev`/`npm run start`
 * never reach it.
 *
 * WHAT IS AND IS NOT COVERED HERE. Both observation points are driven for real:
 * `register()` out of `src/instrumentation.ts` (startup) and `isSessionUnlocked`
 * (the request path). What no test in this repo can cover is that NEXT ITSELF
 * calls `register()` — that is Next's contract with the file's location, not
 * behaviour of ours; the guard-path announcement is deliberately a second,
 * independent route to the same warning for exactly that reason.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, it } from "node:test";

import { registerWebModuleAliases } from "./testing/route-harness.js";

registerWebModuleAliases();

const { useTempHome } = await import("@email-agent/core/testing");
await useTempHome("unlock-gate-warning");

const validation = await import("@/modules/api/validation");
const notice = await import("@/modules/api/unlock-gate-notice");
const instrumentation = await import("../../instrumentation.js");

/** The once-per-process marker the core primitive sets. */
const WARNED = Symbol.for("email-agent.unlock-gate-disabled-warned");

const FLAG = "EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS";

function reset(): void {
  delete (globalThis as Record<symbol, unknown>)[WARNED];
  delete process.env[FLAG];
}

/** Runs `body` with the escape hatch set, capturing everything it warns. */
function captureWarnings(body: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return (async () => {
    try {
      await body();
    } finally {
      console.warn = original;
    }
    return lines;
  })();
}

beforeEach(reset);

describe("announcing a disarmed unlock gate from the web process", () => {
  it("warns at startup, through the instrumentation hook", async () => {
    process.env[FLAG] = "1";

    const lines = await captureWarnings(async () => {
      process.env["NEXT_RUNTIME"] = "nodejs";
      await instrumentation.register();
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /unlock gate is OFF/);
    assert.match(lines[0] ?? "", new RegExp(`${FLAG}=1`));
    // The measured way in is a file, not a shell — say where to look.
    assert.match(lines[0] ?? "", /\.env/);
  });

  it("stays silent at startup when the gate is armed", async () => {
    const lines = await captureWarnings(async () => {
      process.env["NEXT_RUNTIME"] = "nodejs";
      await instrumentation.register();
    });

    assert.deepEqual(lines, []);
  });

  it("does nothing outside the nodejs runtime", async () => {
    // `register()` runs in whichever runtime Next is booting. The import it
    // makes reaches `@email-agent/core/config`, which pulls `node:fs` and
    // `node:crypto` at module load — nothing an edge bundle should carry for a
    // warning it has nothing to warn about.
    process.env[FLAG] = "1";

    const lines = await captureWarnings(async () => {
      process.env["NEXT_RUNTIME"] = "edge";
      await instrumentation.register();
    });

    assert.deepEqual(lines, []);
    assert.equal((globalThis as Record<symbol, unknown>)[WARNED], undefined);
  });

  it("warns from the guard path too, so an observed flag is an announced flag", async () => {
    // `instrumentation.ts` depends on Next calling `register()`. This does not:
    // `isSessionUnlocked` is the predicate BOTH the API guards and the page
    // gate consult, and it is what actually lets an unauthenticated caller
    // through while the flag is set.
    process.env[FLAG] = "1";

    const lines = await captureWarnings(() => {
      assert.equal(validation.isSessionUnlocked(undefined), true);
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /unlock gate is OFF/);
  });

  it("warns ONCE across every observation point in the process", async () => {
    // The flag is read on every guarded request. A warning per read is a log
    // line per request, which is how a real warning becomes invisible — and
    // the startup hook and the guard path must not read as two problems.
    process.env[FLAG] = "1";

    const lines = await captureWarnings(async () => {
      process.env["NEXT_RUNTIME"] = "nodejs";
      await instrumentation.register();
      notice.reportUnlockGateState();
      for (let i = 0; i < 25; i += 1) validation.isSessionUnlocked(undefined);
    });

    assert.equal(lines.length, 1);
  });

  it("says nothing, and gates normally, while the flag is unset", async () => {
    const lines = await captureWarnings(() => {
      assert.equal(validation.isSessionUnlocked(undefined), false);
      assert.equal(validation.isSessionUnlocked("not-a-real-session"), false);
    });

    assert.deepEqual(lines, []);
  });

  it("routes EVERY read of the flag through the announcing helper", async () => {
    // The two silent reads this replaced were plain `process.env[...] === "1"`
    // comparisons inside `localRequestViolation` and `mutationHeaderViolation`.
    // A third one added later would disarm a guard without announcing it, so
    // the web package must not name the variable at all — core owns the name.
    const source = await readFile(new URL("./validation.ts", import.meta.url), "utf-8");

    assert.doesNotMatch(source, new RegExp(`process\\.env\\["${FLAG}"\\]`));
    assert.match(source, /function remoteAccessAllowed\(\): boolean \{\n {2}warnIfUnlockGateDisabled\(\);/);
  });

  it("keeps the hook at the path Next actually looks for", async () => {
    // `src/instrumentation.ts`, beside `src/app`. Nothing in this repo can
    // prove Next CALLS it; what CAN be pinned is that it is where Next looks,
    // that it is scoped to the nodejs runtime, and that it cannot throw a
    // server start away.
    const source = await readFile(new URL("../../instrumentation.ts", import.meta.url), "utf-8");

    assert.match(source, /export async function register\(\)/);
    assert.match(source, /if \(process\.env\.NEXT_RUNTIME !== "nodejs"\) return;/);
    assert.match(source, /catch \(err\)/);
  });

  it("keeps the hook's import chain free of node: builtins", async () => {
    // THE REGRESSION THIS PINS, measured against a real `next dev`: while the
    // hook imported `@/modules/api/validation` — which reaches core's config
    // barrel, which reaches `node:crypto`/`node:fs` — every start printed
    // `⨯ node:crypto  Module build failed: UnhandledSchemeError`, because Next
    // compiles instrumentation for the EDGE runtime too and webpack traces the
    // dynamic import there regardless of the `NEXT_RUNTIME` early return. The
    // notice module exists to be a clean chain; importing validation from here
    // again would silently bring the error back.
    const source = await readFile(new URL("../../instrumentation.ts", import.meta.url), "utf-8");

    assert.match(source, /import\("@\/modules\/api\/unlock-gate-notice"\)/);
    assert.doesNotMatch(source, /import\("@\/modules\/api\/validation"\)/);

    // And the notice module's own chain: one import, and it is the core module
    // that core's `unlock-gate.test.ts` proves has no `node:` import.
    const notice = await readFile(new URL("./unlock-gate-notice.ts", import.meta.url), "utf-8");
    const imports = [...notice.matchAll(/^import .*?from "(.+?)";$/gm)].map((m) => m[1]);

    assert.deepEqual(imports, ["@email-agent/core/unlock-gate"]);
  });
});
