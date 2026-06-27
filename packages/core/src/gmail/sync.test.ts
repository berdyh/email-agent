import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSyncFetchOptions, shouldReconcileUnreadSync } from "./sync.js";

describe("sync unread reconciliation", () => {
  it("fetches with the resolved account identity before reconciling", () => {
    assert.deepEqual(resolveSyncFetchOptions({ scope: "unread" }, "me@example.com"), {
      scope: "unread",
      accountEmail: "me@example.com",
    });
    assert.deepEqual(resolveSyncFetchOptions({ scope: "unread" }, ""), {
      scope: "unread",
      accountEmail: "",
    });
  });

  it("runs only for complete unread syncs without message fetch failures", () => {
    assert.equal(
      shouldReconcileUnreadSync(
        { scope: "unread" },
        { exhausted: true, failedCount: 0 },
      ),
      true,
    );
    assert.equal(
      shouldReconcileUnreadSync(
        { scope: "unread" },
        { exhausted: false, failedCount: 0 },
      ),
      false,
    );
    assert.equal(
      shouldReconcileUnreadSync(
        { scope: "unread" },
        { exhausted: true, failedCount: 1 },
      ),
      false,
    );
    assert.equal(
      shouldReconcileUnreadSync(
        { scope: "all" },
        { exhausted: true, failedCount: 0 },
      ),
      false,
    );
  });
});
