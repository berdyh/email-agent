import type { gmail_v1 } from "googleapis";
import { createGmailClient } from "./client.js";

/**
 * READING a message's label state back from Gmail.
 *
 * WHY THIS IS A SEPARATE FILE FROM `./operations.js`. That module is the
 * MUTATING surface, and `barrel-surface.test.ts` derives its deny list from
 * `Object.keys(gmailOps)` — every name in it is denied a public export
 * *because it writes*. Putting a read-only function there would make that list
 * start denying a name for a reason it does not hold, muddying what the
 * assertion means. So the reader lives here, is imported relatively by core,
 * and is NOT re-exported from `gmail/index.ts` either: it hands back mailbox
 * content keyed by message id, which is not something a public barrel should
 * offer, even though it cannot change anything.
 *
 * Read-only in the strict sense: `users.messages.get` with `format: "minimal"`
 * is the only call, it takes no `requestBody`, and nothing here can add,
 * remove or move a label. `minimal` is documented (REST reference, read
 * 2026-08-21) as "Returns only email message ID and labels; does not return the
 * email headers, body, or payload" — so `labelIds` is exactly what comes back,
 * and no message content is fetched.
 */

/** What a label read-back can tell us. Every failure is a distinct kind, because the caller must not treat them alike. */
export type MessageLabelRead =
  | { kind: "labels"; labelIds: string[] }
  /**
   * Gmail has no such message id in the mailbox we asked.
   *
   * THREE-WAY AMBIGUOUS, and one of the three means APPLIED: the message was
   * permanently deleted; or the row is an `accountId: ""` ADC row and ADC has
   * been re-pointed since it was queued, so we asked a different mailbox
   * entirely (Gmail message ids are per-mailbox); or a `trash`/`spam` operation
   * SUCCEEDED and Gmail has since purged the message from Trash or Spam.
   * Never map this to a verdict in either direction.
   */
  | { kind: "notFound" }
  /**
   * We could not use this account's Gmail access at all — no stored token, a
   * refresh that failed, a 401, or a 403.
   *
   * 403 is deliberately folded in here rather than split out: Gmail returns it
   * both for insufficient permission and for rate limiting, and the two are
   * only distinguishable from the message text. `message` therefore carries
   * Gmail's own words verbatim so a surface can show them and a person can tell
   * which it was.
   */
  | { kind: "noCredentials"; message: string }
  /** The check itself failed — network, timeout, 5xx, 429, a malformed response. Says nothing about the message. */
  | { kind: "error"; message: string };

/**
 * The injected seam.
 *
 * Throws for every failure and returns the label ids on success, so the
 * classification below is a single pure function over an error rather than
 * something smeared across the call site. THE REASON THE SEAM EXISTS: there is
 * no linked Gmail account on this machine (AGENTS.md records that as a standing
 * limit), so without it not one line of the verification pipeline could be
 * driven by a test.
 */
export type MessageLabelGetter = (
  messageId: string,
  accountEmail: string,
) => Promise<string[]>;

/**
 * Thrown when the CLIENT could not be built — a named account with no stored
 * token, a refresh failure, `gcloud` missing on the ADC path. It is not an HTTP
 * error and carries no status, so without its own type it would classify as a
 * generic check failure and a user with an expired token would be told "the
 * check failed" instead of "this account's credentials do not work".
 */
export class GmailCredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GmailCredentialError";
  }
}

/**
 * The real getter.
 *
 * `accountEmail` is REQUIRED and takes "" explicitly. No `undefined` overload,
 * deliberately: a queue row's `accountId` maps straight onto this parameter,
 * and `createGmailClient("")` means gcloud ADC and nothing else, while
 * `createGmailClient(undefined)` means the configured default account. Checking
 * a "" row against the default account would read a different mailbox than the
 * apply would have written to. The required parameter makes that unspellable.
 */
/**
 * How long ONE `users.messages.get` may sit on the wire.
 *
 * WHY THERE IS A NUMBER HERE AT ALL. Without it there is none: the request
 * hangs for as long as the peer holds the socket open, and `verifyStranded
 * ApplyingOperations` reads its rows SERIALLY, so one unresponsive request
 * stalls the whole pass — and with it `email-agent fetch`, `email-agent serve`
 * (which does this BEFORE spawning the web server) and
 * `POST /api/approvals/stranded/verify`. Their `try`/`catch` cannot help: it
 * catches throws, not hangs. `MessageLabelRead` has declared an `error` kind
 * whose own comment says "timeout" since it was written, and nothing could
 * produce it from a hang. This is what makes that kind reachable, which turns a
 * dead connection into a `check-failed` residual — the reason that says "may
 * well succeed next time" — instead of a stopped command.
 *
 * WHY 8s. It has to sit above the worst plausible HEALTHY round trip and below
 * the point where a person believes the command is stuck. A false timeout is
 * not free: it becomes a residual row a HUMAN then has to adjudicate, which is
 * the exact cost this whole verification pass exists to remove, so the value
 * leans generous. `format: "minimal"` returns an id and a label list — no
 * headers, no body — so a healthy call is a small fraction of a second even on
 * a slow link, and 8s is roughly an order of magnitude of headroom over that.
 */
export const GMAIL_REQUEST_TIMEOUT_MS = 8_000;

/**
 * The OUTER, per-read bound applied by `readMessageLabels`: everything ONE
 * label read does, including the parts `GMAIL_REQUEST_TIMEOUT_MS` does not
 * reach.
 *
 * The gaxios timeout covers ONE HTTP request. It does not cover building the
 * client: `createGmailClient` can refresh an OAuth token over the network
 * (its own request, with its own — absent — timeout), and on the `""` gcloud
 * ADC path it shells out to `gcloud auth application-default
 * print-access-token` through `execFile`, which has no timeout either. Those
 * are the same hang by another route, so the guarantee is stated once, around
 * the whole read.
 *
 * Strictly ORDERED above the request timeout so that in the ordinary case the
 * socket abort fires first and the connection is actually torn down (a
 * `Promise.race` alone would leave it open). This is the backstop, not the
 * mechanism — and the two are ordered again by `verify-stranded.ts`'s pass
 * deadline, which is budgeted in whole reads of THIS length.
 */
export const GMAIL_READ_DEADLINE_MS = 10_000;

/**
 * `work()` or a rejection, whichever comes first — never neither.
 *
 * The timer is CLEARED on the winning path and `unref`'d besides: a stray
 * pending timer keeps the event loop alive, which would make `email-agent
 * fetch` sit for up to `ms` after it had already printed everything it had to
 * say.
 *
 * The rejection is a plain `Error`, deliberately: it carries no `status`, so
 * `classifyMessageReadFailure` maps it to `error` -> `check-failed`, which is
 * the honest reading of a deadline (we learned nothing about the message, and
 * the next pass may well learn it).
 */
export async function withGmailReadDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${ms}ms.`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * THE request. Split out so that the timeout options are written ONCE and the
 * test that proves they fire drives the very same call the product makes — a
 * test against a hand-copied pair of options is a test of the copy.
 *
 * WHAT THE INSTALLED CLIENT ACTUALLY DOES WITH THESE. Measured 2026-08-22
 * against googleapis 146.0.0 / gaxios 6.7.1 / node-fetch 2.7.0 as installed
 * here, by pointing a real `gmail_v1.Gmail` at a `node:http` server that
 * accepts the connection and never answers. NOT read off documentation — the
 * documentation is exactly what would have misled us:
 *
 *   1. `timeout` is declared in gaxios's own `common.d.ts:104` and is NEVER
 *      READ anywhere in `gaxios.js`. It works only because `common.js:66`
 *      picks `node-fetch` when there is no `window`, and gaxios hands the
 *      whole options object to it verbatim; node-fetch 2.7.0 honours
 *      `timeout` (`lib/index.js:1491`) and rejects with a `FetchError` of type
 *      `request-timeout`. So the mechanism is node-fetch's, not gaxios's.
 *      **gaxios 7 drops node-fetch for the platform `fetch`, which ignores
 *      `timeout` outright — the type would still compile and the bound would
 *      be gone.** RE-MEASURE THIS ON ANY googleapis/gaxios UPGRADE, exactly as
 *      AGENTS.md requires for the LanceDB facts.
 *   2. Without `timeout` the call simply does not come back: still pending at
 *      4,000ms with nothing else to stop it.
 *   3. `retryConfig: { noResponseRetries: 0 }` is REQUIRED for the number to
 *      mean what it says. `googleapis-common/apirequest.js:263` defaults
 *      `retry: true`, and gaxios's `noResponseRetries` defaults to 2, so a
 *      hung request is attempted THREE times with backoff between:
 *      `timeout: 800` measured 3,013ms of wall clock, `timeout: 1500`
 *      measured 5,115ms. With the override, `timeout: 800` measured 802ms and
 *      `timeout: 300` measured 301ms.
 *   4. It suppresses ONLY the no-response retries. 429 and 5xx are RESPONSES
 *      and keep their retries — which matters here, because these reads are
 *      serial precisely to stay clear of 429s and a 429 that retried itself is
 *      one fewer residual for a human.
 *   5. The rejection is a `GaxiosError` with `name: "Error"`, NO `status`, and
 *      `err.error.type === "request-timeout"`. `classifyMessageReadFailure`
 *      therefore maps it to `{ kind: "error" }` -> `check-failed`. That is the
 *      designed destination, reached without a special case.
 */
export async function getMessageLabels(
  gmail: gmail_v1.Gmail,
  messageId: string,
  timeoutMs: number = GMAIL_REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const res = await gmail.users.messages.get(
    { userId: "me", id: messageId, format: "minimal" },
    { timeout: timeoutMs, retryConfig: { noResponseRetries: 0 } },
  );
  return res.data.labelIds ?? [];
}

export const readMessageLabelsFromGmail: MessageLabelGetter = async (
  messageId,
  accountEmail,
) => {
  let gmail;
  try {
    gmail = await createGmailClient(accountEmail);
  } catch (err) {
    throw new GmailCredentialError(
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
  return getMessageLabels(gmail, messageId);
};

/**
 * PURE. Maps a thrown error onto the read outcome it means.
 *
 * `err.status`, NOT `err.code`. MEASURED, not assumed, against the installed
 * gaxios 6.7.1 (what googleapis 146.0.0 pulls in here):
 * `node_modules/gaxios/build/src/common.js:79` sets `this.status =
 * this.response.status` for any HTTP error response, and `:82` sets
 * `this.code` ONLY from an underlying transport error's own `code`. So
 * `err.code === 404` would never match — a real trap, because older gaxios did
 * put the numeric status on `code`. A network failure has `code:
 * "ECONNREFUSED"` and no `status`, and correctly falls through to `error`.
 * RE-MEASURE THIS IF googleapis/gaxios IS UPGRADED, exactly as AGENTS.md
 * requires for the LanceDB facts.
 */
export function classifyMessageReadFailure(err: unknown): MessageLabelRead {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GmailCredentialError) {
    return { kind: "noCredentials", message };
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 404) return { kind: "notFound" };
  if (status === 401 || status === 403) {
    return { kind: "noCredentials", message };
  }
  return { kind: "error", message };
}

/**
 * Reads a message's CURRENT label ids.
 *
 * Returns an outcome rather than throwing, because every failure here is
 * information the caller has to keep and show: the verifier turns each kind
 * into a different sentence for the user, and a thrown error would collapse
 * them into one.
 */
export async function readMessageLabels(
  messageId: string,
  accountEmail: string,
  get: MessageLabelGetter = readMessageLabelsFromGmail,
  deadlineMs: number = GMAIL_READ_DEADLINE_MS,
): Promise<MessageLabelRead> {
  try {
    return {
      kind: "labels",
      // THE DEADLINE GOES HERE, not inside the getter, for two reasons. It is
      // OUTSIDE the getter's credential `catch`: a deadline that fired while
      // `createGmailClient` was hanging must not come back as
      // `GmailCredentialError` -> `noCredentials`, telling a user their Google
      // access is broken when the truth is that a check timed out. And it binds
      // the CONTRACT rather than one implementation of it — "a label read
      // answers within `deadlineMs`" holds for whatever getter is passed,
      // which is also what makes it testable: the seam that exists because
      // there is no linked Gmail account on this machine can now be handed
      // something that never settles.
      labelIds: await withGmailReadDeadline(
        () => get(messageId, accountEmail),
        deadlineMs,
        "Reading this message's labels from Gmail",
      ),
    };
  } catch (err) {
    return classifyMessageReadFailure(err);
  }
}
