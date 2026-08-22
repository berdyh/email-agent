/**
 * `email-agent unlock` through the BUILT binary, and the cross-process property
 * the whole storage decision rests on.
 *
 * The unlock mechanism could have been two environment variables handed to the
 * Next child at spawn time — tidier, nothing on disk, nothing to chmod. It is a
 * file instead for one reason: `unlock` has to mint a link that a server which
 * is ALREADY RUNNING will accept, and no process can inject an environment
 * variable into a running child. That claim is only worth making if it is
 * observed, so the redemption below happens in a SEPARATE node process from the
 * one that minted — standing in for the web server, which is a separate process
 * for real.
 *
 * NOT COVERED here: an actual browser, an actual Next server, and the cookie
 * round trip. Those need the unlock page, which is the next wave's; this file
 * covers everything up to the value the page will POST.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const execFileAsync = promisify(execFile);

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CORE_ENTRY = pathToFileURL(join(PACKAGES, "core", "dist", "index.js")).href;

const cli = await startCli("unlock");
const storePath = join(cli.home, ".email-agent", "session.json");

const LINK = /http:\/\/(\[[^\]]+\]|[^:\/\s]+):(\d+)\/unlock\?exchange=1#token=([A-Za-z0-9_-]+)/;

function linkFrom(output: string): RegExpMatchArray {
  const match = output.match(LINK);
  assert.ok(match, `no unlock link in output:\n${output}`);
  return match;
}

/**
 * Runs `expression` in a fresh node process whose `$HOME` is the harness's, and
 * returns its JSON result. This is the stand-in for the web server: a different
 * process, reaching the same store through the same public core barrel.
 */
async function inServerProcess(expression: string): Promise<unknown> {
  const script =
    `const core = await import(${JSON.stringify(CORE_ENTRY)});` +
    `process.stdout.write(JSON.stringify(${expression}));`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, HOME: cli.home, USERPROFILE: cli.home }, cwd: PACKAGES },
  );
  return JSON.parse(stdout) as unknown;
}

describe("email-agent unlock", () => {
  it("prints a usable link without starting or touching a server", async () => {
    const result = await cli.run(["unlock"]);

    assert.equal(result.exitCode, 0);
    const [, host, port, token] = linkFrom(result.output);
    assert.equal(host, "127.0.0.1");
    assert.equal(port, "3847");
    // 32 random bytes, base64url, unpadded.
    assert.equal(token?.length, 43);
    assert.match(result.output, /ONCE/);
    assert.match(result.output, /10 minutes/);
  });

  it("honours --host and --port, bracketing an IPv6 address", async () => {
    const result = await cli.run(["unlock", "--host", "::1", "--port", "9123"]);

    const [, host, port] = linkFrom(result.output);
    assert.equal(host, "[::1]");
    assert.equal(port, "9123");
  });

  it("writes only the digest, in a 0600 file", async () => {
    const result = await cli.run(["unlock"]);
    const [, , , token] = linkFrom(result.output);
    assert.ok(token);

    const raw = await readFile(storePath, "utf-8");
    const store = JSON.parse(raw) as { unlock: { tokenHash: string } };

    assert.equal(raw.includes(token), false, "the plaintext token must never be persisted");
    assert.equal(store.unlock.tokenHash, createHash("sha256").update(token).digest("hex"));
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  });

  it("mints a link a DIFFERENT, already-running process can redeem exactly once", async () => {
    const [, , , token] = linkFrom((await cli.run(["unlock"])).output);

    const first = (await inServerProcess(
      `core.exchangeUnlockToken(${JSON.stringify(token)})`,
    )) as { ok: boolean; sessionToken?: string };
    assert.equal(first.ok, true);
    assert.ok(first.sessionToken);

    const replay = (await inServerProcess(
      `core.exchangeUnlockToken(${JSON.stringify(token)})`,
    )) as { ok: boolean; reason?: string };
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "used");

    const valid = await inServerProcess(
      `core.hasValidSession(${JSON.stringify(first.sessionToken)})`,
    );
    assert.equal(valid, true);
  });

  it("does not log out a browser that is already unlocked", async () => {
    // The reason someone runs this command is that they lost a link, not that
    // they want every open tab logged out.
    const [, , , token] = linkFrom((await cli.run(["unlock"])).output);
    const exchanged = (await inServerProcess(
      `core.exchangeUnlockToken(${JSON.stringify(token)})`,
    )) as { ok: boolean; sessionToken: string };
    assert.equal(exchanged.ok, true);

    await cli.run(["unlock"]);

    const stillValid = await inServerProcess(
      `core.hasValidSession(${JSON.stringify(exchanged.sessionToken)})`,
    );
    assert.equal(stillValid, true);
  });

  it("invalidates the previous link when a new one is printed", async () => {
    const [, , , stale] = linkFrom((await cli.run(["unlock"])).output);
    await cli.run(["unlock"]);

    const result = (await inServerProcess(
      `core.exchangeUnlockToken(${JSON.stringify(stale)})`,
    )) as { ok: boolean; reason?: string };

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid");
  });

  it("is registered on the real program, with help a user can find", async () => {
    const help = await cli.run(["--help"]);

    assert.match(help.output, /\bunlock\b/);
  });
});
