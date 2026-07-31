import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VECTOR_DIMENSION,
  createEmptyVector,
  createLocalEmbeddingVector,
} from "../shared/vector.js";
import { buildEmailRecords } from "./sync-records.js";
import type { GmailMessage } from "./types.js";

const message: GmailMessage = {
  id: "msg-1",
  threadId: "thread-1",
  from: "sender@example.com",
  to: "me@example.com",
  subject: "Hello",
  date: "2026-06-26T12:00:00.000Z",
  bodyText: "Body text",
  bodyHtml: "<p>Body text</p>",
  labels: ["INBOX", "UNREAD"],
  isUnread: true,
  senderDomain: "example.com",
  snippet: "Body",
};

describe("sync record mapping", () => {
  it("maps Gmail messages into DB records with account and serialized labels", () => {
    const records = buildEmailRecords("person@example.com", [message], [
      createEmptyVector(),
    ]);

    assert.equal(records[0]?.accountId, "person@example.com");
    assert.equal(records[0]?.labels, JSON.stringify(["INBOX", "UNREAD"]));
    assert.equal(records[0]?.vector.length, VECTOR_DIMENSION);
  });

  it("uses a local vector when embedding generation returns no vector for a message", () => {
    const records = buildEmailRecords("person@example.com", [message], []);

    assert.deepEqual(
      records[0]?.vector,
      createLocalEmbeddingVector("Hello\nsender@example.com\nBody text"),
    );
    assert.equal(records[0]?.vector.some((value) => value !== 0), true);
  });
});
