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
import {
  BINDING_REQUIRED_CODE as coreBindingCode,
  SESSION_BINDING_HEADER as coreBindingHeader,
  UNLOCK_REQUIRED_CODE as coreCode,
} from "@email-agent/core/config";
import {
  BINDING_REQUIRED_CODE as webBindingCode,
  describeUnlockExchangeError,
  SESSION_BINDING_HEADER as webBindingHeader,
  SESSION_BINDING_STORAGE_KEY,
  UNLOCK_REQUIRED_CODE as webCode,
  extractUnlockToken,
  unlockExchangeErrorCode,
} from "./auth-contract.js";

describe("auth-contract", () => {
  it("keeps the client-side unlock-required code equal to core's", () => {
    assert.equal(webCode, coreCode);
  });

  it("keeps the second factor's header and code equal to core's", () => {
    // A drift in the HEADER is not cosmetic: the client would send a name the
    // guard never reads, and every request in the app would 401 with no way
    // for the user to tell why.
    assert.equal(webBindingHeader, coreBindingHeader);
    assert.equal(webBindingCode, coreBindingCode);
    // Distinct from the no-session code, because the two need different copy.
    assert.notEqual(webBindingCode, webCode);
    // Client-only, so it has no core counterpart to drift against — but it
    // must not accidentally be spelled as one of the wire values either.
    assert.notEqual(SESSION_BINDING_STORAGE_KEY, webBindingHeader);
  });

  it("maps every core exchange-failure reason onto a wire code", () => {
    assert.equal(unlockExchangeErrorCode("invalid"), "invalid-token");
    assert.equal(unlockExchangeErrorCode("expired"), "token-expired");
    assert.equal(unlockExchangeErrorCode("used"), "token-already-used");
    assert.equal(unlockExchangeErrorCode("rate-limited"), "rate-limited");
    assert.equal(unlockExchangeErrorCode("busy"), "store-busy");
  });

  it("gives every wire code a non-empty, distinct message naming the recovery command", () => {
    const codes: Array<Parameters<typeof describeUnlockExchangeError>[0]> = [
      "invalid-token",
      "token-expired",
      "token-already-used",
      "rate-limited",
      "store-busy",
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
    // EVERY code EXCEPT `store-busy` names it. That one is the deliberate
    // exception rather than an oversight: contention leaves the user's link
    // completely unspent, so telling them to mint a replacement would send them
    // to burn a working credential over a condition that clears itself. It has
    // to say "try again" instead, and a test that demanded the command
    // everywhere would quietly force the wrong copy.
    for (const code of codes.filter((c) => c !== "store-busy")) {
      assert.match(describeUnlockExchangeError(code), /email-agent unlock/);
    }
    assert.doesNotMatch(describeUnlockExchangeError("store-busy"), /email-agent unlock/);
    assert.match(describeUnlockExchangeError("store-busy"), /try this link again/i);
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

describe("the pasted-link parser", () => {
  // The paste box is the documented fallback for every link a terminal or a
  // mail client mangles, and the only part of `unlock-screen.tsx` that can be
  // tested at all (there is no component testing library in this repo).

  it("reads the token out of the FRAGMENT of a current link", () => {
    assert.equal(
      extractUnlockToken("http://127.0.0.1:3847/unlock?exchange=1#token=abc-123_XYZ"),
      "abc-123_XYZ",
    );
  });

  it("still reads a link minted before the token moved into the fragment", () => {
    // Removing the old `?token=` ROUTE does not mean refusing an old LINK. A
    // string pasted here is parsed in the browser and never sent anywhere, so
    // accepting the old shape costs nothing and is the only thing that still
    // redeems a link printed by a previous build.
    assert.equal(extractUnlockToken("http://127.0.0.1:3847/?token=legacy-value"), "legacy-value");
  });

  it("prefers the fragment when a URL somehow carries both", () => {
    // The fragment is where a link this app printed puts it; a `token` in the
    // query of the same URL did not come from here.
    assert.equal(
      extractUnlockToken("http://127.0.0.1:3847/unlock?token=query#token=fragment"),
      "fragment",
    );
  });

  it("takes a bare token, and trims what a terminal wrapped", () => {
    assert.equal(extractUnlockToken("  bare-token-value \n"), "bare-token-value");
  });

  it("returns the input unchanged when there is no token to find", () => {
    // Not an error: the value is handed to the exchange route, which answers
    // `invalid-token` with copy naming the recovery command. Guessing here
    // would only produce a worse message.
    assert.equal(extractUnlockToken("http://127.0.0.1:3847/unlock"), "http://127.0.0.1:3847/unlock");
  });
});
