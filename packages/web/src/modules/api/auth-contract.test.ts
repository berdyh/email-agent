/**
 * The one thing that keeps `auth-contract.ts`'s core-free duplicate of
 * `UNLOCK_REQUIRED_CODE` honest: it is a literal string in TWO files (core's
 * session store, and this client-safe contract), because the client-side code
 * that needs it cannot import core's config barrel (`node:fs`/`node:crypto`
 * do not bundle for the browser). A duplicate string is only safe if
 * something proves it cannot drift — this is that something.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNLOCK_REQUIRED_CODE as coreCode } from "@email-agent/core/config";
import {
  describeUnlockExchangeError,
  UNLOCK_REQUIRED_CODE as webCode,
  unlockExchangeErrorCode,
} from "./auth-contract.js";

describe("auth-contract", () => {
  it("keeps the client-side unlock-required code equal to core's", () => {
    assert.equal(webCode, coreCode);
  });

  it("maps every core exchange-failure reason onto a wire code", () => {
    assert.equal(unlockExchangeErrorCode("invalid"), "invalid-token");
    assert.equal(unlockExchangeErrorCode("expired"), "token-expired");
    assert.equal(unlockExchangeErrorCode("used"), "token-already-used");
    assert.equal(unlockExchangeErrorCode("rate-limited"), "rate-limited");
  });

  it("gives every wire code a non-empty, distinct message naming the recovery command", () => {
    const codes: Array<Parameters<typeof describeUnlockExchangeError>[0]> = [
      "invalid-token",
      "token-expired",
      "token-already-used",
      "rate-limited",
    ];
    const messages = codes.map(describeUnlockExchangeError);
    for (const message of messages) {
      assert.ok(message.length > 0);
    }
    assert.equal(new Set(messages).size, messages.length);
    // Every case but the rate-limit tells the user how to get back in — the
    // rate limit specifically should NOT, since minting another token while
    // rate-limited would not help and would just invite another attempt.
    for (const code of ["invalid-token", "token-expired", "token-already-used"] as const) {
      assert.match(describeUnlockExchangeError(code), /email-agent unlock/);
    }
  });
});
