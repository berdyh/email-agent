import type { PendingOperationRecord, ResolutionEvidence } from "../db/schema.js";
import { getStaleApplyingOperations } from "../db/pending-operations.js";
import { readMessageLabels, type MessageLabelRead } from "../gmail/read.js";
import {
  adjudicateStrandedOperations,
  parseLabelIds,
  type StrandedDecision,
} from "./approval.js";

/**
 * Checking a stranded row against Gmail instead of asking the user.
 *
 * WHAT THIS CAN AND CANNOT ESTABLISH — read this before changing anything here.
 *
 * 1. IT READS THE STATE NOW, AND CANNOT PROVE THIS APP'S CALL CAUSED IT. Every
 *    operation in the set is an idempotent TARGET STATE, not an event. A
 *    message the user archived on their phone verifies `applied` for an
 *    `removeLabels ["INBOX"]` row with certainty zero. End state right,
 *    attribution wrong. That direction is benign — the row retires into the
 *    audit trail and nothing is mutated — but the note it writes
 *    (`STRANDED_VERIFIED_NOTE`) must keep saying so.
 *
 * 2. THE MIRROR OF (1), WHICH IS THE DANGEROUS DIRECTION. The check is equally
 *    blind to a REVERSAL. An apply that really landed and was then undone by
 *    the user — un-archived on a phone, re-marked unread, restored from Trash —
 *    verifies `notApplied` and goes back to `pending`, RE-PROPOSING a change
 *    the user already approved once and then deliberately reversed. Nothing
 *    mutates unasked: it is an ordinary pending proposal that needs an explicit
 *    approval. But this is the direction that can produce a SECOND mutation,
 *    and approving it would undo the user's own later action. A re-apply cannot
 *    DESTROY anything (the whole operation set is idempotent label state — no
 *    send, no permanent delete, no counter; `gmail/operations.ts` has no
 *    `messages.delete` and no `batchDelete`), but "idempotent, therefore
 *    harmless" is the wrong sentence. It is: idempotent, therefore it cannot
 *    destroy anything; it can still undo something the user did in between.
 *
 * 3. A ROW WITH `accountId: ""` MAY NEVER BE VERIFIED AS `applied`. That is the
 *    gcloud ADC sentinel, and `createGmailClient("")` resolves whatever
 *    identity ADC points at NOW — not necessarily the mailbox the message was
 *    read from. On the APPLY path a wrong mailbox is harmless: Gmail ids are
 *    per-mailbox, so the call 404s and the row fails. On the READ path it is
 *    not symmetric — a wrong mailbox that happened to hold that id would return
 *    a positive verdict and SILENTLY RETIRE the row on evidence from a
 *    different account. The asymmetry is free: a wrong-mailbox `notApplied`
 *    only requeues a proposal the user has to approve anyway. So a "" row is
 *    checked, may be requeued, and is otherwise handed to a human. Silent
 *    closure is the class of failure this repo refuses.
 *
 * 4. NEW INSTANCE OF THE DOCUMENTED RESIDUAL — the read-before-claim window.
 *    This reads Gmail, then writes. If a hung apply lands in between, the
 *    verdict was `notApplied` (the state was not there yet), the write
 *    requeues, and the change is now BOTH in Gmail and in the approval queue.
 *    It cannot be closed by claiming the row before reading: a crash between
 *    claim and release would re-stamp `claimedAt`, resetting the 15-minute
 *    staleness clock and hiding the row again, which is strictly worse.
 *
 * NOT RECOVERY, and do not describe it as such. It re-applies nothing and rolls
 * nothing back; it records an end state, or it hands the row to a person.
 */

/** What a label read-back says about ONE queued operation. */
export type VerificationVerdict =
  | { kind: "applied" }
  | { kind: "notApplied" }
  /** The labels were read fine; this build cannot turn them into a verdict for this row. */
  | { kind: "unknown"; reason: string };

/**
 * THE WHOLE PREDICATE TABLE, PURE, IN ONE PLACE — no DB, no network, so every
 * case including the fail-closed ones is exhaustively testable.
 *
 * Read off `gmail/operations.ts`, not off a spec:
 *
 *   markRead     modify removeLabelIds:["UNREAD"]                  UNREAD absent
 *   markUnread   modify addLabelIds:["UNREAD"]                     UNREAD present
 *   trash        messages.trash()                                  TRASH present
 *   spam         modify add:["SPAM"] remove:["INBOX"], ONE call     SPAM present AND INBOX absent
 *   addLabels    modify addLabelIds: ids                           every id present
 *   removeLabels modify removeLabelIds: ids                        no id present
 *
 * `spam` is the one the TODOS table got wrong: `markAsSpam` removes INBOX in
 * the SAME atomic `modify`, so that pair is the intended end state and SPAM
 * present WITH INBOX present means the call did not land (or the message was
 * re-inboxed).
 *
 * `trash` deliberately checks TRASH present ALONE. Do NOT also require INBOX
 * absent — Gmail removes INBOX implicitly on trash, and requiring it would
 * manufacture false negatives.
 *
 * Label ids are compared EXACTLY and case-sensitively. There is no name->id
 * resolution: Gmail system ids are uppercase, user labels are opaque
 * (`Label_123`), and an operation carrying a label NAME would have had its
 * apply rejected by Gmail, so it never reached `applying` successfully.
 *
 * FAIL CLOSED, NEVER TO A VERDICT:
 *   - an `addLabels`/`removeLabels` row with an EMPTY label list. A vacuous
 *     `every()` over an empty array returns TRUE and would verify it as
 *     applied — and `applyOperations` THROWS for those, so such a row can never
 *     have been applied by this app in the first place;
 *   - any `type` this build does not know, matching `applyOperations`'s
 *     `default: throw`.
 */
export function verdictFromLabels(
  type: string,
  labelIds: readonly string[],
  operationLabelIds: readonly string[],
): VerificationVerdict {
  const has = (id: string): boolean => labelIds.includes(id);
  const applied: VerificationVerdict = { kind: "applied" };
  const notApplied: VerificationVerdict = { kind: "notApplied" };

  switch (type) {
    case "markRead":
      return has("UNREAD") ? notApplied : applied;
    case "markUnread":
      return has("UNREAD") ? applied : notApplied;
    case "trash":
      return has("TRASH") ? applied : notApplied;
    case "spam":
      return has("SPAM") && !has("INBOX") ? applied : notApplied;
    case "addLabels":
    case "removeLabels": {
      if (operationLabelIds.length === 0) {
        return {
          kind: "unknown",
          reason: `a "${type}" change that names no labels, which this app refuses to apply at all`,
        };
      }
      const present = operationLabelIds.some(has);
      const all = operationLabelIds.every(has);
      return type === "addLabels"
        ? all
          ? applied
          : notApplied
        : present
          ? notApplied
          : applied;
    }
    default:
      return {
        kind: "unknown",
        reason: `a change of an unrecognised kind ("${type}")`,
      };
  }
}

/**
 * Why a stranded row is still stranded after a verification pass.
 *
 * These are CAUSES, and each needs its own sentence on every surface: a person
 * told only "we could not check" cannot act. In particular `check-failed` may
 * fix itself on the next pass and `unverifiable-operation` never will.
 */
export type VerificationResidualReason =
  /**
   * Gmail has no such message. THREE-WAY AMBIGUOUS and one branch means
   * APPLIED (deleted outright / an ADC row now pointing at another mailbox / a
   * trash or spam that succeeded and was later purged), so it is never
   * auto-anything.
   */
  | "message-missing"
  /** This account's Gmail access did not work — no token, a refresh failure, a 401, or a 403 (which Gmail also uses for rate limiting; see `detail`). */
  | "credentials"
  /** The check itself failed — network, 429, 5xx. Says nothing about the message. May well succeed next time. */
  | "check-failed"
  /** The labels came back fine, but this build cannot turn them into a verdict for this row. It will not resolve itself. */
  | "unverifiable-operation"
  /**
   * The labels MATCH, but the row carries the `accountId: ""` ADC sentinel, so
   * we cannot be sure which mailbox we just read. Only a person can close this
   * one out. See point 3 in the module header.
   */
  | "unscoped-account";

/** One row a verification pass could not answer, and why. Computed per call — deliberately NOT persisted. */
export interface StrandedResidual {
  id: string;
  emailId: string;
  accountId: string;
  reason: VerificationResidualReason;
  /** The specific thing that went wrong — Gmail's own words where there are any. Safe to show a user. */
  detail: string;
}

/**
 * The three side-effecting steps, injected.
 *
 * Shaped after `ChunkedApplyDeps`: the concern here is SEQUENCING (read ->
 * partition -> two writes), which is exactly what a deps interface makes
 * testable without a LanceDB table or a Gmail account — and there is no linked
 * account on this machine, so without the seam nothing here could be driven at
 * all.
 */
export interface StrandedVerificationDeps {
  /** Rows already filtered by the staleness threshold. Real: `getStaleApplyingOperations`. */
  listStranded(): Promise<PendingOperationRecord[]>;
  /** Real: `readMessageLabels`. `accountEmail` takes "" verbatim — see `gmail/read.ts`. */
  readLabels(messageId: string, accountEmail: string): Promise<MessageLabelRead>;
  /** Real: `adjudicateStrandedOperations`, which owns the claim-then-write discipline. */
  adjudicate(
    ids: string[],
    decision: StrandedDecision,
    evidence: ResolutionEvidence,
  ): Promise<number>;
}

export interface StrandedVerificationResult {
  /** Stale rows this pass looked at. `0` means there was nothing to do and NO Gmail call was made. */
  checked: number;
  appliedIds: string[];
  requeuedIds: string[];
  /** What `adjudicate` actually wrote. Can be LOWER than the id count — that is information, not an error. */
  appliedRecorded: number;
  requeuedRecorded: number;
  /** Rows left EXACTLY as they were, for a human. */
  unresolved: StrandedResidual[];
}

const defaultDeps: StrandedVerificationDeps = {
  listStranded: () => getStaleApplyingOperations(),
  readLabels: (messageId, accountEmail) =>
    readMessageLabels(messageId, accountEmail),
  adjudicate: (ids, decision, evidence) =>
    adjudicateStrandedOperations(ids, decision, { evidence }),
};

/**
 * Checks every stranded row against Gmail and resolves what it can WITHOUT the
 * user, leaving the rest for a human with the specific reason.
 *
 * CHEAP GATE FIRST, ALWAYS. The stale list is a plain DB read. If it is empty
 * this returns immediately: no Gmail client is constructed, no request is made,
 * and callers that run this automatically (a fetch, a server start) do so at
 * the cost of one local query and print nothing. That property is the whole
 * reason this can run unprompted, so do not move a Gmail call above the gate.
 *
 * READS ARE SERIAL, not `Promise.all`. A burst raises the 429 risk, and a 429
 * here becomes an unresolved row a human has to answer — strictly worse than
 * being slow. The stale set is small by construction (at most one chunk per
 * crashed in-flight caller) and one `messages.get` costs 20 quota units against
 * a 6,000/min budget (Gmail quota reference, read 2026-08-21).
 *
 * TWO ADJUDICATION CALLS, OVER DISJOINT ID SETS. It writes through
 * `adjudicateStrandedOperations` rather than a private DB path, and inherits
 * for free: the staleness cutoff RECOMPUTED AT WRITE TIME and folded into the
 * same atomic predicate as the token stamp, token-scoped writes, and a
 * post-write count that can undercount but never overcount. A row an apply
 * finished between the read and the write is not matched (`status = 'applying'`
 * fails); a row requeued and re-claimed inside the threshold is not matched
 * (the age clause fails). There is deliberately no priority over a person's
 * answer racing this one: first token stamp wins, exactly as two people
 * already race.
 */
export async function verifyStrandedApplyingOperations(
  deps?: Partial<StrandedVerificationDeps>,
): Promise<StrandedVerificationResult> {
  const { listStranded, readLabels, adjudicate } = { ...defaultDeps, ...deps };

  const rows = await listStranded();
  const result: StrandedVerificationResult = {
    checked: rows.length,
    appliedIds: [],
    requeuedIds: [],
    appliedRecorded: 0,
    requeuedRecorded: 0,
    unresolved: [],
  };
  // THE GATE. Nothing below this line may run when there is nothing stranded.
  // Redundant against the code as it stands — the loop does not execute and
  // both writes are guarded — and kept anyway, because it states the contract
  // where a future edit would have to read it. Verified by mutation: removing
  // it changes nothing TODAY, and removing it together with either write guard
  // immediately makes a pass over an empty queue call out.
  if (rows.length === 0) return result;

  for (const row of rows) {
    const residual = (
      reason: VerificationResidualReason,
      detail: string,
    ): void => {
      result.unresolved.push({
        id: row.id,
        emailId: row.emailId,
        accountId: row.accountId,
        reason,
        detail,
      });
    };

    const read = await readLabels(row.emailId, row.accountId);
    if (read.kind === "notFound") {
      residual(
        "message-missing",
        "Gmail has no message with this id in the mailbox we asked. That can mean it was deleted, that this change was queued without a named account and the Google identity has changed since, or — for a Trash or Spam change — that it worked and Gmail has since purged the message.",
      );
      continue;
    }
    if (read.kind === "noCredentials") {
      residual("credentials", read.message);
      continue;
    }
    if (read.kind === "error") {
      residual("check-failed", read.message);
      continue;
    }

    const verdict = verdictFromLabels(
      row.type,
      read.labelIds,
      parseLabelIds(row.labelIds),
    );
    if (verdict.kind === "unknown") {
      residual("unverifiable-operation", verdict.reason);
      continue;
    }
    if (verdict.kind === "notApplied") {
      result.requeuedIds.push(row.id);
      continue;
    }
    // verdict is `applied` from here.
    //
    // THE ONE ASYMMETRY IN THIS FUNCTION, and it is deliberate. "" is the
    // gcloud ADC sentinel: `createGmailClient("")` resolves whatever identity
    // ADC points at NOW, which is not necessarily the mailbox this message was
    // read from. Recording `applied` on that evidence would retire the row
    // silently on a reading possibly taken from a different account. A
    // `notApplied` from the wrong mailbox costs nothing by comparison — it
    // requeues a proposal the user must approve anyway — so only this
    // direction is blocked. See point 3 in the module header.
    if (row.accountId === "") {
      residual(
        "unscoped-account",
        "The message's labels match this change, but it was queued without a named Google account, so we cannot be sure which mailbox we just read. Confirming this one is left to you.",
      );
      continue;
    }
    result.appliedIds.push(row.id);
  }

  if (result.appliedIds.length > 0) {
    result.appliedRecorded = await adjudicate(
      result.appliedIds,
      "applied",
      "verified-api",
    );
  }
  if (result.requeuedIds.length > 0) {
    result.requeuedRecorded = await adjudicate(
      result.requeuedIds,
      "notApplied",
      "verified-api",
    );
  }
  return result;
}
