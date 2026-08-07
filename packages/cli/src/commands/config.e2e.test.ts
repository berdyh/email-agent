// `config get` / `config set` through the BUILT binary.
//
// The point of this file is the third suite. `config/dotted-path.ts` has had
// `UNSAFE_PATH_SEGMENTS` and a full unit test since wave 4b, and no caller: the
// CLI kept its own private `getNestedValue`/`setNestedValue`, which refused
// nothing. A test of the guard therefore proved only that the guard existed,
// not that any command used it. This drives the real command.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const cli = await startCli("config");

const settingsPath = join(cli.home, ".email-agent", "settings.json");
const settings = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;

describe("email-agent config get/set", () => {
  it("reads a nested value by dotted path", async () => {
    const result = await cli.run(["config", "get", "ui.fetchScope"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /unread|all/);
  });

  it("writes one, and reports what was actually stored after normalization", async () => {
    const result = await cli.run(["config", "set", "ui.fetchScope", "all"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /ui\.fetchScope = all/);

    const stored = await settings();
    assert.equal((stored["ui"] as Record<string, unknown>)["fetchScope"], "all");
  });

  it("fails on a key that does not exist rather than printing undefined", async () => {
    const result = await cli.run(["config", "get", "nope.not.here"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /not found/);
  });
});

describe("config set refuses a prototype-chain path", () => {
  it("refuses `__proto__` in an interior position and writes nothing", async () => {
    const before = await settings();

    const result = await cli.run(["config", "set", "__proto__.polluted", "true"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /reserved path segment/);
    assert.match(result.output, /__proto__/);
    // REFUSED BY THE COMMAND, not by an uncaught throw somewhere downstream.
    // Without this the case passes even when the write itself is unguarded:
    // the read-back after `saveSettings` would throw instead, which is also a
    // non-zero exit carrying the same words. A stack trace means the guard was
    // reached too late to have prevented anything.
    assert.doesNotMatch(
      result.output,
      /UnsafeConfigPathError:|\n\s+at /,
      "the refusal must be handled and printed, not thrown through commander",
    );
    assert.deepEqual(
      await settings(),
      before,
      "the write is refused BEFORE the settings object is touched",
    );
  });

  it("refuses it in the TERMINAL position too, where it sets a prototype", async () => {
    // The end of the path is the easy one to miss: `obj.__proto__ = x` does not
    // bind a property, it replaces the prototype.
    const before = await settings();
    const result = await cli.run(["config", "set", "ui.__proto__", "true"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /reserved path segment/);
    assert.deepEqual(await settings(), before);
  });

  it("refuses `constructor` and `prototype` as well", async () => {
    for (const key of ["constructor.x", "ui.constructor", "ui.prototype.x"]) {
      const result = await cli.run(["config", "set", key, "true"]);
      assert.equal(result.exitCode, 1, `${key} must be refused`);
      assert.match(result.output, /reserved path segment/);
    }
  });

  it("refuses them on `config get` too — reading walks the same chain", async () => {
    const result = await cli.run(["config", "get", "__proto__"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /reserved path segment/);
  });
});

describe("config set still refuses the consent-gated keys outright", () => {
  it("will not arm auto-apply from a surface that cannot show the warnings", async () => {
    for (const key of ["gmail.autoApplyActions", "gmail.autoApplyAcknowledged"]) {
      const result = await cli.run(["config", "set", key, "true"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /cannot be set from the CLI/);
      assert.match(result.output, /Settings → Gmail/);
    }

    const stored = (await settings())["gmail"] as Record<string, unknown> | undefined;
    assert.notEqual(stored?.["autoApplyActions"], true);
    assert.notEqual(stored?.["autoApplyAcknowledged"], true);
  });
});
