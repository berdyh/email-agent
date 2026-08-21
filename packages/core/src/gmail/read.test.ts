import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GmailCredentialError,
  classifyMessageReadFailure,
  readMessageLabels,
} from "./read.js";

/**
 * A gaxios-shaped HTTP error. The shape is READ OFF the installed gaxios 6.7.1
 * (`build/src/common.js:79`, `:82`), not guessed: `status` comes from the HTTP
 * response, and `code` is set only from an underlying transport error. These
 * tests are the tripwire for that fact changing under an upgrade.
 */
function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & {
    status: number;
    response: { status: number };
  };
  err.status = status;
  err.response = { status };
  return err;
}

describe("classifying a Gmail label read failure", () => {
  it("reads a 404 off `status`, which is where gaxios puts it", () => {
    assert.deepEqual(classifyMessageReadFailure(httpError(404, "Not Found")), {
      kind: "notFound",
    });
  });

  it("does NOT accept a numeric `code` as a status", () => {
    // The trap this pins: older gaxios put the numeric status on `code`, and an
    // implementation testing `err.code === 404` would be dead code against the
    // installed version — every 404 would classify as a generic check failure,
    // and the surfaces would tell the user the check broke rather than that
    // Gmail has no such message.
    const err = new Error("Not Found") as Error & { code: number };
    err.code = 404;
    assert.deepEqual(classifyMessageReadFailure(err), {
      kind: "error",
      message: "Not Found",
    });
  });

  it("names a credential failure as one, whether it came from the client or the API", () => {
    assert.deepEqual(
      classifyMessageReadFailure(new GmailCredentialError("no stored token")),
      { kind: "noCredentials", message: "no stored token" },
    );
    assert.deepEqual(
      classifyMessageReadFailure(httpError(401, "Invalid Credentials")),
      { kind: "noCredentials", message: "Invalid Credentials" },
    );
  });

  it("carries a 403's own words, because 403 is not only about permission", () => {
    // Gmail answers 403 for insufficient permission AND for rate limiting. The
    // two are distinguishable only from the text, so the text has to survive
    // classification for a person to be able to tell which they hit.
    const read = classifyMessageReadFailure(
      httpError(403, "User Rate Limit Exceeded"),
    );
    assert.equal(read.kind, "noCredentials");
    assert.match(
      read.kind === "noCredentials" ? read.message : "",
      /Rate Limit/,
    );
  });

  it("treats a transport failure as a failed CHECK, saying nothing about the message", () => {
    const err = new Error("connect ECONNREFUSED") as Error & { code: string };
    err.code = "ECONNREFUSED";
    assert.deepEqual(classifyMessageReadFailure(err), {
      kind: "error",
      message: "connect ECONNREFUSED",
    });
    // 429 and 5xx are check failures too — a throttled read is not evidence
    // about the mailbox.
    assert.equal(classifyMessageReadFailure(httpError(429, "slow down")).kind, "error");
    assert.equal(classifyMessageReadFailure(httpError(500, "backend")).kind, "error");
  });

  it("survives a non-Error throw", () => {
    assert.deepEqual(classifyMessageReadFailure("boom"), {
      kind: "error",
      message: "boom",
    });
  });
});

describe("reading a message's labels", () => {
  it("returns the labels and passes the account through verbatim", async () => {
    // "" is a real account value — the gcloud ADC sentinel — and must reach the
    // getter as "" rather than being normalised to undefined, which would mean
    // the configured default account and a different mailbox.
    const calls: Array<[string, string]> = [];
    const read = await readMessageLabels("m1", "", async (id, account) => {
      calls.push([id, account]);
      return ["INBOX", "UNREAD"];
    });
    assert.deepEqual(read, { kind: "labels", labelIds: ["INBOX", "UNREAD"] });
    assert.deepEqual(calls, [["m1", ""]]);
  });

  it("turns a failure into an outcome instead of throwing", async () => {
    const read = await readMessageLabels("m1", "me@example.com", async () => {
      throw httpError(404, "Not Found");
    });
    assert.deepEqual(read, { kind: "notFound" });
  });
});
