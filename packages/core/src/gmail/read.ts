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
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "minimal",
  });
  return res.data.labelIds ?? [];
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
): Promise<MessageLabelRead> {
  try {
    return { kind: "labels", labelIds: await get(messageId, accountEmail) };
  } catch (err) {
    return classifyMessageReadFailure(err);
  }
}
