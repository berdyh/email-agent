import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { google, type gmail_v1 } from "googleapis";
import {
  GmailCredentialError,
  classifyMessageReadFailure,
  getMessageLabels,
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

/**
 * THE HANG, driven for real.
 *
 * A `node:http` server that ACCEPTS the connection and never answers is the
 * exact failure these bounds exist for — a captive portal, a half-up VPN, a
 * peer that holds the socket open. It is also the one case a test asserting
 * "we passed the option" cannot catch: `timeout` is declared in gaxios 6.7.1's
 * types and never read in its code (see `getMessageLabels`), so the option is
 * honoured only by the fetch implementation underneath it. If an upgrade swaps
 * that implementation, the option still compiles, still gets passed, and stops
 * doing anything. Only a real hung socket notices.
 *
 * Every test here carries an EXPLICIT `node:test` timeout. `node --test` has no
 * default one, so without it the failure mode of an unfixed build is an
 * infinite hang rather than a red test — which is worthless to the next person
 * who reverts this to check the test still earns its place.
 */
describe("a Gmail read that never answers", () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            // `close()` alone only STOPS ACCEPTING; it waits for open sockets
            // to end, and the whole point of this stub is sockets that never
            // do. Without this, a build whose timeout has been removed does
            // not merely fail these tests — the test process never exits, and
            // the next person checking whether the tests still earn their
            // place sees a hang instead of a red run.
            server.closeAllConnections();
          }),
      ),
    );
  });

  /** Accepts, holds the socket, never responds. */
  async function hangingGmail(): Promise<gmail_v1.Gmail> {
    const server = createServer(() => {
      // Deliberately no response, ever.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const auth = new google.auth.OAuth2();
    // A live access token with a future expiry, so the client never tries to
    // refresh: this test is about the message read, not about auth.
    auth.setCredentials({
      access_token: "test-token",
      expiry_date: Date.now() + 3_600_000,
    });
    return google.gmail({
      version: "v1",
      auth,
      rootUrl: `http://127.0.0.1:${port}/`,
    });
  }

  it("gives up on its own, and inside its own timeout", { timeout: 15_000 }, async () => {
    const gmail = await hangingGmail();
    const startedAt = Date.now();
    const err = await getMessageLabels(gmail, "m1", 500).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(err !== null, "a request nobody answers must not resolve");
    // Under 1,500ms is the load-bearing half of this assertion. `apirequest.js`
    // defaults `retry: true` and gaxios retries a no-response failure TWICE
    // more with backoff, so a `timeout: 500` WITHOUT the
    // `retryConfig: { noResponseRetries: 0 }` override costs about 2,100ms of
    // wall clock, not 500ms — measured 2026-08-22. This bound fails if that
    // override is dropped, which is the point: the number in the code has to be
    // the number on the clock, because the pass deadline above it is budgeted
    // in whole reads.
    assert.ok(
      elapsed >= 400 && elapsed < 1_500,
      `expected to fail at about its 500ms timeout, took ${elapsed}ms`,
    );
  });

  it("lands on `check-failed`, the residual the type was written for", { timeout: 15_000 }, async () => {
    // `MessageLabelRead`'s `error` kind has named "timeout" in its own comment
    // since it was written, and until there was a bound nothing could produce
    // it from a hang. This is that kind being reachable: `verify-stranded.ts`
    // turns it into a `check-failed` residual, the one reason that tells the
    // user it may well succeed on the next pass.
    const gmail = await hangingGmail();
    const err = await getMessageLabels(gmail, "m1", 400).then(
      () => null,
      (e: unknown) => e,
    );
    const read = classifyMessageReadFailure(err);
    assert.equal(read.kind, "error");
    assert.match(
      read.kind === "error" ? read.message : "",
      /timeout/i,
      "the user-visible detail must say what actually happened",
    );
  });

  it("bounds the whole read, not just the request", { timeout: 15_000 }, async () => {
    // Driven through `readMessageLabels` — the function the product actually
    // calls — rather than through the helper on its own, so that deleting the
    // deadline from the production composition fails this test rather than
    // leaving it green against a helper nobody uses.
    //
    // The request timeout covers ONE HTTP call. Building the client can hang
    // too: an OAuth token refresh has no timeout of its own, and the gcloud ADC
    // path shells out to `execFile`, which has none either. A getter that never
    // settles stands in for all of them.
    const startedAt = Date.now();
    const read = await readMessageLabels(
      "m1",
      "me@example.com",
      () => new Promise<string[]>(() => {}), // never settles, ever
      300,
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 3_000, `deadline took ${elapsed}ms`);
    // A deadline is NOT a credentials failure. It must classify as `error` so
    // the user is told the check timed out — a `check-failed` residual that may
    // resolve itself — rather than that their Google access is broken.
    assert.equal(read.kind, "error");
    assert.match(
      read.kind === "error" ? read.message : "",
      /did not answer within 300ms/,
    );
  });

  it("does not leave a timer holding the process open on the winning path", { timeout: 15_000 }, async () => {
    // The deadline timer outlives the work it guards unless it is cleared. A
    // stray one keeps the event loop alive, so `email-agent fetch` would sit
    // idle for a further 10 seconds after printing its last line.
    const timersBefore = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    const read = await readMessageLabels(
      "m1",
      "me@example.com",
      async () => ["INBOX"],
      60_000,
    );
    const timersAfter = process
      .getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;

    assert.deepEqual(read, { kind: "labels", labelIds: ["INBOX"] });
    // `getActiveResourcesInfo` is the observable: it does NOT list unref'd
    // handles, so a live 60s timer only shows up here if BOTH the `unref` and
    // the `finally` clear are gone — which is exactly the regression that would
    // leave `email-agent fetch` sitting for a further minute after printing its
    // last line. Asserting only the returned value would not notice.
    assert.equal(
      timersAfter,
      timersBefore,
      "the deadline timer outlived the read it was guarding",
    );
  });
});
