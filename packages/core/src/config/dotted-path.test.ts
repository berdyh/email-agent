import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UnsafeConfigPathError,
  getNestedConfigValue,
  setNestedConfigValue,
} from "./dotted-path.js";

describe("dotted config paths refuse the prototype chain", () => {
  const segments = ["__proto__", "constructor", "prototype"];

  it("refuses each reserved segment in an interior position", () => {
    for (const segment of segments) {
      const target: Record<string, unknown> = {};
      assert.throws(
        () => setNestedConfigValue(target, `${segment}.polluted`, true),
        (err: unknown) =>
          err instanceof UnsafeConfigPathError && err.segment === segment,
        `${segment} must be refused`,
      );
      // Nothing global was touched, and nothing was written to the target.
      assert.equal(
        ({} as Record<string, unknown>)["polluted"],
        undefined,
        `${segment} leaked onto every object`,
      );
      assert.deepEqual(Object.keys(target), []);
    }
  });

  it("refuses each reserved segment in the terminal position", () => {
    // A terminal `__proto__` assignment sets the object's prototype rather
    // than binding a property, so it is refused too.
    for (const segment of segments) {
      const target: Record<string, unknown> = {};
      assert.throws(
        () => setNestedConfigValue(target, `gmail.${segment}`, { polluted: true }),
        (err: unknown) =>
          err instanceof UnsafeConfigPathError && err.segment === segment,
      );
      assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    }
  });

  it("refuses a reserved segment buried mid-path", () => {
    assert.throws(
      () => setNestedConfigValue({}, "a.b.constructor.c.d", 1),
      (err: unknown) =>
        err instanceof UnsafeConfigPathError && err.segment === "constructor",
    );
  });

  it("refuses the same segments on read", () => {
    for (const segment of segments) {
      assert.throws(
        () => getNestedConfigValue({ gmail: {} }, `${segment}.autoApplyActions`),
        UnsafeConfigPathError,
      );
    }
  });

  it("leaves the object untouched when it refuses a write", () => {
    const target: Record<string, unknown> = { ui: { fetchScope: "unread" } };
    assert.throws(() => setNestedConfigValue(target, "ui.__proto__.x", 1));
    assert.deepEqual(target, { ui: { fetchScope: "unread" } });
  });
});

describe("dotted config paths still do the ordinary job", () => {
  it("reads and writes nested keys", () => {
    const target: Record<string, unknown> = { ui: { fetchScope: "unread" } };
    setNestedConfigValue(target, "ui.fetchScope", "all");
    setNestedConfigValue(target, "ui.fetchInterval", 15);
    assert.deepEqual(target["ui"], { fetchScope: "all", fetchInterval: 15 });
    assert.equal(getNestedConfigValue(target, "ui.fetchScope"), "all");
  });

  it("creates missing intermediate objects", () => {
    const target: Record<string, unknown> = {};
    setNestedConfigValue(target, "retention.approvalQueueDays", 0);
    assert.deepEqual(target, { retention: { approvalQueueDays: 0 } });
  });

  it("replaces a null intermediate instead of walking into it", () => {
    // `typeof null === "object"`, so the naive check this replaces walked into
    // null and threw a TypeError from the assignment.
    const target: Record<string, unknown> = { retention: null };
    setNestedConfigValue(target, "retention.approvalQueueDays", 7);
    assert.deepEqual(target, { retention: { approvalQueueDays: 7 } });
  });

  it("writes a top-level key", () => {
    const target: Record<string, unknown> = {};
    setNestedConfigValue(target, "dataDir", "/tmp/data");
    assert.equal(target["dataDir"], "/tmp/data");
  });

  it("returns undefined for a path that does not exist", () => {
    assert.equal(getNestedConfigValue({ ui: {} }, "ui.nope"), undefined);
    assert.equal(getNestedConfigValue({ ui: {} }, "nope.deeper"), undefined);
  });
});
