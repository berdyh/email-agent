import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireAccountAuth, upsertAccountEntry } from "./account-manager.js";
import type { OAuthCredentials, StoredTokens } from "./account-types.js";

const CREDS: OAuthCredentials = { clientId: "id", clientSecret: "secret" };
const TOKENS: StoredTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3600_000,
  scope: "scope",
};

describe("requireAccountAuth", () => {
  it("returns creds and tokens when both are present", () => {
    assert.deepEqual(requireAccountAuth("a@example.com", CREDS, TOKENS), {
      creds: CREDS,
      stored: TOKENS,
    });
  });

  it("throws an actionable error when OAuth credentials are missing", () => {
    assert.throws(
      () => requireAccountAuth("a@example.com", null, TOKENS),
      (err: Error) =>
        err.message.includes('"a@example.com"') &&
        err.message.includes("npx email-agent accounts add a@example.com"),
    );
  });

  it("throws an actionable error when the account has no stored tokens", () => {
    assert.throws(
      () => requireAccountAuth("a@example.com", CREDS, null),
      (err: Error) =>
        err.message.includes('"a@example.com"') &&
        err.message.includes("npx email-agent accounts add a@example.com"),
    );
  });
});

describe("upsertAccountEntry", () => {
  it("makes the first account default", () => {
    const next = upsertAccountEntry([], { email: "a@example.com" });
    assert.deepEqual(next, [{ email: "a@example.com", isDefault: true }]);
  });

  it("appends a non-default account without touching the default", () => {
    const next = upsertAccountEntry(
      [{ email: "a@example.com", isDefault: true }],
      { email: "b@example.com" },
    );
    assert.deepEqual(next, [
      { email: "a@example.com", isDefault: true },
      { email: "b@example.com", isDefault: false },
    ]);
  });

  it("preserves default status when re-adding the current default account", () => {
    const next = upsertAccountEntry(
      [
        { email: "a@example.com", isDefault: true },
        { email: "b@example.com", isDefault: false },
      ],
      { email: "a@example.com", name: "Renamed" },
    );
    assert.deepEqual(next, [
      { email: "a@example.com", name: "Renamed", isDefault: true },
      { email: "b@example.com", isDefault: false },
    ]);
  });

  it("moves the default when the new entry claims it", () => {
    const next = upsertAccountEntry(
      [
        { email: "a@example.com", isDefault: true },
        { email: "b@example.com", isDefault: false },
      ],
      { email: "b@example.com", isDefault: true },
    );
    assert.deepEqual(next, [
      { email: "a@example.com", isDefault: false },
      { email: "b@example.com", isDefault: true },
    ]);
  });

  it("does not mutate the input array or its entries", () => {
    const input = [{ email: "a@example.com", isDefault: true }];
    upsertAccountEntry(input, { email: "a@example.com", isDefault: false });
    assert.deepEqual(input, [{ email: "a@example.com", isDefault: true }]);
  });
});
