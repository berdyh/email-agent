import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldReconcileUnreadSync } from "./sync.js";

describe("sync unread reconciliation", () => {
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
