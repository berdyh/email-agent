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
 * 4. THE READ-BEFORE-WRITE WINDOW — NARROWED, NEVER CLOSED. This reads Gmail,
 *    then writes. If a hung apply lands in between, the verdict was
 *    `notApplied` (the state was not there yet), the write requeues, and the
 *    change is now BOTH in Gmail and in the approval queue on an audit trail
 *    saying it never happened.
 *
 *    Only the `notApplied` direction can go wrong this way: labels the check
 *    SAW present were present, so an `applied` verdict a late apply also lands
 *    stays the right end-state record. So every requeue candidate — and ONLY
 *    those — is RE-READ immediately before adjudication (`verifyStranded
 *    ApplyingOperations`'s second pass). That collapses the exposure from
 *    "the whole serial read pass plus both batch writes" (seconds to minutes,
 *    since row 1's read is already minutes old when its claim lands) down to
 *    one read and one write.
 *
 *    WHAT REMAINS, and it is irreducible: Gmail can still land between the
 *    RE-READ and the write. You cannot atomically read an external system and
 *    write a local database. NARROWED is the only word for this; never write
 *    "closed".
 *
 *    It cannot be closed by claiming the row before reading either: a crash
 *    between claim and release would re-stamp `claimedAt`, resetting the
 *    15-minute staleness clock and hiding the row again, which is strictly
 *    worse.
 *
 * 5. IT IS BOUNDED IN TIME, AND A PASS MAY DELIBERATELY NOT FINISH. The reads
 *    are serial, so N stranded rows cost N reads, and each read can only be
 *    bounded (`gmail/read.ts`), never made fast. `email-agent serve` runs this
 *    BEFORE it spawns the web server, so an unbounded pass is a server that
 *    never starts on a network where connections hang rather than reset — the
 *    surrounding try/catch is no help, because it catches throws, not hangs.
 *
 *    `STRANDED_VERIFICATION_DEADLINE_MS` caps the whole pass. Rows it did not
 *    reach come back as `not-checked` residuals: untouched, still `applying`,
 *    still visible on every stranded surface, checked by the next pass. A
 *    requeue candidate the budget stopped short of RE-READING is a residual
 *    too, never a requeue — pass one's evidence is exactly what point 4 says
 *    not to write on. Nothing is lost and nothing is guessed; the queue drains
 *    over more than one pass.
 *
 *    The budget bounds only the READS. Both adjudication writes still run for
 *    whatever the pass did decide — they are local database writes, and
 *    abandoning a decision already made would throw away the work.
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
  | "unscoped-account"
  /**
   * The pass ran out of its wall-clock budget before it could read this row —
   * or before it could RE-READ it, which is the same refusal to guess.
   *
   * NOTHING WAS LEARNED AND NOTHING WAS TOUCHED. The row is exactly as it was,
   * `applying`, visible to every stranded surface, and the next `fetch` or
   * server start checks it. Like `check-failed` it resolves itself on a later
   * pass; unlike `check-failed` nothing went wrong — the budget exists so that
   * `email-agent serve` starts its server on a network where connections hang
   * rather than reset. See point 5 in the module header.
   */
  | "not-checked";

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

/**
 * The wall clock, injected, so the budget below is testable without sleeping.
 *
 * Separate from `StrandedVerificationDeps` on purpose: those are the three
 * SIDE-EFFECTING STEPS a caller may substitute, and reading the clock is
 * neither a step nor something a real caller would ever replace. Keeping them
 * apart is what stops `deps` from turning into a bag of knobs.
 */
export interface StrandedVerificationOptions {
  /** Wall-clock budget for the whole pass. Default `STRANDED_VERIFICATION_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
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

/** The 404 sentence, shared by both read passes so they cannot drift apart. */
const MESSAGE_MISSING_DETAIL =
  "Gmail has no message with this id in the mailbox we asked. That can mean it was deleted, that this change was queued without a named account and the Google identity has changed since, or — for a Trash or Spam change — that it worked and Gmail has since purged the message.";

/** The ADC sentence, shared by both paths that can reach an `applied` verdict. */
const UNSCOPED_ACCOUNT_DETAIL =
  "The message's labels match this change, but it was queued without a named Google account, so we cannot be sure which mailbox we just read. Confirming this one is left to you.";

/** The deadline sentence, shared by both passes. Says plainly that nothing happened to the row. */
const NOT_CHECKED_DETAIL =
  "Email Agent ran out of time checking Gmail before it got to this change, so it has not been checked and nothing about it has changed. The next fetch, or the next time the server starts, will check it.";

/**
 * How long ONE verification pass may spend, end to end.
 *
 * WHY A TOTAL AND NOT JUST A PER-READ BOUND. `gmail/read.ts` bounds each read
 * at 10s, but these reads are SERIAL (deliberately — see the note on the
 * function below about 429s), so N stranded rows on a network where
 * connections HANG rather than reset still costs N x 10s. `email-agent serve`
 * runs this before it spawns the web server, and a server that starts is the
 * entire point of that command.
 *
 * THE WORST CASE IS `deadline + one read deadline`, i.e. 30s, because the
 * budget is checked BEFORE each read and the read that starts just inside it
 * runs to its own bound. Do not read 20s as the ceiling.
 *
 * WHY 20s. It is a whole number of worst-case reads (two), which is the unit
 * this is actually spent in, and it is short enough that `serve` is visibly
 * starting rather than visibly stuck. It is a BUDGET, not a timeout: on a
 * healthy network a `format: "minimal"` read is a small fraction of a second,
 * so a realistic stale set — at most one chunk of 10 per crashed in-flight
 * caller — finishes in a second or two and never comes near this.
 *
 * WHAT IT COSTS. Rows the budget did not reach stay `applying` and come back
 * as `not-checked` residuals. Nothing is lost and nothing is guessed; the
 * queue simply drains over more than one pass. The check is skipped for the
 * FIRST row of pass one so that a pass always reads at least one row —
 * otherwise a run that inherited an already-spent clock would check nothing,
 * forever, and the queue would never drain at all.
 */
export const STRANDED_VERIFICATION_DEADLINE_MS = 20_000;

/** What one label read means for one row, before any ADC or write consideration. */
type RowOutcome =
  | { kind: "applied" }
  | { kind: "notApplied" }
  | { kind: "residual"; reason: VerificationResidualReason; detail: string };

/**
 * PURE. The read outcome -> row outcome mapping, in ONE place because BOTH
 * passes use it.
 *
 * A second copy for the re-read pass would be a second predicate table, and
 * this repo has already learned what a duplicated allowlist does: it drifts,
 * and the drift is the bypass. Every fail-closed case therefore holds
 * identically on a re-read, including the 404's three-way ambiguity.
 */
function classifyRow(
  row: PendingOperationRecord,
  read: MessageLabelRead,
): RowOutcome {
  if (read.kind === "notFound") {
    return {
      kind: "residual",
      reason: "message-missing",
      detail: MESSAGE_MISSING_DETAIL,
    };
  }
  if (read.kind === "noCredentials") {
    return { kind: "residual", reason: "credentials", detail: read.message };
  }
  if (read.kind === "error") {
    return { kind: "residual", reason: "check-failed", detail: read.message };
  }

  const verdict = verdictFromLabels(
    row.type,
    read.labelIds,
    parseLabelIds(row.labelIds),
  );
  if (verdict.kind === "unknown") {
    return {
      kind: "residual",
      reason: "unverifiable-operation",
      detail: verdict.reason,
    };
  }
  return verdict.kind === "applied" ? { kind: "applied" } : { kind: "notApplied" };
}

function pushResidual(
  result: StrandedVerificationResult,
  row: PendingOperationRecord,
  reason: VerificationResidualReason,
  detail: string,
): void {
  result.unresolved.push({
    id: row.id,
    emailId: row.emailId,
    accountId: row.accountId,
    reason,
    detail,
  });
}

/**
 * THE ONE PLACE AN `applied` VERDICT MAY BECOME AN `applied` WRITE.
 *
 * Two paths now reach a positive verdict — the first-pass read and the
 * second-pass re-read of a requeue candidate that flipped — and BOTH go
 * through here rather than each testing `accountId` for itself. A duplicated
 * check is how the second path silently loses the guard.
 *
 * The asymmetry it enforces is deliberate. "" is the gcloud ADC sentinel:
 * `createGmailClient("")` resolves whatever identity ADC points at NOW, which
 * is not necessarily the mailbox this message was read from. Recording
 * `applied` on that evidence would retire the row silently on a reading
 * possibly taken from a different account. A `notApplied` from the wrong
 * mailbox costs nothing by comparison — it requeues a proposal the user must
 * approve anyway — so only this direction is blocked. See point 3 in the
 * module header.
 */
function recordApplied(
  result: StrandedVerificationResult,
  row: PendingOperationRecord,
): void {
  if (row.accountId === "") {
    pushResidual(result, row, "unscoped-account", UNSCOPED_ACCOUNT_DETAIL);
    return;
  }
  result.appliedIds.push(row.id);
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
 * a 6,000/min budget (Gmail quota reference, read 2026-08-21). A row headed for
 * a requeue costs 40, because it is read TWICE (below); the budget swallows
 * that at this set size, and the second read is what keeps a stale `notApplied`
 * off the audit trail.
 *
 * TWO READ PASSES, AND THE SECOND ONE COVERS ONLY THE REQUEUE CANDIDATES.
 * Pass one classifies every stale row. Pass two re-reads just the rows pass one
 * would requeue, immediately before adjudicating them, because that is the one
 * verdict a late-landing hung apply can falsify — see point 4 in the module
 * header for what this narrows and what it leaves. A candidate that FLIPS to
 * `applied` on the re-read is recorded applied through the very same
 * `recordApplied` the first pass uses, so the `accountId: ""` refusal covers
 * both routes; a re-read that FAILS becomes a residual for a human and never
 * falls back to the first read.
 *
 * BOUNDED IN TOTAL, NOT ONLY PER READ. `STRANDED_VERIFICATION_DEADLINE_MS` is
 * checked before every read in both passes (see point 5 in the module header).
 * A pass may therefore end with rows it never looked at, reported as
 * `not-checked` residuals — untouched, and picked up by the next pass. This is
 * what lets `serve` block for a bounded time and then start its server whatever
 * the network is doing, and it costs `serve` nothing at all when nothing is
 * stranded, because the cheap gate above still runs first.
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
  options?: StrandedVerificationOptions,
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

  // THE BUDGET STARTS HERE, BELOW THE GATE, and the clock is not consulted
  // above it. The gate is a local DB read; the thing that needs bounding is the
  // serial Gmail phase below, which is the same distinction as "the budget
  // bounds the reads, not the writes". It also keeps the cheap-gate claim
  // literally true — nothing stranded costs one local query and NOTHING else,
  // not even a `Date.now()` — which is a claim a test can then enforce rather
  // than a sentence that merely reads well.
  const now = options?.now ?? Date.now;
  const deadlineMs = options?.deadlineMs ?? STRANDED_VERIFICATION_DEADLINE_MS;
  const startedAt = now();
  const outOfTime = (): boolean => now() - startedAt >= deadlineMs;

  // PASS ONE. Every stale row, read once, in order — as far as the budget goes.
  const requeueCandidates: PendingOperationRecord[] = [];
  for (const [index, row] of rows.entries()) {
    // THE BUDGET, CHECKED BEFORE THE READ RATHER THAN DURING IT. Each read is
    // already bounded by `gmail/read.ts`; what this bounds is HOW MANY of them
    // a single pass may cost, so that `serve` starts its server and `fetch`
    // exits. `index > 0` guarantees at least one row is always attempted: a
    // budget that could refuse the first row would drain the queue never.
    if (index > 0 && outOfTime()) {
      pushResidual(result, row, "not-checked", NOT_CHECKED_DETAIL);
      continue;
    }
    const outcome = classifyRow(row, await readLabels(row.emailId, row.accountId));
    if (outcome.kind === "residual") {
      pushResidual(result, row, outcome.reason, outcome.detail);
      continue;
    }
    if (outcome.kind === "applied") {
      recordApplied(result, row);
      continue;
    }
    // Not written down yet. A `notApplied` verdict is the ONE direction the
    // read-before-write window can corrupt, so it has to be refreshed first.
    requeueCandidates.push(row);
  }

  // PASS TWO. THE REQUEUE SET ONLY, re-read immediately before the write.
  //
  // WHY ONLY THIS SET. A stale `applied` is not a defect: the labels were
  // present when we looked, so an apply landing late agrees with the record we
  // are about to write. A stale `notApplied` IS a defect — it requeues a
  // change that has now happened, on an audit trail saying it did not, and a
  // later approval can send it to Gmail a second time. Re-reading the applied
  // set would buy nothing and spend quota.
  //
  // WHY IT IS WORTH A SECOND ROUND TRIP. Pass one is deliberately serial and
  // both writes are batched at the end, so row 1's evidence can be minutes old
  // by the time its claim lands. This shrinks that to one read and one write.
  //
  // WHAT IT DOES NOT DO: close the window. Gmail can still land between this
  // re-read and the write below — an external system and a local database
  // cannot be read and written atomically. NARROWED, never closed.
  //
  // STILL SERIAL, deliberately: see the note above about 429s. No `Promise.all`.
  for (const row of requeueCandidates) {
    // OUT OF TIME MEANS NO VERDICT, NEVER A REQUEUE ON PASS ONE'S EVIDENCE.
    // That evidence is exactly what the re-read exists to distrust: requeueing
    // on it puts a change that may since have landed back in the queue behind
    // an audit trail saying it never happened. There is no exemption for the
    // first candidate here — pass one has already had its guaranteed read, and
    // the guarantee is about the queue draining, not about this row.
    if (outOfTime()) {
      pushResidual(result, row, "not-checked", NOT_CHECKED_DETAIL);
      continue;
    }
    let reread: MessageLabelRead;
    try {
      reread = await readLabels(row.emailId, row.accountId);
    } catch (err) {
      // The production reader classifies rather than throws, so this is the
      // belt to that braces. A re-read we could not take NEVER falls back to
      // the first one: refusing to refresh evidence is refusing to have it.
      reread = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const outcome = classifyRow(row, reread);
    if (outcome.kind === "residual") {
      // No verdict on evidence we could not refresh. The row stays exactly as
      // it was, `applying`, visible to every stranded surface, for a human.
      pushResidual(result, row, outcome.reason, outcome.detail);
      continue;
    }
    if (outcome.kind === "applied") {
      // THE FLIP: the change landed between the two reads. Same guard as pass
      // one — `recordApplied` owns the ADC check for both, so this new route
      // to `applied` cannot bypass it.
      recordApplied(result, row);
      continue;
    }
    result.requeuedIds.push(row.id);
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

/**
 * How many of the rows this pass looked at are STILL left for a human,
 * whether or not `unresolved` says so.
 *
 * `unresolved.length === 0` is NOT the same claim, and a caller that treats it
 * as one can tell a user "nothing left to look at" while a row sits in
 * `applying`, unlisted anywhere. The gap: `appliedIds`/`requeuedIds` record
 * every row the READ half of the pass decided on, but the two `adjudicate`
 * calls at the end can write FEWER rows than that — `adjudicateStranded
 * Operations` re-checks the staleness cutoff at write time, so a row an
 * in-flight apply re-claims (re-stamping `claimedAt`) between the read and
 * the write matches nothing there. That row was never pushed to `unresolved`
 * (the read succeeded and produced a verdict), and it was never actually
 * recorded either — it is exactly as stuck as before this pass ran, and
 * nothing here will surface it unless a caller checks for this.
 *
 * Every row this pass looked at lands in exactly one of three buckets:
 * `appliedIds`, `requeuedIds`, or `unresolved` — so structurally `checked ===
 * appliedIds.length + requeuedIds.length + unresolved.length`. Recorded
 * counts can only be LOWER than the decided-id-array lengths (a write can
 * lose a race; it cannot invent a row), so:
 *
 *   checked - appliedRecorded - requeuedRecorded
 *     = unresolved.length + (decided - recorded)
 *     >= unresolved.length
 *
 * with equality — zero extra — only when every decided row's write actually
 * landed. Zero is the only value that means "nothing here needs a human";
 * anything above it does, even with an empty `unresolved` array.
 *
 * A caller acting on a non-zero result should re-read the current stranded
 * list rather than trust `appliedIds`/`requeuedIds` for row DATA: those
 * arrays carry ids only, and a row can leave `applying` for reasons unrelated
 * to this pass (another surface adjudicated it, a fresh apply re-claimed it)
 * between this call returning and the caller acting on it.
 */
export function strandedRowsRemaining(result: StrandedVerificationResult): number {
  return result.checked - result.appliedRecorded - result.requeuedRecorded;
}
