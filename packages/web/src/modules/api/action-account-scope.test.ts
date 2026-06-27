import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestValidationError } from "./validation.js";
import { resolveActionRunAccountEmail } from "./action-account-scope.js";

describe("action account scoping", () => {
  it("preserves explicit account selection including the gcloud sentinel", () => {
    assert.equal(resolveActionRunAccountEmail("me@example.com", []), "me@example.com");
    assert.equal(resolveActionRunAccountEmail("", [{ accountId: "other@example.com" }]), "");
  });

  it("derives a single implicit account from the unread action batch", () => {
    assert.equal(
      resolveActionRunAccountEmail(undefined, [
        { accountId: "me@example.com" },
        { accountId: "me@example.com" },
      ]),
      "me@example.com",
    );
  });

  it("rejects implicit multi-account action batches", () => {
    assert.throws(
      () =>
        resolveActionRunAccountEmail(undefined, [
          { accountId: "me@example.com" },
          { accountId: "work@example.com" },
        ]),
      RequestValidationError,
    );
  });
});
