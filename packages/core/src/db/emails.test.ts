import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEmailFilters, buildStaleUnreadFilter } from "./emails.js";

describe("email DB filters", () => {
  it("keeps an explicit empty account id scoped", () => {
    assert.deepEqual(buildEmailFilters({ accountId: "", unreadOnly: true }), [
      "`accountId` = ''",
      "`isUnread` = true",
    ]);
  });

  it("scopes stale unread reconciliation by account and fetched unread ids", () => {
    assert.equal(
      buildStaleUnreadFilter("person@example.com", ["msg-1", "quote'id"]),
      "`accountId` = 'person@example.com' AND `isUnread` = true AND id != 'msg-1' AND id != 'quote''id'",
    );
  });

  it("marks all unread rows stale when Gmail returns no unread ids", () => {
    assert.equal(
      buildStaleUnreadFilter("person@example.com", []),
      "`accountId` = 'person@example.com' AND `isUnread` = true",
    );
  });
});
