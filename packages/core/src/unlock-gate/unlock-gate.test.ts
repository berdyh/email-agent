/**
 * The gate's off-switch and the warning that a disarmed gate is disarmed.
 *
 * THE BUG THIS EXISTS FOR, measured live and not reconstructed: a repo-root
 * `.env` containing only `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — never typed
 * into a shell, and reachable by uncommenting one line of `.env.example` — is
 * loaded into the web process by `packages/web/next.config.ts` before Next
 * boots. Under a real `next dev` that turned off the local-origin header
 * checks, the API session requirement AND the page gate at once, and NOTHING
 * said so: `packages/cli/src/commands/serve.ts` was the only place in the repo
 * that mentioned the flag, and `npm run dev`/`npm run start` never reach it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import {
  isUnlockGateEnabled,
  UNLOCK_GATE_DISABLED_LINES,
  warnIfUnlockGateDisabled,
} from "./index.js";

describe("the gate's one and only off switch", () => {
  it("treats the existing remote-mutations flag as the whole switch", () => {
    assert.equal(isUnlockGateEnabled({}), true);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }), false);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "0" }), true);
  });

  it("reads exactly one environment variable, and no other", () => {
    // The other half of `session.test.ts`'s "reads no environment variable at
    // all": the store reads none, this module reads precisely the pre-existing
    // disarming flag. A second one here would be a new way to arm or disarm the
    // gate from a file nobody typed into.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    const reads = [...source.matchAll(/env\["([A-Z_]+)"\]/g)].map((m) => m[1]);

    assert.deepEqual([...new Set(reads)], ["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"]);
  });

  it("imports no node: builtin, so the Next instrumentation bundle can carry it", () => {
    // LOAD-BEARING, and measured: `packages/web/src/instrumentation.ts` is
    // compiled for the EDGE runtime as well as the node one, and webpack traces
    // its dynamic import chain in both. A chain reaching `config/session.ts`
    // (which imports `node:crypto` and `node:fs`) made every `next dev` start
    // print `⨯ node:crypto / Module build failed: UnhandledSchemeError`, and a
    // `NEXT_RUNTIME` early return did not prevent it — webpack traces the
    // import whatever the branch does at runtime. This assertion is the only
    // thing standing between that and a future convenience import.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    const imports = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((m) => m[1]);

    assert.deepEqual(imports, []);
    // Anchored to real import syntax, static and dynamic. An unanchored
    // /node:/ scan matches this module's own header, which QUOTES the webpack
    // error it exists to prevent.
    assert.doesNotMatch(source, /^\s*import\b[^\n]*"node:/m);
    assert.doesNotMatch(source, /\bimport\(\s*"node:/);
  });
});

describe("announcing a disarmed gate", () => {
  // The measured failure: a repo-root `.env` carrying
  // `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — never typed into a shell, copied
  // from the commented line in `.env.example` — disarmed the header checks, the
  // session requirement and the page gate for `npm run dev`/`npm run start`,
  // and NOTHING said so: `commands/serve.ts` was the only place in the repo
  // that printed a word about it, and neither script goes near it.
  const WARNED = Symbol.for("email-agent.unlock-gate-disabled-warned");

  function resetWarned(): void {
    delete (globalThis as Record<symbol, unknown>)[WARNED];
  }

  beforeEach(resetWarned);

  const OFF = { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" };

  it("warns when the flag is set, and says where an untyped one came from", () => {
    const lines: string[] = [];

    assert.equal(warnIfUnlockGateDisabled(OFF, (m) => lines.push(m)), true);

    const printed = lines.join("\n");
    assert.match(printed, /EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1/);
    // Naming the .env is the point, not decoration: a user who never typed the
    // variable has nowhere else to look.
    assert.match(printed, /\.env/);
    assert.match(printed, /next\.config\.ts/);
    // And it must say what was lost, or it is a notice rather than a warning.
    assert.match(printed, /read your mail/);
  });

  it("says nothing at all when the gate is on", () => {
    const lines: string[] = [];

    assert.equal(warnIfUnlockGateDisabled({}, (m) => lines.push(m)), false);
    assert.equal(warnIfUnlockGateDisabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "0" }, (m) => lines.push(m)), false);

    assert.deepEqual(lines, []);
    // Nothing is marked either, so a flag flipped later still announces.
    assert.equal((globalThis as Record<symbol, unknown>)[WARNED], undefined);
  });

  it("warns ONCE, however many times the flag is observed", () => {
    // Every guarded request reads this flag. Warning per read would be a log
    // line per request, which is how a real warning becomes invisible.
    const lines: string[] = [];

    assert.equal(warnIfUnlockGateDisabled(OFF, (m) => lines.push(m)), true);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(warnIfUnlockGateDisabled(OFF, (m) => lines.push(m)), false);
    }

    assert.equal(lines.length, 1);
  });

  it("keeps the once-flag on globalThis, so DUPLICATE MODULE COPIES agree", async () => {
    // Not a hypothetical: AGENTS.md records, measured from a production build,
    // that Next does not guarantee one module instance per process — the auth
    // callback route carries its own inlined copy of `config/defaults.ts` +
    // `config/settings.ts`. A module-level `let printed = false` would live
    // once per copy and warn once per copy. `?copy=2` gives node a genuinely
    // second instance of this exact module, which is the same situation.
    // The specifier is ASSEMBLED rather than written as a literal on purpose:
    // node treats a distinct query string as a distinct module (verified under
    // tsx, which keeps the query while mapping `.js` to `.ts`), but tsc tries
    // to RESOLVE a literal specifier and fails with TS2307 on the query.
    const secondCopy = `./index.js?copy=${2}`;
    const second = (await import(secondCopy)) as {
      warnIfUnlockGateDisabled: typeof warnIfUnlockGateDisabled;
    };
    assert.notEqual(second.warnIfUnlockGateDisabled, warnIfUnlockGateDisabled);
    const lines: string[] = [];

    assert.equal(warnIfUnlockGateDisabled(OFF, (m) => lines.push(m)), true);
    assert.equal(second.warnIfUnlockGateDisabled(OFF, (m) => lines.push(m)), false);

    assert.equal(lines.length, 1);
    assert.equal((globalThis as Record<symbol, unknown>)[WARNED], true);
  });

  it("exports the wording once, for the CLI and the web process to share", () => {
    // `serve` prints this block from the parent and the web child prints it
    // again. Two hand-written descriptions of one flag would read as two
    // problems; the same sentences twice read as one.
    assert.ok(UNLOCK_GATE_DISABLED_LINES.length > 0);
    for (const line of UNLOCK_GATE_DISABLED_LINES) {
      assert.equal(typeof line, "string");
    }
    const lines: string[] = [];
    warnIfUnlockGateDisabled(OFF, (m) => lines.push(m));

    for (const line of UNLOCK_GATE_DISABLED_LINES) {
      assert.ok(lines[0]?.includes(line), `missing from the warning: ${line}`);
    }
  });
});
