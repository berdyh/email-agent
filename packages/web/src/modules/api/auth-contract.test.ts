/**
 * The one thing that keeps `auth-contract.ts`'s core-free duplicate of
 * `UNLOCK_REQUIRED_CODE` honest: it is a literal string in TWO files (core's
 * session store, and this client-safe contract), because the client-side code
 * that needs it cannot import core's config barrel (`node:fs`/`node:crypto`
 * do not bundle for the browser). A duplicate string is only safe if
 * something proves it cannot drift — this is that something.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    // EVERY case names the recovery command, the rate limit included. That is
    // a change: this test used to assert the opposite for `rate-limited`, on
    // the reasoning that minting while the window was hot could not help. It
    // could not, and that was the defect — `mintUnlockToken()` now clears the
    // failure window, so the command really is the way out, and a message that
    // says only "wait" sends the user away from it for up to fifteen minutes.
    for (const code of codes) {
      assert.match(describeUnlockExchangeError(code), /email-agent unlock/);
    }
  });

  it("has the route answer 429 with the shared copy, not a literal of its own", async () => {
    // The route hand-wrote its own "too many attempts" sentence, so the JSON
    // `error` and the unlock page's rendering of the same code could drift —
    // exactly what this contract module exists to prevent. Pinned by reading
    // the route source: invoking the handler for real would need an exhausted
    // rate-limit window in a temp `$HOME`, which `unlock.route.test.ts`
    // already covers end to end for the status and the code.
    const source = await readFile(
      new URL("../../app/api/auth/unlock/route.ts", import.meta.url),
      "utf-8",
    );
    assert.doesNotMatch(source, /Too many attempts/);
    assert.match(source, /describeUnlockExchangeError\("rate-limited"\)/);
  });
});
