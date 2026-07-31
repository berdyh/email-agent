import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmailRecord } from "../db/schema.js";
import { kMeans } from "./cluster-kmeans.js";

function email(id: string, vector: number[], accountId = "acct"): EmailRecord {
  return {
    id,
    accountId,
    threadId: id,
    from: "sender@example.com",
    to: "me@example.com",
    subject: id,
    date: "2026-06-26T12:00:00.000Z",
    bodyText: id,
    bodyHtml: "",
    labels: "[]",
    isUnread: true,
    senderDomain: "example.com",
    snippet: id,
    vector,
  };
}

describe("k-means clustering", () => {
  it("initializes centroids deterministically", () => {
    const emails = [
      email("c", [10, 10]),
      email("a", [0, 0]),
      email("b", [0, 1]),
      email("d", [11, 10]),
    ];

    assert.deepEqual(kMeans(emails, 2, 10), kMeans(emails, 2, 10));
  });

  it("treats duplicate Gmail ids in different accounts as distinct emails", () => {
    const clusters = kMeans(
      [
        email("same", [0, 0], "first@example.com"),
        email("same", [10, 10], "second@example.com"),
      ],
      2,
      10,
    );

    assert.deepEqual(
      clusters.flatMap((cluster) => cluster.emailKeys).sort(),
      ["first@example.com:same", "second@example.com:same"],
    );
  });
});
