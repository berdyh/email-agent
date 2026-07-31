import { test } from "node:test";
import assert from "node:assert/strict";
import { apiExecutorOrder } from "./router.js";

test("direct-api mode executor order", async (t) => {
  await t.test("defaults to direct-api first, openrouter fallback", () => {
    assert.deepEqual(apiExecutorOrder("claude"), ["direct-api", "openrouter"]);
    assert.deepEqual(apiExecutorOrder("direct-api"), [
      "direct-api",
      "openrouter",
    ]);
  });

  await t.test("prefers openrouter when it is the preferred agent", () => {
    assert.deepEqual(apiExecutorOrder("openrouter"), [
      "openrouter",
      "direct-api",
    ]);
  });
});
