# TODOS

Deferred work, grouped by component then priority (P0 highest). Completed items
move to the bottom section with the branch and date that shipped them (this repo
does not version its packages independently).

## Approval gate — enforcement boundaries

These are the gate's known limits. It stops the AI action pipeline from
mutating Gmail without approval; it is not a sandbox against local code.

**Read this before any other entry in this section.** The gate protects the
app's own mutation path. It is not, and cannot be by any barrel/exports
mechanism, a control against *malicious local code*: such code never needs a
core symbol at all — `import("node:fs")`, read the stored OAuth tokens at
`~/.email-agent/accounts/{email}/token.json` (scope `gmail.modify`), and call
the Gmail REST API over https directly — mailbox mutated, zero queue rows,
nothing in this repo touched. That case is out of scope here and always was.
What changed is that it no longer has an entry point through the action
pathway.

**The main defense is that action files never execute**, not the barrels and
not the save-time check. `extractActionData()`
(`actions/action-source-guard.ts`) parses an `ACTIONS_DIR` file with the
TypeScript compiler and statically evaluates it, returning the action object
without the file ever entering the module graph — `loadUserAction()` and
`ActionRegistry`'s user-directory pass both use it, and the
`new Function("p", "return import(p)")` hatch is gone. `EmailAction` is pure
data (five strings, two booleans) and `mapSingleResult` maps only the built-in
`junk`/`subscription` ids, so an action never needed to be code in the first
place; treating it as data removes the whole class of problem instead of
policing it.

The allowlist is unchanged and is now enforced at both ends:
`findActionSourceViolations()` (save time, so the model gets a 422 it can act
on) is literally `analyzeActionSource()` with the extracted values discarded.
One traversal, deliberately — a second, parallel evaluator would drift, and the
drift would be a bypass. A file that passes contains no call, member access,
`new`, function, tagged or interpolated template, spread, computed key or
getter.

It must stay an AST allowlist. The first version was a regex denylist over a
string-stripped skeleton, and review defeated it completely in one line —
`({}).constructor.constructor("return process")()` names the Function
constructor without spelling it, and the payload rides inside a string the
scanner had already blanked. A second bypass, `export { default as type } from
"data:text/javascript,..."`, executed a live data URL because the type-only
check matched the word `type` anywhere.

The allowlist version then had a hole of its own, worth remembering because it
was semantic rather than syntactic and no parse check could have caught it:
`declare const process = "safe"` is an AMBIENT declaration, so it binds nothing
and is erased whole, and every later mention of `process` resolves to the real
global — while the guard had recorded the name as data and every expression
still looked like a literal. Ambient statements and decorators are refused now,
as is `using` (its disposal hook is a call the file never spells) and
`__proto__` as an object-literal key (it sets a prototype rather than binding a
property — found while making the evaluator produce values, because that is the
first time the difference became observable). All of these are regression
tests. The lesson to carry, and it now applies to name→VALUE resolution too:
ask not "is this syntax inert?" but "does this syntax BIND what it appears to
bind at runtime?"

Two facts that used to scope this section, both measured 2026-08-06 and now
historical, since nothing from `ACTIONS_DIR` is imported at all:
- From the real `ACTIONS_DIR` (`~/.email-agent/actions`) NO bare specifier
  resolved — `@email-agent/core`, `@email-agent/core/gmail` and even
  `googleapis` gave `ERR_MODULE_NOT_FOUND`. (Verify with
  `--experimental-import-meta-resolve` and an explicit parent — the two-arg
  `import.meta.resolve` silently ignores the parent without it and reports a
  false positive.)
- The declared Node floor was 20.12, which cannot strip TS types, so
  `.action.ts` files did not import at all there. The floor is now `>=22.18.0`,
  which strips types unflagged; that still matters for the in-repo built-in
  actions, which are real modules, but no longer for user actions.

### Malicious local code outside the action pathway
**Priority:** P3 (documented residual — the honest statement of what is NOT
covered; not a work item, and not fixable in-process)
Nothing in `ACTIONS_DIR` executes any more, whatever put it there — generated,
legacy pre-guard, or hand-dropped alike. That closes both of the P2 residuals
this entry replaces (a user action enqueueing and self-applying its own queue
rows; a user action calling `saveSettings` to arm auto-apply for itself), and
it closes them at the source rather than at the approval surface: there is no
longer an untrusted caller in the process to make either call.

The proposed fix for both — "approval provenance", a credential proving
`applyPendingOperationsByIds` was reached from a real user surface — was
**rejected**, and should not be re-proposed:
- ESM module identity is per-resolved-URL and process-global, so any function
  the CLI can call, in-process code can call with identical standing. There is
  no unforgeable caller identity inside one Node process.
- The runner's auto-apply path calls apply with no user surface in the loop,
  so the credential would have to be grantable to `ActionRunner.run`, a public
  export. The boundary leaks by design.
- A hostile file defeats any in-process token by spawning a fresh `node` where
  it is the entrypoint — or skips the game and reads the OAuth tokens.
- Stack-origin checks are spoofable via `Error.prepareStackTrace` and break
  legitimate web callers; entrypoint registration breaks under Next HMR.

What remains uncovered, stated plainly so nobody reads more into the above than
is there: any local code running outside the action pathway can read
`~/.email-agent/accounts/{email}/token.json` (scope `gmail.modify`) and drive
the Gmail REST API itself, touching nothing in this repo. Containing that needs
out-of-process isolation of the whole app, not of actions, and is out of scope
for this section. The claim is "the action pathway cannot execute code", not
"the machine is sandboxed".

### No end-to-end denied-case test with an injectable `ACTIONS_DIR`
**Priority:** CLOSED (2026-08-07)
`ACTIONS_DIR` is now a parameter throughout `user-actions.ts`, defaulting to the
homedir constant, and `ActionRegistry` takes `{ userActionsDir }`. The checked-in
test is `load-path-denied.test.ts`: six genuinely malicious `.action.ts` /
`.action.js` files, each writing a marker file at module evaluation time,
through six different spellings — a plain `import { writeFileSync } from
"node:fs"`, a bare member-access side effect on a global, the Function
constructor reached as `({}).constructor.constructor`, a live `data:` URL behind
`export { default as type } from`, a `using` disposal hook, and the same payload
as `.action.js`. Each is first imported natively in a subprocess and the marker
MUST appear, so a payload that is quietly inert cannot pass the test by being
harmless. They are then loaded through the real `loadUserAction()`,
`ActionRegistry.loadAll()` and `listUserActions()`, and the markers must not
exist, no action may load, every refusal must warn by filename, the built-ins
must still be present (or "nothing executed" is trivially true), and the files
must still be on disk afterwards.

This is what replaces the claim the AST scan was making. That scan only
recognises loader calls whose callee it enumerates — a reviewer defeated it with
`globalThis.Function("p", "return import(p)")` bound to a local name — so it is
now described as a fast tripwire and nothing more. No syntactic scan can honestly
claim "however it is spelled"; a behavioural assertion does not have to.
Found by: testing specialist during /review (2026-08-06). Closed by the
second adversarial review pass (2026-08-07).

### `POST /api/actions` answers 404 for a file that WAS found
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`packages/web/src/app/api/actions/route.ts:64` returns a flat
`{ error: "Action not found" }` whenever `loadUserAction()` yields nothing. Two
different situations reach that line: no file answers to the id at all, and a
file answers to it and cannot be loaded — a numeric `id`, a value import, a
construct the evaluator refuses. The second is now diagnosed loudly in the
server log by `loadUserAction()`, but the user sees the same 404 either way and
the reason never reaches the browser.

`UserActionMeta.problem` (from `listUserActions()`) carries the exact reason.
The route now looks the id up and answers **422 with that reason** when a file
presents it, reserving 404 for an id nothing on disk presents.
`modules/api/actions.route.test.ts` drives the real handler against a real temp
`$HOME` with two real files — one that loads and one the evaluator refuses — and
also asserts that `GET` still LISTS the unloadable file, without which the id in
the 422 would not be something the user can act on.
Found by: codex (gpt-5.6-sol xhigh) adversarial pass, round 2 (2026-08-07).

### If `EmailAction` ever gains an executable field, extraction stops being enough
**Priority:** P3 (conditional — no work until the trigger)
Pure-data extraction works because `EmailAction` is five strings and two
booleans. The moment a field has to be code — a custom result mapper, a
lifecycle hook, a template function — a parser cannot produce it, and the only
honest ways forward are (a) don't ship the field, or (b) load actions
out-of-process. If (b): a child `node --permission` with no `--allow-fs-read`
of `~/.email-agent` and no `--allow-child-process` is the shape, and this must
land BEFORE the field does, not after.
Note precisely what that would and would not buy: Node's permission model does
not restrict network egress. The isolation claim would be "no token or
filesystem access", never "no exfiltration" — an isolated action could still
POST anything it was given to an arbitrary host. Do not let the word "sandbox"
into the docs on the strength of it.

### The consent flag records consent, it does not prove the warnings were seen
**Priority:** P3
`normalizeSettings` checks only that `autoApplyAcknowledged` is `true`, never
where it came from. `config set` refuses both keys and the web UI shows the
cautions before recording it, but hand-editing `~/.email-agent/settings.json`
to set both booleans arms unattended mutation with no warning displayed. That
is arguably fine (the local user owns the file), but it should be stated as the
threat model rather than implied away. Docs now say "consent recorded", not
"UI only".

`normalizeSettings` no longer spells the rule out itself: it calls
`normalizeAutoApplyConsent`, the single shared implementation
(`feature/todos-w4b-config`, 2026-08-07). What it checks is unchanged.

The prototype-pollution half of this entry is **done in core, unadopted in the
CLI** (same branch). `config/dotted-path.ts` provides
`setNestedConfigValue`/`getNestedConfigValue`, which refuse `__proto__`,
`constructor` and `prototype` in any position — including the terminal one,
where `__proto__` sets a prototype rather than binding a property — and refuse
before touching the target object. It is hygiene, NOT a fix for a live hole: the
route was probed and does not work today, because `normalizeSettings`
materializes both consent flags as OWN properties on every load and save and an
own property shadows the polluted prototype (verified by running exactly that —
`"autoApplyAcknowledged" in gmail` is true either way, but the value read is the
own `false`). The reason to add the guard anyway is that the safety belongs to a
different function, holds only while that function materializes every key, and
was written down nowhere. `packages/cli/src/commands/config.ts` now calls the
shared helpers (feature/todos-w10-cleanup (2026-08-07)), so the guard finally has a caller; the
threat-model half of this entry is unchanged and stays open as a statement
rather than a task.

## Core actions / approval queue

### THE SURFACES WAVE — adopted
**Completed (items 1, 2 and 4):** feature/todos-w7-surface-adoption (2026-08-07)
**Completed (item 3):** feature/todos-w3-tests (2026-08-07)
**Priority:** CLOSED. Kept here rather than moved wholesale because items 1, 2
and 4 describe behaviour that is still current; item 3's closure has its own
Completed entry.

Wave 1 (feature/todos-w1-queue) added core data and core capabilities and
changed **nothing** about what the web UI or the CLI shows. This wave wired it
to the surfaces. What a user can now actually see:

**1. `applyError` / `persistError` / `duplicateOperations` are read. DONE.**
`describeActionRunOutcome` (`packages/web/src/modules/api/action-run-contract.ts`,
used by `app/actions/page.tsx`) and `describeRunOutcome`
(`packages/cli/src/commands/run-action.ts`) both branch on `applyError` FIRST
and print core's `describeAutoApplyFailure` string verbatim. Neither reports the
batch as awaiting approval on that branch, and the CLI does not prompt to apply
anything — those rows are `applying`, not `pending`, which is what made the old
messages false. `persistError` and `duplicateOperations` are surfaced too. Both
wordings are pure functions with tests; the components/commands only pick a tone
and print. Also fixed on the way: `promptApproval`'s empty-queue message, which
claimed rows "could not be queued — nothing was applied" for rows that were
definitely queued and had since been claimed or resolved elsewhere.

**2. `getStaleApplyingOperations()` has callers. DONE.**
`GET /api/approvals/stranded` → `StrandedOperationsPanel` (rendered above the
approval panel on `/actions`), and `email-agent approvals stranded [--review]`.
`approvals list` points at it too, because a `pending`-scoped list saying "no
Gmail changes awaiting approval" was the only thing a user with an unaccounted-
for mutation saw. Adjudication is `adjudicateStrandedOperations(ids, "applied" |
"notApplied")` (core), claim-then-write by token, with the staleness cutoff
re-asserted inside the same atomic write predicate — so neither a row an apply
already resolved nor one an apply claimed inside the threshold can be
overwritten. What it still does not cover has its own entry below ("An apply
hung past the staleness threshold still loses its outcome"); do not describe
this as closing the in-flight window. **Two answers, no retry, and — AS OF THIS
WAVE — no verification:** the buttons say "I checked Gmail — it happened" /
"— it didn't", the toast says the outcome was recorded "on your word", and an
`applied` row carries `STRANDED_APPLIED_NOTE` saying Email Agent did not check.
Skipping is a first-class answer. Do not describe any of this as recovery.

**Corrected 2026-08-22, in verification of M1:** the "no verification" clause
above is no longer true of these surfaces and is kept dated rather than
deleted, so the wave that shipped it stays attributable. feature/todos-w11-
bugfixes added `verifyStrandedApplyingOperations()`, which reads each stranded
row's CURRENT labels back from Gmail and resolves what it can before a person
is asked — run automatically at `email-agent fetch` and `email-agent serve`
startup, once per `StrandedOperationsPanel` mount via
`POST /api/approvals/stranded/verify`, and inline by `approvals stranded`. The
human wording above therefore now applies only to the RESIDUAL that check
could not answer: a row it resolves itself carries `STRANDED_VERIFIED_NOTE`
and `resolutionEvidence: "verified-api"`, not `STRANDED_APPLIED_NOTE`. What did
NOT change: neither source establishes CAUSATION, nothing re-applies, nothing
rolls back, and this is still not recovery.

**3. A test must go through a surface. DONE** (feature/todos-w3-tests) — see
"THE SURFACES WAVE item 3" in Completed for what the CLI and web tests cover.
The pure-function tests named here still exist and still pin the wording; what
has changed is that the WIRING is now checked too, so a page or command that
stopped calling its formatter, or a route that stopped returning the field,
fails a test.

**What that closure does NOT include, stated because it is easy to lose:** React
component rendering — **narrowed, feature/todos-w11-bugfixes (2026-08-22):** a
component testing library now exists and `ApprovalPanel`/`StrandedOperationsPanel`
are rendered and mutation-checked by `approval-panel.test.tsx` /
`stranded-operations-panel.test.tsx` (see the Testing section's harness entry
for what they cover) — and a successful Gmail mutation (no linked account,
unchanged, so every apply path in the tests ends in a per-operation failure).
The `app/actions/page.tsx` server component itself is also not rendered by a
test — the route it calls is.

**4. The retention window has a surface. DONE** — see its own entry below.

Found by: wave 1 (feature/todos-w1-queue, 2026-08-07); scope corrected after
the codex (gpt-5.6-sol xhigh) review of PR #8, 2026-08-07, which found the
branch describing these as fixed.

### The adjudication count can undercount (the stale-handle half is closed)
**Priority:** P3 for the undercount; the stale-handle half closed on feature/todos-w10-cleanup (2026-08-07)
**Unchanged by "Verify a stranded apply against Gmail" (Completed, feature/todos-w11-bugfixes, 2026-08-21):**
`verifyStrandedApplyingOperations()` writes through this exact same
`resolveStrandedApplyingOperations`/`adjudicateStrandedOperations` path — it is
not a second writer with its own count — so the undercount property below
applies identically whether the evidence is `"user-confirmed"` or
`"verified-api"`.
**Found while fixing stranded adjudication:** a LanceDB `Table` handle is PINNED to the
version it was opened at. A handle another writer has moved past reads OLD rows
with no error and THROWS `Commit conflict for version N` on write;
`checkoutLatest()` refreshes it in place. Verified on a real table against
`@lancedb/lancedb` 0.15.0, 2026-08-07.

**The stale-handle half is done, and it found a live bug.** Two further facts
were measured against 0.15.0 while doing it: `table.delete()` on a stale handle
THROWS the same commit conflict `update()` does, and `countRows()` answers from
the stale snapshot with no error (6 where the table held 5).
`prunePendingOperations` counts and then deletes — two steps on one handle — and
its only caller swallows failures with a warning by design, so the retention
sweep quietly stopped running whenever anything else was writing, on an
append-only table. It now goes through a new `deleteAtLatestVersion` plus a
refresh before the count (`db/prune-stale-handle.test.ts`, which establishes the
raw hazard first so the fix's case is known to be exercising something).

The rest is answered rather than swept: the module header now names every
function here as SINGLE-STEP (one fresh handle, one operation, nothing after it
to go stale — `getPendingOperations`, `getPendingOperationsByIds`,
`getPendingOperationsForEmails`, `countPendingOperations`,
`savePendingOperations`, and `getStaleApplyingOperations`, which delegates) or
MULTI-STEP (routed). `db/emails.ts` and `db/clusters.ts` are named too, with why
they deliberately keep taking the raw error: `upsertEmails` and `saveClusters`
are delete-then-append pairs on single-write non-queue paths, where an error
surfacing to a caller who can repeat the action is the right outcome. A failed
`fetch` is repeatable; a queue write that is supposed to lose a race quietly is
not. `db/actions.ts` turned out to be single-step throughout.

**Still open, and it is the half that cannot be fixed from here:**
`resolveStrandedApplyingOperations` can UNDERCOUNT what
it wrote. A `notApplied` row written back to `pending` can be claimed by a fresh
apply before the count read, which re-stamps the token and hides the row from
it. Undercounting understates what we did; overcounting would claim credit for
another answer, so the direction is deliberate. Making it exact needs a count
LanceDB's `update()` does not return.
Found by: work on the PR #13 review, 2026-08-07.

### Concurrent applies over one batch are not serialized
**Priority:** P3
`applyPendingOperationsByIds` claims per chunk, so the set a crash can strand
in `applying` is bounded by one chunk **per in-flight caller** — not one chunk
per batch. Two concurrent applies leapfrog: A claims ids 1-10 and starts
calling Gmail; B loses those to A's claim, does not stop, and claims 11-20
while A is still in flight. A process death now leaves twenty rows claimed.
The bound is now qualified as per-call in the code comment, both root memory
files, the actions module card and here, and pinned by a regression test in
`actions/approval.test.ts`. Making it "one chunk, full stop" needs
batch-level serialization of applies (a lock keyed on `batchId`), which was
not done: the realistic trigger is a user approving the same batch from the
web and the CLI at the same moment, and the consequence is stranded rows that
`getStaleApplyingOperations()` can already list, not a mutation without
approval.
Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.

### Enqueue dedupe is best-effort, not race-free
**Priority:** P3
`enqueueOperationsDetailed` is a check-then-insert: it reads the still-pending
rows for the batch's emails, then writes. Two concurrent action runs (a
`serve` and a CLI run, or two runs of the same action) can both finish the
read before either writes, and both then insert rows with distinct UUIDs. The
queue shows duplicate pending proposals for the same change and permits both
to be applied. Documented as best-effort everywhere it is described; do not
restate it as a uniqueness guarantee.

**Severity depends on auto-apply, and the earlier wording understated it.**
With the approval gate on (the default) the duplicate is a redundant proposal
the user can see and reject — benign. With `gmail.autoApplyActions` on, each
racing runner immediately applies its own queued ids, so neither duplicate is
ever pending for review and **Gmail receives both calls** for the same change.
There is nothing to reject. Do not describe this as "a duplicate the user can
reject" without naming that case.

Not fixed, deliberately. LanceDB's only insert-if-absent primitive is
`mergeInsert(on).whenNotMatchedInsertAll()`, which matches on column equality
alone and cannot express "insert unless a matching row is PENDING". Keying on
the dedupe identity would suppress re-proposals after a rejection or an apply
— and a suppressed re-proposal is invisible, leaving the user nothing to act
on, which is strictly worse than a duplicate they can see and reject. Fixing
it properly needs either a `pending`-scoped uniqueness mechanism LanceDB does
not offer, or an application-level lock around enqueue, at the cost of a
filesystem lock per run. (`db/migration-lock.ts` used to be exactly that
primitive and is deleted — the migrations no longer need a lock. Do not
resurrect it speculatively; write it here if and when this is actually
fixed.) Do not weaken the PENDING scoping to get it.
Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.

### The retention window is visible, and so is the sweep
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
**Partly completed:** feature/todos-w7-surface-adoption (2026-08-07)
`retention.approvalQueueDays` governs pruning of resolved `pending_operations`
rows. It is now returned by `sanitizeSettingsForResponse`, accepted by
`SettingsUpdate` (whole days, 0-36500, 0 = never prune; the upper bound only
stops a value large enough to make the cutoff date invalid and turn the sweep
into a silent no-op), and editable on Settings → Gmail with the consequence
stated — resolved records are deleted permanently, `pending`/`applying`/`failed`
never are. `normalizeRetentionConfig` fills a missing block with the built-in
365 rather than 0, because 0 means "keep forever" and defaulting to it would
promise the opposite of what core's sweep does. The page holds the field's raw
string and parses it through `modules/api/retention-contract.ts`, so a cleared
input is `null` rather than the 0 `Number("")` yields — an empty field no longer
silently means "keep forever" — and its pre-load value comes from the settings
response rather than a client-side literal, so no second copy of the default
exists to drift from `defaultConfig`.

**Now closed** (feature/todos-w10-cleanup (2026-08-07)). `email-agent approvals prune
[--older-than-days N] [--dry-run]` makes the sweep something a user can run and
see the result of. `--dry-run` counts through the SAME predicate the delete
uses, rather than a second one written to match it. `describePrune` is pure,
because every sentence it produces is a promise about deleted audit rows: which
statuses are eligible, which never are, that the count is advisory, and that 0
days means KEEP FOREVER — `Number("")` is 0 and 0 is the documented opt-out, so
a command reading it as "cutoff = now" would delete the audit trail of the user
who most explicitly asked to keep it. Six e2e cases through the built binary,
asserting which rows survive rather than what was printed.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07).

### Tighten the two fields declared optional for the surfaces' benefit
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`PendingOperationRecord.claimedAt` and `AppConfig.retention` are both
declared optional purely so the `PendingOperationRecord` / `AppConfig`
literals in `packages/cli/src/commands/approvals.test.ts` and
`packages/web/src/modules/api/validation.test.ts` kept compiling while core
changed on its own branch. Neither is optional in reality: the Arrow column
is non-nullable and `normalizeSettings` always populates `retention`. Both are
required now and the three fixtures carry the fields. Nothing in product code
needed changing, which is the evidence that the optionality was only ever about
the fixtures. Worth stating why it mattered beyond tidiness: an optional
declaration on a field that is always present invites a caller to write a
fallback for an `undefined` the system cannot produce, and the fallback a reader
reaches for on `retention` is `0` — which means "keep every record forever", the
opposite of what core's sweep does with a missing block.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07).

### The batched email lookup is duplicated in two surfaces
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`buildEmailLookupFilter`/`getEmailsByRefs` exist twice —
`packages/web/src/modules/api/email-lookup.ts` and
`packages/cli/src/email-lookup.ts` — including a hand-copied `escapeSql`. They
were written at the surface layer because `packages/core` was owned by another
branch during wave 2 and the CLI may only import the core barrel. This belongs
in `core/src/db/emails.ts` as `getEmailsByIds(refs: {accountId, id}[])` next to
`buildEmailFilters`, exported from `db/index.ts`, with both surfaces deleting
their copy. Two copies of a LanceDB predicate builder is exactly the shape that
drifts — the backticked `accountId`, the never-chain-`.where()` rule and the
`.limit()` have to stay right in both, and it has now gone wrong in both at once
TWICE: the review of PR #10 caught `limit(refs.length)` in both copies, and
feature/todos-w3-tests found that the replacement (no limit at all, justified by
a comment asserting LanceDB's default limit applies to vector searches only)
capped the lookup at ten emails in both copies. Both now pass
`UNLIMITED_QUERY_ROWS` from the core barrel.

**Closed on feature/todos-w10-cleanup (2026-08-07).** `getEmailsByIds(refs: {accountId, id}[])`
lives in `core/src/db/emails.ts` next to `buildEmailFilters` and
`buildEmailReplacementFilter` — which is where the two rules it depends on were
already written down — with `emailRefKey`, `buildEmailLookupFilter` and the
`EmailLookupTable` seam, exported from `db/index.ts`. Both surface copies are
deleted, hand-copied `escapeSql` included. The two test files merge into
`db/email-lookup.test.ts`, which deliberately does NOT use `useTempHome()`, for
the reason both predecessors did not: the duplicate-`(accountId, id)` case
cannot be produced through `upsertEmails`, which replaces that pair.
`no-chained-where.test.ts` loses both allowlist entries, so its sweep now proves
there is no LanceDB query surface outside `db/` other than the two test helpers.

**The P4 sub-bullet below is now CLOSED — feature/todos-w11-bugfixes
(2026-08-21).** `emailSchema` in `db/connection.ts` now states the invariant
where the schema is defined: row identity is the pair (`accountId`, `id`),
exactly one row per pair is expected, and it is upheld by ONE writer
(`upsertEmails` deleting the pair before appending) rather than enforced —
LanceDB has no primary key or unique constraint, so nothing rejects a second
row. `getEmailsByIds` no longer picks "last row scanned wins": it picks the
newest `date` deterministically, via `Date.parse` rather than a string
compare — `EmailRecord.date` is the raw RFC-2822 `Date:` header off the
message, and lexical and chronological order disagree on it (`"Fri, 1 Jan
2027"` sorts before `"Mon, 2 Feb 2026"` as a string). An unparseable date
ranks below any real timestamp, and a genuine tie keeps the incumbent — two
rows sharing a pair and a date have nothing to distinguish them, so which one
wins is documented as arbitrary. `db/email-lookup.test.ts` covers newest-wins,
order-independence, parseable-beats-unparseable in both scan orders, and the
tie case. Landed in 2032a46.

Original text, superseded above:
  - The duplicate-row case the `.limit()` fix now tolerates would be better
    prevented: nothing enforces one row per `(accountId, id)` in the `emails`
    table. `upsertEmails` deletes that pair before appending it (it no longer
    merges — see the fetch entry in Completed), so a duplicate can only arrive by
    another path, but the invariant is unwritten and unenforced. Either state it
    where the schema is defined or make the lookup pick deterministically
    (newest `date` wins) rather than "last row scanned wins". **Priority: P4.**
Found by: audit wave 2 (todos-w2-surfaces), 2026-08-07.

### action_results `accountId: ""` carries two meanings
**Priority:** P4 (decision recorded 2026-08-07 — do not re-open without the
trigger below)
`""` means either "legacy/unscoped ADC row" or "an all-accounts run whose emails
spanned more than one account" — a single-account batch resolves to that account
via `deriveResultAccountId`, but a mixed batch falls back to the same sentinel as
legacy rows. Account-filtered history therefore cannot represent a genuine
multi-account run.

**Deliberately not fixed, and the argument is the point of this entry.** The
ambiguity is currently unobservable: `getActionResults` has exactly one reader in
the whole repo (`packages/web/src/app/api/actions/[id]/results/route.ts`), and it
filters by `actionId` only — the `accountId` option has **no caller at all**
(checked 2026-08-07). Both candidate fixes would therefore ship a stored
representation nothing reads, which is the failure mode three other entries in
this file are already about.

Neither candidate is cheap, either:
- A `mixed` marker separates legacy from mixed, but a scalar column still cannot
  make a multi-account run visible under *either* account's filter — the
  user-facing half of the problem — and it adds a third sentinel every future
  reader has to learn, which must also be a value no email address can take.
- Per-account result rows break `batchId = action_results row id`, the key every
  `pending_operations` row is stamped with. One run would produce N history rows
  and a queue batch can only point at one, so the audit-trail join would have to
  be redesigned and both surfaces changed with it.

**Trigger for revisiting:** the first caller that passes `accountId` to
`getActionResults`. The shape to reach for then is an `accountIds` JSON-array
column (`"[]"` for legacy rows, added in place with `ensureTableColumns` — the
migration is cheap now) filtered in JS, which `getActionResults` already does for
sorting, rather than another scalar sentinel. Recorded at the declaration in
`db/schema.ts` and in the db module card. Same theme as "Ambiguous account
identity for queued unscoped rows" below, different table.

## Core agents / executors

Opened by the codebase audit and its Codex (gpt-5.6-sol) review passes,
2026-08-06. The executor layer was the weakest area of the audit: it had been
swallowing failed runs, dropping system prompts, and parsing obsolete CLI
output shapes. Those are fixed; what follows is what the fixes did not reach.

### Gemini token counts are source-verified, never live-verified
**Priority:** P3
Narrowed by `feature/todos-w4-executors` (2026-08-07). The codex half of the
original entry is now fully verified live and has moved to Completed; the gemini
half is not, and cannot be on this machine.

**Verified** — by reading the installed `@google/gemini-cli` 0.54.0 package
itself (its `JsonFormatter`, its `uiTelemetry` metrics initialiser, and its
shipped `docs/cli/headless.md`):
- The `--output-format json` envelope is
  `{session_id?, response?, stats?, error?, warnings?}`.
- For that format the CLI passes `uiTelemetryService.getMetrics()` straight
  through as `stats`, so the shape is
  `stats.models[<model>].tokens = {input, prompt, candidates, total, cached,
  thoughts, tool}` alongside `stats.tools` and `stats.files`.
- There is **no `stats.totalTokenCount`**. The executor had been reading exactly
  that field, so every gemini run silently recorded 0 tokens. Fixed: sum
  `stats.models[*].tokens.total`, which derives from the GenAI SDK's
  `usageMetadata.totalTokenCount` and is already a true total.
- `JsonFormatter.formatError()` emits `error` with **no** `response` field, so a
  failed run used to parse to empty text and persist as a successful empty
  answer. It now throws.

**Still unverified:** no live gemini invocation has produced any of these
payloads. `gemini` 0.54.0 *is* installed here, but it is **unauthenticated** —
it opens an interactive browser OAuth prompt and blocks, which is not something
an agent can complete on the user's behalf. The fixtures in
`gemini-executor.test.ts` are therefore derived from source, not observed. One
authenticated run would settle it; until then treat the numbers as
well-evidenced but unconfirmed.

### `isAvailable()` reports gemini usable when it is merely installed
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
Found while investigating the above (`feature/todos-w4-executors`, 2026-08-07).
`GeminiExecutor.isAvailable()` probes `npx --no-install @google/gemini-cli
--version`, which answers "is the CLI present", not "can it run a prompt". On
this machine it returns **true** while the CLI is unauthenticated, so the router
will select gemini as a fallback and then block on an interactive OAuth prompt
until the 120s `execFile` timeout kills it — a dead agent run per attempt,
surfacing as a timeout rather than a usable error.

**Fixed, and verified live in the direction that matters.** Two changes, both
from facts read out of the INSTALLED `@google/gemini-cli` 0.54.4 rather than
from documentation:

- `geminiCredentialSource()` checks the locations the CLI itself reads —
  `GOOGLE_API_KEY`/`GEMINI_API_KEY` (`getApiKeyFromEnv`),
  `<homedir>/.gemini/oauth_creds.json` and `GOOGLE_APPLICATION_CREDENTIALS`
  (`fetchCachedCredentialsList`), the `GOOGLE_GENAI_USE_VERTEXAI` +
  `GOOGLE_CLOUD_PROJECT` pair, and the `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE`
  keychain opt-in. `isAvailable()` requires presence AND one of those.
- `execute()` spawns with `NO_BROWSER=1` (`noBrowser: !!process.env["NO_BROWSER"]`
  in the CLI's own config builder), so it can never open a consent screen nobody
  is watching. An unauthenticated run then fails fast with gemini's
  `FatalAuthenticationError`, translated into a message naming the fix — the
  CLI's own wording says "run it in an interactive terminal", which is not
  something this process can do on the user's behalf.

Measured on this machine, gemini installed and unauthenticated: `isAvailable()`
now false in 0ms where it was true, and `execute()` throws in ~3.9s where it hung
for 120s. The presence probe also gained a 15s timeout; it had none.

**What this does NOT establish, and must not be read as:** that the credentials
WORK. An expired refresh token, a revoked key and a mistyped project all look
identical from here, and only a real call can tell. The probe is deliberately
generous at the edges (the keychain and Vertex cases are believed rather than
inspected) because a false negative silently drops a usable agent, while a false
positive now costs one fast, clearly-worded failure instead of a two-minute
hang. A SUCCESSFUL gemini run remains unverified — see the entry above, which
stays open.

### direct-api / OpenRouter have still never made a live call
**Priority:** P3
Narrowed by `feature/todos-w4-executors` (2026-08-07).

**Now covered**, with no network and no API key, by driving both executors
against a local `node:http` stub on an ephemeral port
(`agents/api-executors.test.ts`; both gained an injectable
`baseURL`/`apiKey`/`model`, defaults unchanged): the exact request shape we send
(model, a leading `system` message rather than a concatenated prompt, the user
message, `max_tokens`, the 0.3 temperature default, auth header), success
mapping to `AgentResult`, HTTP error propagation, malformed response body, empty
`choices`, absent `usage`, and abort propagation both mid-flight and
already-aborted. `apiExecutorOrder()` and availability semantics remain
unit-covered.

**Still unverified:** the stub asserts our request against the *documented*
OpenAI chat-completions contract — it cannot show that the real providers accept
it, nor that their error and usage payloads match the fixtures. OpenRouter's
usage accounting and error envelope in particular are assumed OpenAI-compatible
on the strength of its compatibility claim, not observed. The first live call is
still the first test of the contract; it is simply no longer also the first test
of our own plumbing. Doing it needs a funded key and explicit authorisation to
spend.

## Core config

### The consent invariant is shared but not yet adopted by web
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
**Half done** by `feature/todos-w4b-config` (2026-08-07); adopted on this wave. Core now has ONE
implementation of "autoApplyActions requires autoApplyAcknowledged" —
`normalizeAutoApplyConsent` in `config/settings.ts`, called by
`normalizeSettings`, exported from `@email-agent/core/config`, with the truth
table and the truthy-non-boolean refusals under test.

`normalizeGmailConfig` in `packages/web/src/modules/api/validation.ts` is now a
CALL to `normalizeAutoApplyConsent`, imported from `@email-agent/core/config` —
the specifier that file already used for `defaultConfig` and `AppConfig`. The
second ENFORCEMENT point stays, deliberately: a settings PUT that somehow
bypassed core's `normalizeSettings` must still not be able to arm unattended
Gmail writes. Only the second IMPLEMENTATION is gone. The 36 existing
`validation.test.ts` cases, including the truthy-non-boolean refusals, pass
unchanged — which is the check that the two bodies really were identical.

## Web

### Snapshot restore is reachable from the CLI but not the UI
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
A "Versions" control on each user-action card
(`components/actions/snapshot-restore-dialog.tsx`) lists snapshots and restores
one through the existing routes. The half that was not decoration: a refusal now
carries the RULES. `restoreSnapshot` writes through `saveUserAction`, which
re-validates, so a snapshot predating the source guard is refused — and that was
reaching the browser as a 500 "Failed to restore action snapshot", which tells a
user with an unrecoverable action nothing at all while the CLI has always printed
the violations. The route answers **422 with
`UnsafeActionSourceError.violations`** and the surface renders them, one per
line, with "nothing was changed" and what to do instead.

**Kept honest about coverage:** a component testing library exists now
(**narrowed, feature/todos-w11-bugfixes, 2026-08-22**) and
`snapshot-restore-dialog.test.tsx` renders the dialog and mutation-checks
exactly the claim this entry makes — a source-guard refusal rendering as the
rules it broke, one per line, computed via `describeSnapshotRestoreFailure`
rather than pasted, with "nothing was changed" and what to do instead. The
wording (`modules/api/snapshot-contract.ts`) and the request shaping
(`hooks/use-action-snapshots.ts`) live outside it and are tested too, and
`modules/api/snapshots.route.test.ts` drives both real handlers against a real
temp `$HOME` with a pre-guard snapshot on disk.
Found by: audit wave 2 (todos-w2-surfaces), 2026-08-07.

### The OAuth state/CSRF guard has never been run against Google
**Priority:** P4
**Narrowed:** feature/todos-w3-tests (2026-08-07)
The handler-level half is done — thirteen route-level cases, including the
403-before-`addAccount` ordering; see the Testing section for exactly what they
establish and how. What remains is the part no test on this machine can do: the
cookie round trip has never run against a live Google consent flow, because
there are no OAuth credentials and no linked account here. The consent screen,
Google's own `state` echo, the browser's cookie handling across the redirect and
`exchangeCode` itself are verified by reading only. Do not call this control
end-to-end verified until someone links a real account.

## CLI

### `actions snapshots` list/restore are only covered by their filename parser
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`commands/action-snapshots.e2e.test.ts` runs the BUILT binary against the CLI
harness's temp `$HOME`, with real action files and real snapshots on disk:
`list` (including the newest-first order and the no-snapshots message),
`restore` on `y`, the snapshot it writes of the version it replaced, an
unrecognised snapshot name — and the interesting case, restoring a pre-guard
snapshot and getting the `UnsafeActionSourceError` branch with its specific rule
violations rather than the generic one.

It also caught the regression that made this wave necessary: the confirmation
prompt was still `rl.question()`, so `restore X < /dev/null` hung commander's
action promise and exited 0 having restored nothing and said nothing.
Mutation-checked by restoring `rl.question()`: exactly the EOF case fails.
Found by: audit wave 2 (todos-w2-surfaces), 2026-08-07.

### Adopt the shared dotted-path config helpers
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`packages/cli/src/commands/config.ts` still declares its own `getNestedValue` and
`setNestedValue`. Replace both with `getNestedConfigValue`/`setNestedConfigValue`
from `@email-agent/core` (`config/dotted-path.ts`, added on
`feature/todos-w4b-config`, 2026-08-07), which refuse `__proto__`, `constructor`
and `prototype` in any path position and also fix a latent bug the CLI copy has:
`typeof null === "object"`, so a null intermediate is walked into rather than
replaced.

Done. Both local copies are gone; `UnsafeConfigPathError` is caught on `get` and
on `set` (reading walks the same chain) and printed as one line plus the
offending segment.

`commands/config.e2e.test.ts` drives the built binary. Its refusal case asserts
three things, and the third is the one that matters: the output must carry NO
stack trace. Without it the case passes even with the write left unguarded,
because the read-back after `saveSettings` throws the same error a moment later
— same exit code, same words, and the pollution has already happened. That was
found by mutation-checking, not by design: the first version of the test passed
against the unguarded setter.

## Core Gmail

### Concurrency for applying operations (batchModify is rejected)
**Priority:** P4 (deferred with preconditions, 2026-08-07)
`applyOperations` awaits one Gmail round trip per operation, so approving a large
batch serializes N network calls with the panel blocked. Both faster shapes were
examined on `feature/todos-w4b-config`; the reasoning is now at the function.

**`messages.batchModify` is REJECTED, not deferred. Do not re-propose it.**
Both grounds were read off the REST reference on 2026-08-07:
- "If successful, the response body is empty" — **no per-message result**, so N
  queue rows would collapse onto one all-or-nothing status. On a partial failure
  we would either retire rows as applied without evidence, or mark rows failed
  that were really mutated — precisely the ambiguity `toOperationOutcomes` fails
  closed on today. (`messages.modify`, used today, returns the modified
  `Message` per call.)
- One request is one `ids[]` list against one `addLabelIds`/`removeLabelIds`
  pair under one `userId`, so only operations sharing an identical (account,
  addLabelIds, removeLabelIds) tuple can share a call. A typical junk batch
  (trash + spam + archive interleaved) is three distinct tuples, so it fragments
  into single-operation calls anyway.

**Correction (2026-08-07):** an earlier revision of this entry listed a third
ground — that `batchModify` "cannot express `trash`" and that `batchDelete` was
the only batch route. That was false and had never been checked. Gmail's labels
guide lists `TRASH` as manually appliable (unlike `SENT`/`DRAFT`), and
`batchModify` documents no restriction on `addLabelIds` beyond the 1000-id cap,
so `addLabelIds: ["TRASH"]` is the batched equivalent of `messages.trash()` —
the same relationship `markAsSpam()` already relies on with `modify` +
`["SPAM"]`. `messages.batchDelete` is the analogue of `messages.delete`
(PERMANENT) and must never be substituted for trash, but it is not a reason to
reject `batchModify`. The rejection stands on the two verified grounds above.

**A bounded pool is deferred**, and what it needs is known:
1. **Partition by (account, message), serial inside a partition.** The queue can
   hold several pending operations for one message — dedupe only collapses
   identical ones — and serial execution applies them in the order the user
   reviewed. A flat pool would race `addLabels X` against `removeLabels X` and
   leave a nondeterministic final state.
2. **Retry/backoff must exist first.** There is none today: an error becomes a
   `failed` row, which is not `pending` and can never be approved again, so the
   user must re-run the action to re-propose the change. Concurrency raises the
   rate of transient rate-limit and 5xx responses, so without backoff it trades
   latency for a higher chance of permanently dropping a change the user
   explicitly approved. Wrong direction for the approval gate.
3. **A test seam and a measurement.** `applyOperations` imports the write
   operations directly, so a pool cannot be tested without injecting them; and no
   live Gmail timing has ever been taken here — the ~100-300ms per round trip
   quoted at `APPLY_RESOLUTION_CHUNK_SIZE` is an estimate.

**Interaction with the chunked apply, since it is the easiest part to get
wrong:** a pool must live strictly INSIDE one chunk. Chunk rows are claimed,
applied and resolved as a unit, and `applyOperations` returns an outcome per
operation instead of throwing, so parallelism within a chunk leaves that unit
intact — a mid-chunk failure still resolves the whole chunk and strands nothing
extra. A pool spanning chunks would put more than one chunk in flight and
reinstate the "claimed set larger than the in-flight set" problem that moving the
claim into the loop was introduced to fix.

Ordering is not negotiable either way: `outcomes` is paired positionally with the
claimed rows by `toOperationOutcomes`, so mispairing writes one message's result
onto another message's row. Pinned by a regression test in `approval.test.ts`.

### Ambiguous account identity for queued unscoped rows
**Priority:** P3 (documented residual, 2026-08-07 — the behaviour is unchanged;
this records what it is)
`accountEmail: ""` (the gcloud/ADC sentinel) is replayed at approval time and may
resolve to a different identity than when the message was read, if ADC was
re-pointed in between. Documented precisely at `recordToGmailOperation`
(`actions/approval.ts`), in the gmail and actions module cards, and here.

Where a `""` comes from: `scopeOperationsToAccounts` fills an operation's
`accountEmail` from the run's explicit account or from the per-message lookup
built out of the `emails` rows' own `accountId`, so a `""` on a queue row is
inherited from an email row that was itself stored under `""` — fetched through
the ADC path, or before the `accountId` column existed.

What it resolves to: `createGmailClient("")` means gcloud ADC and nothing else —
an explicit empty string never falls through to a configured default account
(`gmail/client.ts`), so adding named accounts later does not silently retarget an
old queue row.

**What a user would observe** if ADC has moved to a different Google account
between queueing and approval: Gmail message ids are per-mailbox, so the id is
looked up in a mailbox that does not have it, the API answers 404,
`applyOperations` catches it per operation, and the row resolves `failed` with
the Gmail error text. The approval surface shows the change as failed and no mail
is touched in either mailbox — but a `failed` row is TERMINAL (not `pending`), so
the approved change is dropped and only a re-run re-proposes it. If ADC has been
revoked or `gcloud` is gone, the token fetch throws and every unscoped row in the
batch fails the same way.

**Not claimed:** that mutating the wrong mailbox is impossible. Nothing checks
that the resolved identity matches the one that produced the row; the 404 is a
property of Gmail's id space, not a guard we implement. Named-account rows are
unaffected — `createGmailClient("me@example.com")` loads that account's stored
tokens and throws rather than falling back to ADC.

Two fixes were considered and not done: resolving the identity with
`users.getProfile` at enqueue time (a live API call added to a path that is
currently DB-only, and whose failure means the proposal is never recorded at
all), and re-resolving at apply time to compare (same cost, and it can only
report the mismatch after the row has already been claimed).

**The stranded-verification read-back (feature/todos-w11-bugfixes, 2026-08-21)
inherits this exact trap, one call earlier in a row's life.** A `""`-sentinel
row stranded in `applying` is now also checked via `createGmailClient("")` —
resolved at whatever moment `verifyStrandedApplyingOperations()` runs, not at
the moment the row was queued or claimed. Unlike the apply path above, the
read path is NOT symmetric: a wrong-mailbox 404 costs nothing (a
`message-missing` residual), but a wrong-mailbox message that happened to
carry the same id and already-matching labels would return a positive
verdict — so this pass may read and requeue a `""` row, but it is barred from
ever recording one `applied` on that evidence (see "Verify a stranded apply
against Gmail instead of asking the user", Completed). Named-account rows are
unaffected here too.

## Testing

### The integration harness exists; React rendering is what it does not cover
**Priority:** P3 for what remains
**Mostly completed:** feature/todos-w3-tests (2026-08-07)
The old claim — "31 of 32 coverage gaps are structurally untestable: no test DB,
no mocking layer, no React testing library, no HTTP harness" — was wrong about
three of those four, and this wave found out by building it.

**What exists now.** `packages/core/src/testing/lancedb-fixture.ts` is the one
temp-`$HOME` LanceDB fixture: `useTempHome()` redirects `$HOME`, re-reads
`LANCEDB_DIR` and THROWS if it is not inside the temp directory, so a test whose
core import is hoisted above the swap fails on its first line instead of
operating on the developer's real `~/.email-agent`. Seeding goes through the
product's own write paths (`savePendingOperations`, `upsertEmails`,
`saveActionResult`). `packages/web/src/modules/api/testing/route-harness.ts`
drives real Next route handlers against it, and
`packages/cli/src/testing/cli-harness.ts` runs the BUILT `email-agent` binary
against it (`npm test` now builds the CLI for that reason).

**"No HTTP harness" was never the obstacle.** A route handler is a plain
exported async function taking a `NextRequest`; the only blocker was that tsx
does not resolve the `@/*` and `@email-agent/core/*` tsconfig `paths` (there is
no `tsconfig.json` at the repo root), so importing a route died on
`Cannot find package '@/modules'`. A ~60-line `module.register()` resolve hook
mirroring those two alias entries opened the whole surface. No mocking layer was
needed either: the temp `$HOME` holds no Gmail tokens, so `createGmailClient`
throws locally with no network call and the queue rows resolve `failed`, which
is a real terminal path.

**Ported onto it, so there is one way to do this:** the queue-helper,
chained-`.where()`, query-limit, email-storage and cross-process-claim tests use
the core fixture; `db/stranded-adjudication.race.test.ts` was moved onto it,
deleting its hand-rolled `$HOME` swap and its four duplicated helpers and
gaining the ordering guard; the web route tests and the CLI e2e tests use the
two surface harnesses over the same fixture. Two files were left on their own
setup DELIBERATELY, noted here so nobody reads them as missed:
  - `db/schema-migration.test.ts` needs a bare `connect(dir)` rather than
    `initDb()`, because it constructs LEGACY table shapes and then migrates
    them — a thing the fixture cannot express by design.
  - both `email-lookup.test.ts` copies inject their own table through the
    module's `EmailLookupTable` seam and build it with `db.createTable` from
    arbitrary rows. Porting them onto the fixture would LOSE their point: the
    duplicate-`(accountId, id)` case cannot be produced through `upsertEmails`,
    which replaces that pair. They each gained a 15-row case for the query-limit
    fix instead.

**WHAT IS STILL NOT COVERED, and must not be described as covered:**
  - **React component rendering — NARROWED, feature/todos-w11-bugfixes
    (2026-08-22).** There is now a component testing library (vitest + React
    Testing Library, `packages/web/src/testing/`), and `SnapshotRestoreDialog`,
    `ApprovalPanel`, `StrandedOperationsPanel`, `UnlockScreen`, the settings page
    and `ActionChatCard` are all rendered and mutation-checked. What remains
    unrendered, and why: `UnlockExchange` — every branch that matters (its
    success path, its own network/coded-failure branches) hits the same
    `window.location.replace`/`.assign` wall jsdom refuses to let be redefined,
    so only its no-token fallback into `UnlockScreen` is exercised, indirectly;
    `Dialog`'s focus trap (jsdom has no layout, so `offsetParent` is always
    null); the top-level `isError` card on each approval panel (a static early
    return with nothing to branch on wrong); the once-per-mount verify
    ref-guard's remount case; and the per-card action Run/Delete pending state
    under concurrency. What was extracted out of the components
    (`groupOperationsByBatch`, `describeUnlockScreenCopy`, and others) is
    tested both as pure functions AND as the choice a rendered component makes
    between them.
  - **Next itself.** The harness drives handlers, not the framework: routing,
    middleware, streaming responses and server-component rendering are outside
    it.
  - **A successful Gmail mutation.** Every apply path in the new tests ends in a
    per-operation failure, because there is no linked account. The claim, the
    resolution, the reporting and the exit codes are covered; "the trash really
    reached Gmail" is not, and cannot be from here.
  - **A real Gmail `messages.get` READ, new as of the stranded-verification
    wave (feature/todos-w11-bugfixes, 2026-08-21).** The same "no linked
    account" limit applies to the read side, not just the write side above:
    neither the web route harness nor the CLI e2e harness has a linked Gmail
    account, so `createGmailClient` throws before any request reaches Gmail and
    every verify call in both lands on the `credentials` residual. The
    `applied`/`notApplied` VERDICT branches (a genuine label match or mismatch
    reaching `verdictFromLabels`) are unreachable from either surface's test
    harness and are covered only by core's own injected-reader tests
    (`verify-stranded.test.ts`, 19 cases). The 404's three-way meaning and
    Gmail's purge-from-Trash behaviour are documented, not observed.
  - **A REAL MODEL.** Narrowed on feature/todos-w10-cleanup (2026-08-07): `run-action` IS now
    driven end to end — prompt construction, the HTTP call, `parseActionOutput`,
    `mapResultToOperations`, the queue write, the approval prompt and the exit
    code — by pointing `OPENAI_BASE_URL` at a local `node:http` stub under
    `agentMode: "direct-api"`, which the OpenAI SDK honours. What that does NOT
    cover is a real model: the stub answers a fixed body, so nothing in the
    suite says an LLM would produce that shape, or that a real provider would
    accept the request. The plumbing is covered; the model is not.
  - **`fetch`.** `syncEmails` needs the Gmail API; only its storage half
    (`upsertEmails`) is now covered.

### Browser verification: 5 pages clean, two panels never seen populated
**Priority:** P3
**Partly completed:** feature/todos-w3-tests (2026-08-07)
A headless-browser pass was run. What it established: all 5 pages return 200
with **zero console errors**; `/actions` renders and runs its three built-in
actions, which also proves the parse-don't-execute change did not break built-in
loading in a real browser; the auto-apply consent card keeps its toggle locked
until the acknowledgement is given; the retention field shows 365 and flips
correctly to "0 disables deletion — every record is kept forever"; the settings
dirty-guard holds an unsaved edit across a focus refetch;
`/api/approvals/stranded` answers 200 same-origin, 403 for a rebound `Host`, 403
for a bare POST and 400 for a bad body; and there is no horizontal document
overflow at 375, 640, 800 or 1024 px.

**Still NOT covered, exactly — and two different claims kept distinct on
purpose: "rendered populated under jsdom by an automated test" is not the same
claim as "observed populated in a real browser," and feature/todos-w11-bugfixes
(2026-08-22) only did the first:**
  - **The approval panel and the stranded panel have still never been seen
    POPULATED IN A REAL BROWSER** — that gap is unchanged, there is still no
    Gmail account on any machine this has run on. What DID change: both are now
    rendered populated under jsdom by `approval-panel.test.tsx` and
    `stranded-operations-panel.test.tsx`, mutation-checked — every checkbox, the
    review dialog, the destructive-change confirmation (accepted and declined),
    the apply/reject toasts, all six `VerificationResidualReason` values, and
    the two stranded adjudication buttons are exercised there, just not by a
    human looking at Chromium.
  - **"No automated React test exists, so nothing prevents a regression" is
    CLOSED, feature/todos-w11-bugfixes (2026-08-22).** A component test suite
    now exists (`packages/web/src/testing/`, vitest + React Testing Library),
    runs under the same `npm test` as everything else, and can fail the build.
    It covers the components named above plus `SnapshotRestoreDialog`,
    `UnlockScreen`, the settings page and `ActionChatCard`. This bullet is the
    one this wave actually closes; the real-browser observation bullet above it
    is a genuinely separate claim and stays open.
  - **The "Versions" snapshot-restore control** (added
    feature/todos-w10-cleanup, 2026-08-07) is now rendered under jsdom
    (`snapshot-restore-dialog.test.tsx`) — a source-guard refusal renders as the
    specific rules it broke, one per line, computed rather than pinned — but has
    STILL never been seen in an actual browser.
  - **Streaming chat generation and its abort-on-close behaviour are now
    covered, feature/todos-w11-bugfixes (2026-08-22)**
    (`action-chat-card.test.tsx`): real SSE parsing over a genuine
    `ReadableStream`/`Response`, the `done` event as the source of truth for the
    final text, closing the chat mid-generation actually aborting the in-flight
    request's `AbortSignal`, a second message aborting the first's, and the read
    loop's `isCurrent()` guard against a superseded stream that keeps delivering
    chunks anyway. **The per-card action Run/Delete pending state under
    concurrency was NOT part of that work and remains uncovered** — it shares a
    sentence with the streaming item above in the original note, but nobody has
    covered it; keep it a separate bullet so it does not silently ride along on
    the streaming item's completion.

### Extract remaining inline pure logic for unit tests
**Priority:** CLOSED (2026-08-07)
**Completed:** feature/todos-w3-tests
`groupOperationsByBatch` (`modules/api/approvals-contract.ts`) is the
`ApprovalPanel` `useMemo`, and `classifyReviewAnswer` / `classifyStrandedAnswer`
/ `confirmedYes` (`cli/src/commands/approvals.ts`) are the review loops'
answer handling. Both have tests; the components/loops only call them. The
grouping's tests are about ORDER (a Map preserves insertion order; an object
literal reorders numeric-looking ids and a key sort discards the server's
ordering), and the classification's are about the DEFAULT (anything
unrecognised, including `"yes"`, keeps the change queued).

### The two instruction files were separate, and the drift caused defects
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`CLAUDE.md` and `AGENTS.md` were two files with heavily overlapping content,
hand-synced. They drifted, and it was not untidiness: every agent session loads
one of them, so a wrong line in the copy nobody fixed keeps teaching the wrong
thing. What had actually diverged, all of it in the direction of undoing a fix:

- AGENTS.md still recommended `mergeInsert` for keyed rows, which the other file
  documents as measurably broken on these tables. That is advice to reintroduce
  the bug that stopped `email-agent fetch` storing a single email.
- AGENTS.md still described `getEmails` as chaining `.where()`, which is the
  exact bug `no-chained-where.test.ts` exists to prevent.
- AGENTS.md's whole Agent Executors section had been through a Claude→Codex
  find/replace: `Codex-executor.ts`, "strip the `Codex` env var", "spawning
  `Codex` CLI from inside Codex". None of those exist; the file is
  `claude-executor.ts` and the variable is `CLAUDECODE`.

**Made one file rather than kept in step.** `AGENTS.md` is the real file
(matching what the bare-repo container already documents) and `CLAUDE.md` is a
symlink to it. The argument for the symlink over a divergence check: a check can
only report drift AFTER it has happened and after an agent has already read the
wrong copy, while a symlink makes drift impossible; and the repo already ships a
checked-in symlink (`packages/web/package-lock.json`), so it is not a new
mechanism. `scripts/check-module-boundaries.mjs` guards the ways a symlink stops
being one — a checkout on a filesystem without symlink support materialises it
as a text file, and an editor or script can replace it with a copy — and fails
with the one-line fix. Mutation-checked by replacing the link with a copy.

### The CLI prompt layer: EOF, Ctrl-C, and two interfaces over one stdin
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
Three defects, one new module (`packages/cli/src/prompt.ts`).

1. **Two sites still used `rl.question()`** after the rule against it was
   written down: `run-action`'s post-run `[a/r/S]` prompt and
   `actions snapshots restore`'s confirmation. Both hung commander's action
   promise at EOF and exited 0 having done nothing and said nothing.
2. **Porting them was not enough.** `printf 'r\ny\nn\n' | email-agent run-action junk`
   STILL lost both review answers: the `[a/r/S]` interface is in flowing mode,
   so it had already buffered `y` and `n` before it closed, and the interface
   `reviewOperations` opened next saw immediate EOF. A second, independent
   defect, found by the new e2e test rather than by reading. Fixed by threading
   ONE session through both prompts (`usingPrompt`).
3. **Ctrl-C committed partial decisions.** With no `SIGINT` listener, node's
   readline closes the interface on `^C`, which ends the iterator —
   byte-identical to EOF — so `^C` half-way through a review classified as
   `stop` and the y answers were applied to Gmail.

**The Ctrl-C decision, and why.** SIGINT aborts and commits nothing (exit 130);
EOF keeps what was decided. The two must differ because they mean different
things: piped input running out is the normal end of a scripted review, and
Ctrl-D means "end of input", while Ctrl-C is what a user reaches for the moment
they realise the wrong thing is about to be trashed. The asymmetry settles it —
aborting costs a re-run and loses nothing, since every row stays queued and
reviewable; committing on Ctrl-C costs a Gmail mutation no surface here can
undo. Scope stated rather than overclaimed: readline only emits `SIGINT` in
TERMINAL mode, so with piped stdin `^C` kills the process before any commit,
which is the same outcome by a different mechanism. There is no pty library in
this repo, so `prompt.test.ts` drives node's own `^C` decoding over a
`terminal: true` PassThrough pair — the mechanism is the real one; an actual
terminal is not observed.

### The test resolve hook was more permissive than the real resolver
**Priority:** CLOSED — feature/todos-w10-cleanup (2026-08-07)
`module-aliases.mjs` fell back to `<rest>.ts` for any `@email-agent/core/`
subpath with no `index.ts`, while `packages/web/tsconfig.json` maps the wildcard
to `*/index.ts` plus one explicit deep path (`gmail/operations`). A test-only
`import "@email-agent/core/db/utils"` therefore resolved under test and would be
refused by both tsc and webpack — tests passing against a module graph the
application can never build, which is the one thing a harness must not do. Its
comment claimed it "mirrors the tsconfig deliberately and nothing more", which
was false.

Tightened rather than re-documented: barrel-only wildcard, the one deep path
listed by name, and an unmappable specifier THROWS with the two ways to fix it.
`modules/api/module-aliases.test.ts` reads the tsconfig and fails if the two
disagree — set-for-set on the deep paths and target-for-target on each. No
existing import needed the fallback.

## Completed

### `listAccounts()` fails open, and can route writes to a different mailbox
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
`listAccounts()` (`gmail/account-manager.ts`) no longer wraps `loadSettings()`
in `try { … } catch { return [] }` — the try/catch is gone entirely, and so is
the `?? []` that followed it (`AppConfig.accounts` is a required array that
`normalizeSettings()` always produces, so it was unreachable). The function now
just calls `loadSettings()` and returns `settings.accounts`.

**The originally proposed fix is SUPERSEDED, not done as written.** The entry
said "catch ENOENT only, and let every other error propagate." What shipped
instead is no catch at all, and that is deliberate, not an oversight:
`loadSettings()` already owns the whole "what does an unusable settings file
mean?" policy (ENOENT → defaults; every other errno, and a file that exists but
does not parse → throw), and a narrowed catch here would have been a second
copy of that policy. It could not have worked anyway — the non-ENOENT failures
`loadSettings()` throws are plain `Error`s with the errno interpolated into the
*message*, not a `.code` a catch could branch on.

**The harm chain is corrected too.** The original entry's last paragraph said
the observable symptom is a wrong-account write 404ing and the queue row
resolving `failed`. That is only the sub-case where ADC was re-pointed *between*
the fetch and the apply. The actual chain is fetch-time poisoning, and the worse
case succeeds silently: an unreadable/corrupt `settings.json` during a fetch →
`resolveAccountEmail(undefined)` resolves to `""` → `syncEmails` uses that both
as the fetch identity and as the stored `accountId`, so the whole sync runs
against gcloud ADC and every row lands under the legacy `""` sentinel → a later
action run queues `pending_operations` rows with `accountId: ""` → at approval,
`createGmailClient("")` resolves ADC again and the write **succeeds** against
the ADC mailbox, because the message ids came from it, and is recorded as
`applied`. `email-agent cron setup` is where this bit hardest: an unattended
crontab fetch used to silently sync the wrong mailbox; it now exits 1 with the
repair instruction instead.

Both callers already handled the throw and needed no change: CLI `accounts
list` prints the error text and exits 1, `GET /api/accounts` answers 500 and
logs.

**Tests:** `packages/core/src/gmail/account-manager.settings-failure.test.ts`
(a new file — `account-manager.test.ts` statically imports the module, fixing
`SETTINGS_PATH` against the real `$HOME` before `useTempHome()` could redirect
it): returns `[]` on genuine ENOENT; throws rather than returning `[]` on
invalid JSON; propagates through `getDefaultAccount()`; throws on an unreadable
file (`chmod 000`). Mutation-checked: restoring the original
`try { … } catch { return [] }` fails 3 of 4 cases (the ENOENT case passes in
both states by design — it is the guard against over-correcting into "throw on
a fresh install").

**Does NOT cover:** there is still no direct Gmail write path through the old
swallow — every write already carries an explicit `accountId` — so this closes
the poisoning-at-fetch-time vector, not a write-time one.
Found by: product explainer pass, 2026-08-20, by checking prose against source.

### Unlock the local UI with a one-time token, then a session cookie
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-22)

**Decision taken 2026-08-20 by the repo owner: build the token flow.** All five
numbered points shipped, plus two items the owner added beyond them (D1:
`email-agent unlock`, a mint-only command for a server already running or a
`npm run dev`/`npm run start` session that never mints anything on its own;
D2: an automated real-browser test, not just a manual pass).

**What shipped, in one paragraph.** `email-agent serve` mints a one-time token
and prints `http://<bound host>:<port>/unlock?exchange=1#token=…` before
spawning the Next child (the token moved out of the query string and into the
URL FRAGMENT on 2026-08-22: `next dev`'s request logger prints the complete
`request.url`, so the query-string shape echoed every live token back into the
terminal — see the unlock-link bullet in AGENTS.md) (D4: the child inherits stdio, so the parent cannot watch it for a
readiness line without switching to pipes — the printed block says the link
works once the server reports ready instead). `POST /api/auth/unlock`
(`packages/web/src/app/api/auth/unlock/route.ts`) exchanges it for an
`httpOnly`, `SameSite=Lax`, `secure: false` session cookie, rate-limited and
compared via a hash-then-`timingSafeEqual`, burning the token synchronously in
the same tick it is read (no `await` between read and burn — pinned by a
test) AND across processes: every read-modify-write over the store runs
inside an `O_EXCL` lock (`config/session-lock.ts`, added 2026-08-22 after the
pre-lock code was measured to let two processes both redeem the same link,
twenty of twenty rounds — see the codex paragraph below). A browser with no
valid cookie meets the unlock page at `/unlock`, not
a bare 403 (`(app)/layout.tsx`'s redirect, UX; the API guards in
`modules/api/validation.ts` are the actual enforcement, folded into BOTH
`mutationGuardResponse` and `readGuardResponse` — reads are gated too, since
an unauthenticated local browser could otherwise already read every message).
`EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` bypasses the whole gate in the same
place it already bypasses the header checks (D6). Storage is a file, not
environment variables or a stateless signed cookie — `~/.email-agent/session
.json`, `0600`, only sha256 digests ever persisted — because `email-agent
unlock` has to mint a link an ALREADY-RUNNING server will accept, and no
process can inject an env var into a running child; the full argument,
including the tradeoffs stated rather than hidden, is in AGENTS.md's config
bullet and `packages/core/src/config/session.ts`'s module header.

**Two real gaps in the paragraph above, found by codex (gpt-5.x, high effort)
adversarially reviewing this closed feature, 2026-08-22, and both fixed the
same day:**
1. *Cookie port confusion.* RFC 6265 §8.5: cookies are not scoped by TCP
   port, so `127.0.0.1:3847` and any other loopback port a different local
   user or a container binds share ONE cookie jar. A cross-site top-level GET
   carries this `Lax` cookie to that sibling server, which can then replay it
   to 3847 as a valid bearer credential — `httpOnly` does not help, since the
   thief is the receiving HTTP server, not page script. Closed by an
   origin-scoped second factor: the exchange also mints a `bindingToken`,
   returned ONLY in the response body (never a cookie, which would hand it to
   the attacker), kept in the browser's `localStorage` (scoped by ORIGIN,
   which DOES include the port), and echoed in `SESSION_BINDING_HEADER` on
   every API call; `checkSessionRequest` requires both. A captured cookie
   alone now gets an attacker nothing; the two together get everything a
   normal unlocked browser has. The PAGE gate stays cookie-only — a top-level
   navigation carries no custom header — which is safe only because every
   page under it does zero server-side data fetching.
2. *The burn was not atomic across processes* — see the sentence added above.

Also in scope for that review and already reflected above: the token used to
travel in the query string, so `email-agent serve`'s `next dev` child printed
it a second time into the terminal on every unlock (fixed by moving it into
the URL fragment); and `session.ts`'s `UnlockMint.token` doc comment claimed
the plaintext went to "memory and stdout, and nowhere else", which was false
for the whole period the query string carried it — the comment now
enumerates every place it actually goes. Codex also reviewed and confirmed
clean: no route/page bypass, no production/test-session bypass, and correct
guard composition (`X-Forwarded-Host` ignored).

**The honest claim, exactly as specified, checked against where the secret
actually ended up, and now checked against BOTH gaps above:** this does NOT
stop code running as you on this machine — such code reads
`~/.email-agent/accounts/{email}/token.json` and calls Gmail directly, and it
can also read `session.json` or `/proc/<pid>/environ` directly, never
touching this app. What it buys is narrower and real, and only fully true
since the second-factor fix above: before that fix, a process holding only a
cookie captured from a sibling loopback port — no home-directory read
required — could still ride an unlocked session, so the sentence below was an
overclaim for however long it stood unqualified. With the second factor, it
raises the bar from "anything that can reach the port" to "anything that can
read your home directory" — and that claim holds because only DIGESTS are
ever persisted, so reading the store alone yields no usable credential. It is
stated in `session.ts`'s module header, in README.md's "Unlocking the local
UI" section, and on the unlock page itself. Not described as a boundary
against local malware anywhere; the loopback bind remains the actual boundary
and this sits behind it.

**D2, the differentiator, genuinely ran here:**
`packages/cli/src/commands/serve.browser.e2e.test.ts` adds `puppeteer-core`
(never `puppeteer`, which downloads its own browser) as a CLI devDependency
and drives the SYSTEM Chromium against a REALLY-spawned `email-agent serve` —
a separate child process, on an OS-assigned free port, over a throwaway
`$HOME`. It proves what no in-process test can: the token the CLI parent
prints is the one the Next child process actually accepts; Chromium stores
and returns the cookie with the exact documented attributes; a cookie-less
browser lands on the unlock screen rather than a raw failure; and a fresh
context replaying the already-burned link is refused. It self-skips with a
named reason (`t.skip(...)`, suite still exits 0) when no Chromium is found,
checked at `PUPPETEER_EXECUTABLE_PATH` and the common system install paths —
it must never fail on a machine with none installed and never silently pass
without having run. Adds roughly 15-25s to the suite on this machine, almost
entirely `next dev`'s on-demand route compilation rather than Chromium
itself. Mutation-checked against three independent breaks (the page-level
redirect, the exchange always failing, the burn check disabled) — the first
was caught by defense in depth (`apiFetch`'s own 401 redirect) rather than by
the layout gate specifically, which is itself informative: the two mechanisms
overlap exactly the way "the gate is UX, not enforcement" says they should.

**Scope, preserved verbatim in spirit.** This is the right shape for one
person, one laptop, `serve` run from the machine that reads the output. The
weakest point is a second device — a printed URL cannot easily reach a phone
— and that is accepted because it is not the supported mode. **If this is
ever deployed so several people use it, this design must be REWRITTEN, not
extended:** multi-user needs real accounts, per-user authorization and
per-user Gmail grants, and "Ambiguous account identity for queued unscoped
rows" (the `""` ADC sentinel) must be revisited at the same time, because a
shared deployment makes that sentinel indefensible. Stated in `session.ts`'s
header, in AGENTS.md, and in the unlock page's own copy.

**Does NOT cover:** a second browser engine (Tier 2 drives exactly one — the
`SameSite=Lax` argument for the OAuth callback's cross-site redirect is
reasoned from spec, not observed in Safari/Firefox); the real 24-hour session
TTL (proven only against an injected clock — nothing here sits for a day);
`/proc/<pid>/environ` visibility claims (asserted from kernel behavior, not
tested — no second Unix user exists in this environment); React component
rendering in isolation — **narrowed, feature/todos-w11-bugfixes (2026-08-22):**
`UnlockScreen` is now rendered and mutation-checked
(`unlock-screen.test.tsx`), including `reason === "binding"` proven
distinguishable from a plain lockout and not a dead end. `UnlockExchange` is
still NOT rendered — every branch that matters (its success path, its own
network/coded-failure branches) hits the `window.location.replace`/`.assign`
wall jsdom refuses to let be redefined — so the one browser test above is
still the only thing that exercises a REAL end-to-end flow (an actual server
process, an actual browser, a real cookie); and, unchanged by any of this, a
successful Gmail mutation (no linked account anywhere in the suite).
Found by: repo owner, 2026-08-20 (decision to build). The cookie-port-confusion
gap and the cross-process burn race were found by codex (gpt-5.x, high effort)
adversarial review of this closed feature, 2026-08-22, and fixed the same
day — see the paragraph above; that review also confirmed no route/page
bypass, no production/test-session bypass, and correct guard composition.

### Record which surface approved an operation
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
`pending_operations` gains an `approvedVia` column (`"web"` | `"cli"` |
`"auto-apply"` | `""`), written wherever a row leaves `pending`. **Attribution
only, exactly as scoped when this was opened**: it gates nothing and proves
nothing, because there is no unforgeable in-process caller identity to derive
it from (ESM module identity is process-global) — the value is a literal each
caller binds statically about itself.

`claimPendingOperations()` takes it as a REQUIRED parameter with no default:
`""` is reserved for unclaimed-or-legacy, so a claim that omitted a surface
would be indistinguishable from a pre-column row in the audit trail. It is a
`values`-only field and never enters a `where` predicate, so the claim's atomic
write predicate is unchanged. The migration sentinel is `CAST('' AS STRING)` —
a legacy row already `applying` or `applied` genuinely has no recorded surface,
and filling in a plausible `"web"` would fabricate an audit record nobody
observed. `adjudicateStrandedOperations` clears it back to `""` only on a
`notApplied` answer (the row is genuinely unclaimed again); the `applied`
branch deliberately leaves it, so a stranded row keeps recording which surface
initiated the crashed apply — the one case where the field stays informative.

**Forced cross-package edits**, the required parameter breaking assignability:
web's apply/reject routes pass `"web"`; the CLI binds `"cli"` in the
`deps.apply`/`deps.reject` fallbacks rather than widening `ApplyDeps`/
`RejectDeps` (a 2-arg function cannot satisfy a 1-arg type, and every injected
test double would have had to change); `rejectPendingOperationsByIds`'
`resolvedAt` argument moved one position right when `approvedVia` was inserted
before it, pinned by a test that reads it back off the table rather than off
the returned rows.

**Tests:** a real-table claim-path case; a case covering the `"cli"` and
`"auto-apply"` literals through the product's own apply/reject entry points; a
migration case over the realistic intermediate shape (claim columns present,
only this one missing, rows already claimed) proving they come back
unattributed with their claim state untouched; stranded-adjudication
assertions for both the `notApplied`-clears and `applied`-keeps directions
(`936f9a2`). Mutation-checked: dropping `approvedVia` from the claim's
`values` object fails the claim-path cases; changing the sentinel to
`CAST('web' AS STRING)` fails both migration cases; removing the `notApplied`
clear, or adding the same clear to the `applied` branch, each fail their
respective case.

**Does NOT cover:** displaying the value anywhere in the CLI or web UI — left
to whoever owns those surfaces next.
Landed in `02427f7`, `936f9a2`.

### The regex action-id reader is still alive in web, and skips the collision check
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
`packages/web/src/app/api/actions/user/route.ts`'s built-in-conflict check now
calls `extractActionData()` (already exported from the `@email-agent/core/actions`
barrel) instead of the deleted `packages/web/src/lib/action-id.ts` regex. A
const-bound id (`const ID = "junk"; export default { id: ID, ... }`) resolves
correctly through the AST evaluator, exactly as it does at load time — the
regex only matched a literal on the `id:` line, so such a file used to save to
disk shadowing a built-in action without tripping the conflict check.
`UnsafeActionSourceError` is allowed to propagate to the existing 422 handler
rather than being caught separately, so a file that is both unsafe *and*
colliding is reported for the guard violation first — the more fundamental
problem, and the one the chat UI needs `.violations` to fix.

`use-action-chat.ts`'s `deriveFilename()` keeps a private `bestEffortIdGuess()`
regex helper, explicitly commented as cosmetic-only: it seeds an editable
filename `<Input>` the user can retype before Save, never an identity or
security decision, and must not be re-exported as `extractActionId` or rewired
into a decision again.

**Tests:** `packages/web/src/modules/api/user-actions.route.test.ts` — first
coverage of `POST /api/actions/user` at all. Five cases: const-bound shadowing
id (the bug — pre-fix it returned 200 and actually wrote the shadowing file to
disk), literal-id shadowing (baseline), non-conflicting const-bound id (happy
path), guard-violation+collision overlap (precedence pin: 422, not 409 — the
old regex saw the literal `"junk"` and won the race before the safety guard
ever ran), and the mutation guard. Mutation-checked: restoring the regex path
inline fails exactly the two pre-fix cases (const-bound shadow, precedence
pin), confirming the tests are pinned to the fix rather than incidentally
green.

**Does NOT cover:** a second mutation — wrapping `extractActionData()` in a
try/catch that swallows `UnsafeActionSourceError` — did not kill any test,
because `saveUserAction()` independently re-validates via its own
`assertSafeActionSource()` call (a deliberate, accepted double-parse); this is
a property of that design, not a coverage gap.
Landed in `f82d678`.
Found by: product explainer pass, 2026-08-20.

### The web settings form stores a Google client secret that nothing ever reads
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
Resolved by removal, the smaller of the two options the entry named.
`OAuthConfig` and `AppConfig.oauth` are deleted from `packages/core/src/config/
types.ts`; `normalizeSettings` no longer round-trips an `oauth` block.
`PUT /api/settings` now refuses the key outright — `Unknown setting: oauth`
(400) — instead of accepting and persisting a plaintext client secret nothing
ever read (`getOAuthCredentials()` reads only `~/.email-agent/oauth.json`).
`GET /api/accounts`'s 400 and the Settings page both now point at `setup.sh` /
`~/.email-agent/oauth.json` instead of a vague "run setup first."

**A settings file already carrying the field from a pre-removal build is not
silently left unexplained.** `hasLegacyOauthKey`/`legacyOauthNotice`
(mirroring the existing `gmail.syncActions` pattern) warn once per `(path,
kind)` on the load that drops it — the notice cache was widened from a
bare-path key to a composite one specifically because two legacy keys
(`syncActions`, `oauth`) can be present in the same file on the same cache
miss, and a bare-path key would let whichever check runs first suppress the
other's notice.

**Tests:** core: a settings.json carrying a well-formed `oauth` block is
dropped (the old test only covered a malformed one); the paired-notice
behaviour (both present → 2 notices, neither suppressing the other). Web: unit
coverage for the 400; a new `settings.route.test.ts` seeds a settings.json with
a pre-removal `oauth` block on disk, PUTs an unrelated update, and reads the
file back to prove the plaintext secret is gone — empirical, not just
inspection. Mutation-checked (3): reverting the notice key to bare-path fails
the paired-notice test; re-adding `"oauth"` to the accepted key set fails both
the unit and route-level rejection tests; reintroducing the round-trip write
fails the drop test, the syncActions-notice ordering test, and the on-disk
purge test.

**Does NOT cover:** an on-disk `oauth` block written by a pre-removal build
survives in plaintext until the *next* save — there is no read-path
self-repair, matching the `gmail.syncActions` precedent. The Settings-page
one-liner and the reworded `accounts` route message are type-checked only; no
component-rendering test exists in this repo, and no test pins the accounts
message text. `email-agent config set oauth.clientSecret <value>` now silently
degrades to the same generic "unknown key, dropped on save" no-op every other
removed key already gets.
Landed in `cc6cd40`.
Found by: product explainer pass, 2026-08-20.

### `validationResponse` does not recognise a malformed JSON body
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
`parseJsonBody(request)` (`modules/api/validation.ts`) is now the ONE place any
route parses a request body — every one of the 12 route files that previously
called `await request.json()` inline (14 call sites) calls `parseJsonBody`
instead. It catches only `SyntaxError` and rethrows it as
`RequestValidationError("Request body must be valid JSON")`, which
`validationResponse` already maps to 400. Deliberately narrow: catching every
`SyntaxError` a route's try block might raise would misclassify one thrown
elsewhere in that block as "the client sent a bad body" — this scopes the
reclassification to the one call site that can genuinely produce it for that
reason. Anything else `.json()` throws (a body already consumed, a stream
error) is a real 500 and is rethrown unchanged.

The pinned assertion in `approvals.route.test.ts` — the "MALFORMED JSON IS A
500 TODAY" comment and `assert.equal(malformed.status, 500)` — was flipped to
400 in the same commit, exactly as this entry required.

**Tests:** the route-test flip above; a new unit test in `validation.test.ts`
covering `parseJsonBody` directly (malformed → `RequestValidationError`;
well-formed → transparent pass-through; an already-consumed body's `TypeError`
rethrown as itself, not misclassified). Mutation-checked (2): making
`parseJsonBody` a bare passthrough kills both the new unit test and the pinned
route test; reverting one route (`approvals/stranded`) back to raw
`request.json()` kills only the pinned route test while the unit test still
passes — proof the route-level wiring is independently covered, not just the
shared helper.
Landed in `57f5d03`.
Found by: writing the route tests, 2026-08-07.

### Verify a stranded apply against Gmail instead of asking the user
**Priority:** CLOSED — feature/todos-w11-bugfixes (2026-08-21)
The app now checks a stranded row against Gmail itself before a human ever
sees it, per the owner's decision of 2026-08-20.
`verifyStrandedApplyingOperations()` (`packages/core/src/actions/verify-
stranded.ts`) reads `getStaleApplyingOperations()` first as a cheap DB-only
gate — zero stale rows means zero Gmail calls and zero output — then reads
each stale row's current labels back (`gmail/read.ts`'s barrel-private
`readMessageLabels`, `users.messages.get` with `format: "minimal"`) and
compares them to the operation's intended end state via `verdictFromLabels`:
`spam` needs SPAM present AND INBOX absent (`markAsSpam` is one atomic
`modify` carrying both, so that pair IS the end state — the predicate table
originally drafted in this entry said "SPAM present" alone and was wrong);
`trash` needs TRASH present alone (Gmail drops INBOX implicitly; requiring it
would manufacture false negatives). It resolves what it can WITHOUT the user
and hands the rest to a person with WHICH of five specific reasons it hit —
`message-missing`, `credentials`, `check-failed`, `unverifiable-operation`, or
`unscoped-account` — never a blanket "could not check."

Runs automatically, gated on the same cheap read, at `email-agent fetch` and
at `email-agent serve` startup (owner's decision D1; `serve` previously had no
`@email-agent/core` dependency at all, so this is a genuinely new cost for
that command). The same check also fires on demand at `POST
/api/approvals/stranded/verify` (mutation-guarded) and inline at the top of
`email-agent approvals stranded [--review]`. A new `resolutionEvidence` column
(`"user-confirmed"` | `"verified-api"` | `""`) records which of those two
sources closed a row out, answering item 4's ask that the two claims not be
merged. The surfaces — `StrandedOperationsPanel`, `approvals stranded`, and
the `fetch`/`serve` notify line — all shipped in this same wave, on this same
branch; this was not left as a follow-up.

**What this does NOT do — four limits, written down rather than smoothed
over:**

LIMIT 1 (causation, not correctness): The check reads the message's state NOW
and compares it to the intended end state; it does not and cannot prove THIS
APP'S CALL caused that state. A message you archived yourself, from your
phone, five minutes before the check ran, will be credited to Email Agent —
the end state is right and the attribution is wrong. A verified-applied row is
proof only that the mailbox is now in the state the app wanted, never proof
that the app's own call produced it.

LIMIT 2 (the mirror, and the dangerous direction): the check is equally blind
to a REVERSAL. An apply that really landed and was then undone by the user —
un-archived, re-marked unread, restored from Trash — verifies `notApplied` and
is RE-PROPOSED as an ordinary pending row needing an explicit approval again.
Nothing mutates unasked, but this is the direction that can produce a SECOND
mutation, and approving it a second time would undo the user's own later
action. The operation set is idempotent (no send, no permanent delete, no
counter), so the honest sentence is: idempotent, therefore it cannot destroy
anything; it can still undo something the user did in between.

LIMIT 3 (the ADC sentinel replays at check time too): a row queued under the
`""` gcloud-ADC sentinel is verified through `createGmailClient("")`, which
resolves to whatever account is ambient AT THE MOMENT THE CHECK RUNS — a third
moment ADC can have moved, after queue time and approval time. The asymmetry
is free: a wrong-mailbox `notApplied` costs nothing (an ordinary requeue that
needs approval again), but a wrong-mailbox `applied` would retire the row
silently on evidence from a different account — so such a row may be READ and
REQUEUED, but this pass never records it `applied`. Only a person can close it
out. Named-account rows are unaffected.

LIMIT 4 (the read-before-write window — NARROWED on 2026-08-21, never closed):
the pass reads Gmail and then writes, so a hung apply landing in between
falsifies the evidence. Only ONE direction of that was ever a defect. Labels
the check SAW present were present, so an `applied` verdict a late apply also
lands is still the right end-state record; a `notApplied` is not — it requeues
a change that has now happened, on an audit trail saying it never did, and a
later explicit approval can send it to Gmail a second time. As shipped the
exposure was seconds to minutes wide, not milliseconds: the reads are
deliberately serial (429 risk) and both adjudications are batched at the end,
so row 1's evidence was already minutes old when its claim landed.

Every requeue candidate — and ONLY those, because re-reading the applied set
buys nothing and spends quota — is now RE-READ immediately before adjudication,
collapsing the exposure to one read and one write. A candidate that FLIPS to
`applied` on the re-read is a SECOND route to an `applied` write and goes
through the SAME `recordApplied` as the first pass, so LIMIT 3's `""` refusal
covers both routes (mutation-checked: deleting that one guard fails all four
ADC tests, unit and real-table). A re-read that FAILS never falls back to the
first read — no verdict on evidence that could not be refreshed, so the row
stays `applying` for a human.

**What REMAINS, and it is irreducible:** Gmail can still land between the
re-read and the write. An external system and a local database cannot be read
and written atomically. The word is NARROWED; do not let a later edit write
"closed". Nor can it be closed by claiming the row before reading: a crash
between claim and release would re-stamp `claimedAt`, reset the 15-minute
staleness clock and hide the row for another threshold, which is strictly
worse. The DB layer was not touched for this — the atomic claim predicate, the
cutoff folded into it and the stale-handle wrappers are exactly as they were,
because the verifier must still beat a hung apply's token at the claim or it
cannot function at all. Only the FRESHNESS of the evidence changed.

**What this replaces, and what it does not close.** The residual documented in
"The adjudication count can undercount" — an apply that claims a row, calls Gmail, hangs past
`STALE_APPLYING_THRESHOLD_MS` (15 min) and then succeeds, with its outcome
discarded by an adjudication answering "it didn't happen" — DOES NOT CLOSE.
Verification narrows WHICH rows reach that window (only the ones neither the
API check nor a person has yet resolved); it does not close the window
itself, and a regression test pins exactly that the window still exists. What
improved is the quality of the answer that beats it when the window is open —
the app checks Gmail before asking, rather than only ever asking.

**D3, checked against the code rather than assumed.** A row this pass
requeues to `pending` is an ordinary pending row with no special-case guard
against `gmail.autoApplyActions`. In practice it is never reached by that same
run's auto-apply, because `enqueueOperationsDetailed()` makes a best-effort
skip of proposals identical to a row already `pending`, and the requeued row
is exactly that — so a re-proposal is deduped away before it can be applied.
This is a property of the pre-existing dedupe, not new engineering built to
prevent it, and the dedupe's own pre-existing caveat still applies unchanged:
it is check-then-insert, so two CONCURRENT runs can each insert a fresh
duplicate before either sees the other's row, and with `gmail.autoApplyActions`
on, one of those new rows can be auto-applied — the requeued row itself still
needs an explicit approval regardless.

**Not claimed.** No linked Gmail account exists on this machine, so the
`applied`/`notApplied` verdict branches are exercised only through core's
injected reader (`verify-stranded.test.ts`, 19 cases); neither the web route
harness nor the CLI e2e harness can reach `verdictFromLabels` at all, because
both lack credentials and every verify call there lands on the `credentials`
residual first. A real `users.messages.get` response, the 404's three-way
meaning, and Gmail's purge-from-Trash behaviour are documented, not observed.
React component rendering (`StrandedOperationsPanel` firing the check once per
mount, the toast, the per-row reason) remained untested at the time this wave
shipped — no component testing library existed in this repo yet. **Narrowed,
feature/todos-w11-bugfixes (2026-08-22):** a component testing library now
exists, and `StrandedOperationsPanel` is rendered and mutation-checked by
`stranded-operations-panel.test.tsx`, including the once-per-mount verify fire,
the two toast paths (automatic-verification vs on-your-word), and all six
`VerificationResidualReason` values rendered distinguishably. What still is not
covered: the once-per-mount ref-guard's REMOUNT case specifically, and a real
Gmail read (unchanged — still no linked account on this machine).

Found by: owner's decision of 2026-08-20 (build the check). LIMIT 4's
read-before-write window was found and narrowed after a codex (gpt-5.x, medium
effort) cross-vendor review of this wave, 2026-08-21, which also confirmed the
six other safety claims (the ADC guard, the empty-label fail-closed, a 404
never becoming a verdict, the spam/trash predicates, the cutoff inside the
atomic predicate, and the stale-handle wrappers).

### The chained-`.where()` fix has no regression test
**Completed:** feature/todos-w3-tests (2026-08-07)
Was P2. `db/chained-where.test.ts` runs the product's own read functions
(`getEmails`, `countEmails`, `getPendingOperations`, `getActionResults`) against
a real temp-directory table seeded so the trailing filter alone matches strictly
more rows than the intersection — which is what makes a chain observable. All
three fixed call sites were mutation-checked by reintroducing a chain.

`db/no-chained-where.test.ts` is a structural tripwire, and its header states
its limits before anything else. It is a TypeScript AST pass (not a text scan)
reporting three shapes: direct chaining, `q = q.where(f)` inside a loop — the
natural rewrite of the fix, and the shape the mutation check used — and repeated
self-reassignment in one function. It has tests for each shape it claims to
catch, and two EXECUTABLE records of chains it cannot see (dataflow through a
helper; a receiver held on an object), so a green run is never read as "no chain
exists". A fourth case sweeps all three packages for files that open a LanceDB
query and fails unless the set outside `db/` matches a written allowlist, so a
new query surface cannot appear unguarded. The behavioural test is what
actually guards the semantics; this only makes the common regression fail where
it is typed.

### Cross-process claim atomicity is unconfirmed
**Completed:** feature/todos-w3-tests (2026-08-07)
Was P2, and it is now confirmed rather than assumed.
`db/cross-process-claim.race.test.ts` forks two real `node` processes over one
LanceDB directory and races them for the same three rows, six rounds, through a
two-phase barrier (both open a fresh handle, only then is either told to write).

**The result, and it is checked, not described:** exactly one owner every round,
all three rows to that owner, zero rows claimed twice — read off the table, not
off the workers' reports. The loser of a RAW `table.update()` is refused with
`Commit conflict for version N`, matched on the text `isCommitConflict()`
actually keys off. The winner alternates across rounds (`ABBBAA` / `BAABAA` on
the first run), so it is a resolved race and not one process always arriving
first; that is REPORTED and not asserted, because over six sample runs one
produced `AAAAAA` and asserting alternation would be a flake.

Determinism does not come from timing: a LanceDB handle is pinned to the version
it was opened at, so whichever process commits second is committing against a
version that has moved, whatever the interleaving.

**THE CONSEQUENCE, which callers must handle: the loser gets an ERROR, not a
silent no-op.** `claimPendingOperations` converts it into the zero-rows-won the
claim protocol assumes, via `updateAtLatestVersion`'s refresh + bounded retry —
asserted across the same two processes. Audited: every `table.update()` in
`db/pending-operations.ts` is inside that wrapper (an AST case fails if one is
added outside), and the modules that still take the raw error — `db/emails.ts`
and `db/clusters.ts` — are named in the test with what a conflict means there
(a cached mailbox flag or an explicit clustering pass, both single-write paths
where an error surfaces to a caller that can repeat the action, not a queue
write that is supposed to lose quietly). That residual is tracked under "The
adjudication count can undercount, and other queue helpers still hold stale
handles".

### Queue helpers with real-table behaviour are unit-tested only
**Completed:** feature/todos-w3-tests (2026-08-07)
Was P2. `db/queue-helpers.realtable.test.ts` runs prune, the dedupe lookup, the
enqueue dedupe and the chunked claim/resolve against a real temp-directory
table: `table.delete(buildPruneFilter(...))` removes exactly the rows the filter
selects and none of the adjacent ones (the `failed` exclusion and the
`resolvedAt != ''` guard both have their own row), `getPendingOperationsForEmails`
returns pending rows only, an enqueue drops a proposal identical to one already
pending while keeping a different change to the same mail, and a re-proposal
after a rejection is NOT suppressed. The chunk test reads the TABLE from inside
the injected Gmail call, so the per-call bound is checked against what is stored:
at each round trip exactly this chunk's rows are `applying`, earlier ids are
resolved and later ids are still `pending`. Ordering (newest-first with a total
order inside one millisecond) is covered off the real table too.

### The OAuth state/CSRF guard has no test and no live run
**Partly completed:** feature/todos-w3-tests (2026-08-07)
**Priority:** P4 for what remains — see the last paragraph.
Thirteen cases in `web/src/modules/api/oauth-csrf.route.test.ts` drive both real
route handlers against a real temp `$HOME`: matching state, mismatched state,
absent cookie, absent query parameter, two empty strings (which a naive compare
would match), a state that is a PREFIX of the cookie (`timingSafeEqual` throws
on unequal lengths, so a missing length check would 500 rather than 403), cookie
clearing on refusal, the cookie's httpOnly / SameSite=Lax /
`path=/api/auth/callback` / not-`Secure` attributes, a fresh unguessable value
per issue, the auth URL's `state` matching the cookie, a full issue-then-callback
round trip, and the fact that the route which ISSUES the state is still behind
the shared guard even though the callback is exempt from it.

**How the 403-before-`addAccount` ordering is established without a mocking
layer**, because the obvious approach needs one: the callback's four steps each
have a distinct observable in a temp home — 403 state, 400 missing code, 500
credentials not configured, then exchange + `addAccount` — so the status says
how far execution got. It is corroborated by the real side effect: `addAccount`
writes `settings.json` through `saveSettings`, and after every rejected callback
that file is asserted still absent.

**NOT DONE, and this entry stays open for it: no live Google consent flow was
walked.** There are no OAuth credentials and no linked account on this machine,
so the consent screen, Google's own `state` echo, the browser's cookie handling
across the redirect, and `exchangeCode` itself remain verified by reading only.
Do not describe this control as end-to-end verified until someone links a real
account.

### THE SURFACES WAVE item 3 — a test that goes through a surface
**Completed:** feature/todos-w3-tests (2026-08-07)
Was P2. Both surfaces are now driven end to end.

**CLI:** `commands/approvals.e2e.test.ts` and `commands/approvals-stranded.e2e.test.ts`
run the BUILT `packages/cli/dist/index.js` as a child process against a seeded
temp database — `npm test` builds the CLI for exactly this reason, because
running `src/index.ts` under tsx would not cover the tsc emit and the emit is
what a user runs. Covered: `approvals list` (empty, populated, and as the
default subcommand), `reject` including the ambiguous-batch-prefix refusal,
`apply` on both confirmations, `review` with y/n/s in one run, and the whole
stranded flow — list, `--review` for both answers and skip, and the "nothing
stuck" state. Every case asserts stdout, the exit code AND the rows left behind.

**Web:** `modules/api/approvals.route.test.ts` drives the real handlers for
list, count, apply, reject and stranded (GET and POST) over a real
temp-directory LanceDB, including the guards, the deliberate 200-with-failures
versus 409-claimed-nothing distinction, and the stale-snapshot `resolved: 0`
case.

**Found by doing it:** `approvals review` with piped input, or with Ctrl-D
pressed mid-review, discarded every decision and exited 0 — see the entry below.
That is what a surface test is for.

**Still not covered:** React component rendering (no testing library existed in
this repo at the time — see the harness entry above for the narrowing that
landed feature/todos-w11-bugfixes, 2026-08-22) and a successful Gmail mutation
(no linked account, unchanged). Both are stated in the test files themselves
and in the harness entry above.

### `email-agent fetch` could not store a single email
**Completed:** feature/todos-w3-tests (2026-08-07)
Found by the first use of the new temp-DB fixture; it was never in the backlog
because no test had ever written an email row to a real table. `upsertEmails` —
the only write path for fetched mail (`gmail/sync.ts`) — threw on EVERY call
against a table created by the current `initDb()`. Two independent defects,
both reproduced against `@lancedb/lancedb` 0.15.0:

1. **Nullability.** `createEmptyTable(name, schema)` builds non-nullable columns
   (apache-arrow's `Field` defaults to `nullable = false`) while LanceDB infers
   `nullable = true` from the plain JS objects handed to `execute()`.
   `mergeInsert` refuses the mismatch — `` `id` should have nullable=false but
   nullable=true ``, once per column. `table.add()` coerces, which is why every
   other writer in the package worked.
2. **The join key.** `mergeInsert` composes the probe column as
   `target_accountId` and parses it as an UNQUOTED SQL identifier, so DataFusion
   folds it to `target_accountid`: `No field named target_accountid`. Same
   camelCase rule `db/MODULE.md` already stated for `.where()`, in a place with
   no escape hatch — backticking the key yields `` target_`accountId` `` and
   fails differently.

Replaced with delete-then-append over a predicate grouped BY ACCOUNT.
`accountId IN (a, b) AND id IN (p, q)` is the obvious one-liner and is a cross
product: on a two-account fetch it matches the pairs (a, q) and (b, p) the batch
never named and deletes that mail. There is a behavioural test for exactly that.
The cost is two commits instead of one, so a crash between them loses rows —
bounded to rows the call already holds fresher copies of in memory, and stated
at the function.

### LanceDB caps an unlimited query at 10 rows
**Completed:** feature/todos-w3-tests (2026-08-07)
Also found by the fixture — the first test to put more than ten rows in a real
table. `@lancedb/lancedb` 0.15.0 applies a DEFAULT LIMIT OF 10 to a plain
FILTERED query, not only to a vector search: a 25-row table answers
`countRows()` with 25 and `query().where("status = 'pending'").toArray()` with
ten. `limit(0)` is not "no limit"; it is zero rows.

Every unbounded scan in the repo used `table.query()` with no limit, so:
  - the approval queue LISTED AT MOST 10 QUEUED GMAIL CHANGES however many were
    queued, and `approvals apply` / the web Apply acted on those ten and
    reported the rest as "not claimed by this run";
  - `claimPendingOperations` reads its rows back by token to learn what it won —
    capped at 10, so an apply could mutate Gmail for rows it never learned it
    owned and never write their outcome down. A chunk is 10 today, exactly at
    the boundary;
  - `getStaleApplyingOperations` could omit stranded rows, the one surface an
    unaccounted-for mutation appears on;
  - `getEmails` returned 10 whatever `limit`/`offset` was asked for (paging is
    done in JS over the match set), `getActionResults` returned 10, and the
    batched email lookup resolved 10 emails and rendered the rest as "not in
    local DB".

`email-lookup.ts` carried a comment asserting the opposite as fact — "a default
of 10 applies to VECTOR searches only, so leaving it off is both correct and
bounded by the predicate". It had never been checked. Both copies now carry the
measurement instead. Fix: `UNLIMITED_QUERY_ROWS` in `db/utils.ts`, exported from
the db barrel so the CLI (barrel-only) uses the same constant rather than a
fourth hand-copied value.

### `approvals review` discarded every decision when its input ended
**Completed:** feature/todos-w3-tests (2026-08-07)
Found by running the built binary end to end. Three queued changes with answers
piped in: the first answer was read, the second prompt printed, and the process
exited **0** with all three rows still `pending`. Nothing applied, nothing
rejected, and the shell told the command had succeeded. The same happens when a
user presses Ctrl-D partway through a real interactive review.

`readline/promises` settles a pending `question()` only on a `line` event, and
it PAUSES input between questions. At EOF with a question outstanding the
interface emits `close`, the promise never settles, commander's action promise
hangs, nothing keeps the event loop alive and node exits 0 — with the collected
decisions sitting in local arrays `commitReviewDecisions` never receives.

Racing a `close` listener against the question was tried first and is NOT the
fix: it stops the hang but `close` still wins ahead of lines already in the
buffer, so answers two and three are lost just as silently. Draining the
interface's async iterator keeps it in flowing mode — every buffered line is
delivered and `done` arrives only at real EOF. Verified on three paths: three
piped answers all arrive, an empty stdin yields EOF on the first ask instead of
hanging, and a real pty still echoes and records normally. All three prompts now
treat EOF as a value: `stop` for a review (keep what was decided, exactly as `q`
already did), `skip` for a stranded row, and No for the `[y/N]` confirmation.


### The mutation guard trusts the Host header
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P2. `mutationGuardResponse` derived "is local" from
`new URL(request.url).hostname` — i.e. from the caller's own `Host` header — and
validated `Origin`/`Sec-Fetch-Site` only when they happened to be present, which
they are not on a non-browser client. `curl -X POST -H 'Host: localhost:3847'`
therefore satisfied the entire guard and could bulk-approve the queue.
`GET /api/approvals` had no guard at all.

Closed at the only layer that can close it: **the listener now binds
`127.0.0.1`**. `next dev`/`next start` and `email-agent serve` all pass
`--hostname`, and `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` (already the documented
escape hatch) also opens the bind to `0.0.0.0`, so "I meant to expose this" is
one switch; `serve --host` overrides and prints what the exposure costs. Off-box
processes no longer reach the socket at all, whatever `Host` they would have
sent.

**Correction (review of PR #10).** "One switch" only held in one direction.
`serve --host 0.0.0.0` opened the listener and left the header guards demanding
a local `Host`, so every request from the LAN — the entire point of the flag —
answered 403; and with `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` the guard still
compared the browser's LAN-IP `Origin` against Next's own URL and refused that
too. Both now work end to end: the env flag short-circuits the whole header
check rather than a subset, and `serve --host <non-loopback>` sets the flag for
its child so the bind and the guards agree (`resolveServeEnv`, under test). The
third documented path did not exist at all and is now documented as not
existing: `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1 npm start` stays on `127.0.0.1`,
because `packages/web/package.json` hardcodes `--hostname`, so the variable only
relaxes headers on a server nothing off-box can reach. README says to use
`email-agent serve` for remote access. Alongside that, mutations must now carry at least one of
`Origin`/`Sec-Fetch-Site` — a browser always sends at least one (`Origin` on
every non-GET fetch since long before Fetch Metadata, which Safari only shipped
in 16.4/2023), so the UI is unaffected while the header-less one-liner is
refused — and a new `readGuardResponse` applies the same host/origin/site checks
to every route that returns mail. Reads deliberately do NOT require the fetch
metadata, so the address bar and local debugging still work.

The first pass at that guarded the routes someone thought of and then claimed
the set was complete. `GET /api/actions/[id]/results` was not in it, and it
returns `resultData` — the model's raw text, the email ids it decided about, its
reasons, and whatever a user action chose to return. `GET /api/accounts`,
`GET /api/actions`, `GET /api/actions/user` and `GET /api/settings` were open
too. All are guarded now, and the completeness claim is no longer a claim:
`packages/web/src/modules/api/route-guards.test.ts` walks `app/api`, fails on
any unguarded handler, and holds a named exemption list containing exactly one
entry — `GET /api/auth/callback`, which Google reaches as a top-level
cross-site navigation the guard would refuse and which is protected by its
one-time OAuth state cookie instead.

**Correction (review of PR #10).** The first version of the header half read the
host from `new URL(request.url)`, which is not the caller's `Host`: installed
Next composes that URL from the server's own configured hostname
(`attachRequestMeta` in `next/dist/server/next-server.js`, whose render server
defaults the hostname to `localhost`). Measured against a running server, under
both `next dev --hostname 127.0.0.1` and `next start --hostname 127.0.0.1` every
request arrived at the handler as `http://localhost:<port>` whatever `Host` was
sent. That broke the guard in both directions: a browser on
`http://127.0.0.1:3847` — the URL Next and `email-agent serve` both print — was
403'd out of every mutation, and a DNS-rebound `Host: evil.example` never
reached the allowlist at all, so `GET /api/approvals` answered 200 with the
queue. The unit tests missed it because they built
`new Request("http://evil.example…")`, a shape the runtime never produces. The
guard now reads the `Host` header directly, accepts an `Origin` naming any local
hostname on the port the caller addressed (so `localhost` and `127.0.0.1` both
work and `localhost:8080` does not), and ignores `X-Forwarded-Host`, which a
rebound page can set for itself. The tests were rebuilt around the real shape —
Next's fixed URL plus a separate `Host` header — and the behaviour was re-checked
against a live server.

Stated honestly in the code, `CLAUDE.md`/`AGENTS.md`, the module cards and the
README: the header checks buy anti-DNS-rebinding and anti-CSRF for browsers plus
a speed bump against a naive client, and nothing more, because every input is
caller-controlled. The bind is the boundary. A shared secret would additionally
cover another *user* on this machine; it did not ship because there is no safe
in-band bootstrap for it — see "The local API still has no shared secret" above
for the design and the reason. A process running as this user is out of reach of
all of it and always will be.

### Batch the email lookup in GET /api/approvals
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P2. Both approval surfaces ran one `getEmailById` per distinct queued email.
They now build one predicate — ``(`accountId` = '…' AND id IN ('…')) OR …``, one
group per account, quotes escaped, `accountId` backticked because DataFusion
folds unquoted identifiers to lowercase, and joined into a single string because
`.where()` maps to `onlyIf` and replaces rather than ANDs — and key results back
through a Map on `(accountId, emailId)`, since a Gmail id repeats across
accounts. Implemented at the surface layer in `packages/web/src/modules/api/`
and `packages/cli/src/` because `packages/core` was owned by another branch this
wave; the duplication (including a copied `escapeSql`) is recorded as its own
follow-up.

**Correction (review of PR #10).** The scan carried `.limit(refs.length)` with a
comment asserting "at most one row per pair, so this can never truncate".
Nothing enforces one row per `(accountId, id)`: with two `a@x.com/id1` rows and
one `b@x.com/id2` row, a limit of 2 stopped on the duplicates and the Map came
back without `b@x.com/id2` — which both approval surfaces render as "not in
local DB" for an email that is sitting in the table. The limit is gone; LanceDB
applies no default limit to a plain filtered query (the default of 10 is for
vector searches), so the predicate alone bounds the scan. Both files gained a
test that opens a REAL temp-directory LanceDB table, inserts an actual duplicate
row, and asserts the other account's row still comes back — replacing the "only
the filter string is under test" gap that had its own P2 entry. The same tests
run the apostrophe-escaping and injection cases against the real parser, which
also settles whether DataFusion accepts `id IN (...)` with parenthesised `OR`
grouping: it does.

### Distinguish an unclaimed apply from a no-op apply
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P3. `POST /api/approvals/apply` answered 200 with all-zero counts when it
could claim none of the submitted ids, and the panel toasted "Applied 0 changes"
as a success — telling the user their approval went through when nothing reached
Gmail. Core claims each row before touching Gmail and reports one
applied-or-failed entry per claimed row, so `requested - (applied + failed)` is
exactly the set of ids **this call did not claim**; deriving it from the result
instead of re-reading the table keeps it race-free. The apply route returns
`requested`/`skipped` on the 200 and on the 409 — the two responses the apply
itself produces — and answers 409 when nothing at all was claimed; a guard
failure (403), a validation failure (400) and an unexpected error (500) return
`{ error }` only, as they always did. The reject route reports the same
accounting, the hooks read the server's message off a failed response and
invalidate the approvals query on error so the panel re-syncs, and the toast
wording is a pure tested function. `approvals apply` in the CLI says the same
thing. Core's return shape was not touched.

**Correction (review of PR #10).** The arithmetic was right and its
interpretation was not. "Not claimed by this call" was being reported as
"already applied or rejected somewhere else", which is only one of the reasons a
claim fails: the row may be `applying` in a request that is still running, may
have failed in an earlier run, or may not exist. Tab B could therefore submit a
stale selection, get `0/0`, and be told its changes were already applied or
rejected while tab A was in the middle of applying them. The helpers are renamed
for what is known (`claimedNothing`, `unclaimedApplyMessage`; the CLI calls the
count `unclaimed`), every message now asserts only that this run did not touch
the rows and offers the reasons as possibilities, and the tests assert the
absence of the old sentences as well as the presence of the new ones. The 409
stays: "your view of the queue conflicts with the server's" is exactly what is
known.

### Snapshot restore has no surface
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P3. `email-agent actions snapshots [list]` and
`email-agent actions snapshots restore <snapshot> [--action <file>] [-y]` now
exist, deriving the target action from the snapshot's own filename and
confirming before overwriting. `restoreSnapshot` writes through
`saveUserAction`, so the save-time source guard re-validates the snapshot and a
pre-guard snapshot containing a value import is refused — the command catches
`UnsafeActionSourceError` specifically and prints the violated rules plus a
pointer at `~/.email-agent/actions/.snapshots/` for a manual copy, rather than
letting it read as a generic failure. The web actions page still has no restore
control; that half is recorded as a follow-up.

### Share the email-detail query with mail-display
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P3. `EmailReviewDialog` keyed its fetch `["email", emailId, accountId]`, the
reverse of `mail-display`'s `["email", accountId, emailId]`, so the same email
cached twice and an invalidation after an apply refreshed only one copy.
`hooks/use-email-detail.ts` now owns the fetch, the response type and the key,
and `emailDetailQueryKey` is the single place the order is written down. There is
no React test harness in this repo, so the sharing is enforced by types and by
both call sites being one code path; the caching behaviour itself is not under
test.

### Client DTOs are hand-mirrored from route responses
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P4. `ApprovalEmailSummary`/`ApprovalOperation` were declared in both the
route and the hook. They now live once in
`packages/web/src/modules/api/approvals-contract.ts`, imported by the routes and
re-exported by `hooks/use-approvals`, so a field added on one side is a compile
error on the other. The file is deliberately free of any `@email-agent/core`
import — client hooks import it, and web code outside `modules/api` may not pull
core runtime into the browser bundle.

### `approvals review` drops rejections when the apply throws
**Completed:** feature/todos-w2-surfaces (2026-08-07)
Was P3. `applyOperationIds(approved)` ran before `rejectOperationIds(rejected)`,
so a network failure part-way through the apply threw before a single rejection
was written and every explicit per-email "no" the user had just typed was
discarded. Rejecting only rewrites queue rows and never calls Gmail, so it is
the half that cannot fail mid-mutation: it goes first now.
`commitReviewDecisions` runs both halves regardless of the other failing — the
id sets are disjoint, so neither failure makes the other unsafe — and returns
the errors instead of throwing, so `describeReviewCommit` can say exactly what
was and was not recorded: it does not claim rejections survived when the reject
itself failed, and it does not claim nothing reached Gmail when the apply died
part-way. `review` exits non-zero if either half failed. Both functions are pure
enough to be under test, including the ordering itself.

### Config hygiene: shared consent rule, a legacy-key notice, a prototype guard, and a name that lied
**Completed:** feature/todos-w4b-config (2026-08-07)
Four core-config entries, plus the two doc follow-ups other waves left behind.
Two of them are only half closed and say so in their own sections above; do not
read this entry as covering the web and CLI adoptions.

- **One consent-invariant implementation** (was P3), HALF DONE. The rule
  "`autoApplyActions` requires `autoApplyAcknowledged`" is now
  `normalizeAutoApplyConsent` in `config/settings.ts`, called by
  `normalizeSettings` and exported from `@email-agent/core/config` with the exact
  signature web's copy already has. Behaviour is unchanged, including the
  `=== true` coercion that stops a truthy non-boolean from arming anything.
  Tests pin the full truth table, the missing-section and missing-key cases, the
  truthy-non-boolean refusals, the exact key set, and that `normalizeSettings`
  agrees with the shared function for every combination — so a second copy
  *inside core* fails rather than drifting. **`normalizeGmailConfig` in
  `packages/web` is still a duplicate**; the adoption is written down at the
  function and tracked under "The consent invariant is shared but not yet adopted
  by web".
- **Reject prototype-chain segments in dotted config paths** (was part of "The
  consent flag records consent…"), HALF DONE. `config/dotted-path.ts` refuses
  `__proto__`/`constructor`/`prototype` in any position, including the terminal
  one, and refuses before touching the target so a rejected write leaves the
  object untouched; reads are guarded identically. Stated honestly in the code:
  this is hygiene, not a fix for a live vulnerability. The route was probed and
  does not work today because `normalizeSettings` materializes both consent flags
  as OWN properties and an own property shadows the polluted prototype — a
  property of a DIFFERENT function, which is the whole argument for guarding
  here. Also fixes a latent `typeof null === "object"` bug carried from the CLI
  original. (The CLI adopted them on feature/todos-w10-cleanup (2026-08-07); at the time of this
  entry it still used its private copies, so the guard had no caller yet.)
- **Notify when a legacy `gmail.syncActions` key is dropped** (was P3). Done.
  `loadSettingsFromPath` warns once per settings path per process, saying what
  the key did, that its value is dropped, that changes are queued for approval
  now, where to re-enable auto-apply, and how to silence it. The difficulty was
  entirely in "once", given that `loadSettings()` re-reads the file on every call
  — a `serve` calls it per request, so a notice hung off the read would print
  hundreds of times and train the user to ignore the log. Two guards, both
  needed: detection sits on the parse, which only runs on a cache miss, and a
  warned-paths set covers the case the first guard misses, since an edit that
  changes the bytes while leaving the legacy key in place IS a genuine cache
  miss. The regression test walks exactly that sequence and asserts one line
  total. Scoped per module instance rather than per process, and the comment says
  so: Next.js does not guarantee one instance of this module per process, so a
  second bundled copy warns once too. `hasLegacySyncActionsKey` is an
  own-property check (a polluted prototype cannot fabricate the key) and is
  value-independent, because `syncActions: false` was also a preference.
- **Rename `GmailSyncConfig`** (was P4). Now `GmailAutoApplyConfig`. No
  deprecated alias: neither `packages/web` nor `packages/cli` names the type
  anywhere — both reach it structurally through `AppConfig["gmail"]` — which the
  type-checks confirm.
- **Document the `tokensUsed` definition at the schema field** (was P4, deferred
  by `feature/todos-w4-executors`). All three declarations now carry it:
  the Arrow field in `db/connection.ts`, `ActionResultRecord.tokensUsed`, and
  `ActionRunResult.tokensUsed`. Each also records the consequence that outlives
  the fix — rows written before 2026-08-07 hold the old per-executor
  measurements and cannot be aggregated with newer ones, with `createdAt` the
  only discriminator — and the Arrow field notes that `Int32` is a real ceiling
  for anything summing the column.
- **OAuth redirect URI is origin-derived** (was P3, Web). Documented in README
  (a new "Adding Gmail accounts: authorized redirect URIs" section) and in
  `setup.sh`'s output at the step where the user is pasting URIs into the Google
  console: every origin the app is served on must be a registered authorized
  redirect URI, since `serve --port N` makes the port part of the callback, and
  `127.0.0.1` is a different origin from `localhost`. The concurrent-flow note is
  stated more precisely than the original entry had it: the second flow
  overwrites the shared state cookie, and because a 403 refusal ALSO clears that
  cookie, the first callback returning stale can take the second flow down with
  it — so both tabs may be rejected, not just the first. The route is web-owned
  and untouched.

Two entries in this wave were closed by DECISION rather than by code, and both
argue their case in their own sections rather than here: `action_results`
`accountId: ""` stays overloaded (its `accountId` filter has no caller, and both
candidate representations cost more than the ambiguity does), and applying
operations stays serial (`batchModify` rejected outright for having no
per-message result; a bounded pool deferred behind three named preconditions).

### User action files are parsed as pure data instead of being imported
**Completed:** feature/todos-w5-static-extraction (2026-08-07)
Replaces the two P2 "approval provenance" entries ("A user action can still
approve its own queue rows", "`saveSettings` lets plugin code arm auto-apply for
itself"). Both proposed a credential proving a call came from a real user
surface; that was rejected on the grounds recorded in the residual above (no
unforgeable caller identity exists inside one process, and the runner's
auto-apply path has no user surface in the loop anyway). The problem was
upstream: untrusted files were executing in our process at all.
`loadUserAction()` imported them through `new Function("p", "return import(p)")`
and `ActionRegistry.loadFromDirectory()` `import()`ed every `*.action.ts` in
`ACTIONS_DIR` on each CLI `run-action`, with only a SAVE-time guard in front —
nothing ran at load. Since `EmailAction` is pure data and `mapSingleResult` maps
only built-in ids, actions never needed to be code: `isPureDataExpression` became
the value-producing `evaluatePureData`, `safeNames` became name→value, and
`extractActionData()` returns the action object without the file entering the
module graph. `findActionSourceViolations()` is the same traversal with values
discarded, so save-time and load-time cannot drift. Built-ins keep native
`import()` (in-repo, reviewed, genuinely modules). Refusals now warn with the
full violation list at both call sites — the registry's old trailing `catch {}`
made a rejected file simply vanish. `loadUserAction`/`loadAll` signatures are
unchanged, so the CLI and the web route needed no edits. Also refused now:
`__proto__` as an object-literal key, which sets a prototype rather than binding
a property — the same "does this syntax bind what it appears to bind" failure as
the ambient `declare` hole, and only observable once the object was actually
being materialised. Behavioural cost, documented in CLAUDE.md and README: a
hand-WRITTEN action that computes anything stops loading. Such a file could
never have been saved through the app, so the only people affected are power
users hand-authoring executable actions in `ACTIONS_DIR` — a capability the
threat model does not want — and the refusal is loud rather than silent.
Verified end to end with `HOME` overridden at a scratch dir: pure-data action
loads with the expected object; an action writing a file at import time is
refused with its violations and the file is never written; the same bytes under
the old `new Function` import do write it.

### The `pending_operations`/`action_results`/`emails` migrations, and the machinery built for a drop that was never necessary
**Completed:** feature/todos-w1-queue (2026-08-07)
Closes four entries at once — not by hardening them, but because the premise
under all of them was false.

Every migration in `db/connection.ts` was built on one sentence, stated in
the root memory files and repeated in the header of every migration file:
**"LanceDB has no ALTER TABLE — drop and recreate."** It is not true of the
installed version. `@lancedb/lancedb` **0.15.0** exposes
`Table.addColumns(AddColumnsSql[])`, `alterColumns` and `dropColumns`
(`node_modules/@lancedb/lancedb/dist/table.d.ts:251,257,269`), and running
them against the real native binary (`lance` 0.22.0) on a legacy-shaped table
shows `addColumns` adds a column in place with every row preserved, the new
column immediately updatable and filterable, and an Arrow type exactly
matching what the CAST names for Utf8, Int32 and Bool — including nullability.

So the mechanism was swapped rather than hardened. All four tables now go
through one path: probe with `missingColumns()`, then `ensureTableColumns()`
(`db/migrations.ts`) calls `addColumns` with per-table sentinels that produce
exactly what a fresh insert writes. Nothing is dropped, so there is nothing
for a crash to destroy, and the failure mode that made the drop unrecoverable
— a retry seeing a fresh current-schema table and concluding there was nothing
to migrate — cannot arise.

Closed by this:
- **`pending_operations` migrates without a drop** (was the crash-recoverable
  migration). The durable snapshot, the cross-process `mkdir` lock and the
  merge-by-id replay are gone: 953 lines across `db/table-backup.ts`,
  `db/migration-lock.ts`, `db/pending-operations-migration.ts` and its test.
  Two review rounds had found real defects inside that subsystem (swallowed
  fsync failures, a `mkdir` lock that can admit two owners, a replay window in
  which a lost claim lets a Gmail mutation apply twice); a third hardening
  pass would have been hardening the wrong mechanism.
- **`action_results` migrates with no snapshot and no lock** (was P2). It no
  longer drops. The follow-up written here — "generalize the snapshot
  machinery to `action_results`" — is **deleted, not done**: the machinery it
  would have generalized does not exist any more and should not be rebuilt.
- **The `action_results` migration has never met a real legacy table** (was
  P2). It has now. `db/schema-migration.test.ts` builds real
  temp-directory LanceDB tables in the OLD shape and runs the real
  `migrateSchema()` — the whole of `initDb()` bar which directory the database
  lives in — over legacy `pending_operations` (rows in `applied`, `rejected`,
  `failed`, `applying` and `pending`), legacy `action_results` (Int32 columns
  intact) and legacy `emails` (embedding vector intact).
- **Ordinary queue writes ignore the migration lock** (was P3). There is no
  lock and no drop window, so there is no write to lose to one.

`emails` migrates in place too, deliberately. Its rows are re-fetchable from
Gmail, so a drop would not have been unrecoverable — but each row carries an
embedding that costs a paid API call to rebuild, `""` is already the
documented legacy account sentinel, and leaving zero drop-and-recreate
migrations in the tree is what stops the rule eroding back into one.

Concurrency, observed rather than reasoned: five forked two-process runs of
`addColumns` over one table give one commit and one loud "Column already
exists" failure, with every row surviving in every interleaving.
`createEmptyTable` behaves the same way on a brand-new database ("Table
already exists"). `ensureTableColumns` re-probes the table's current schema
after either failure and only treats it as somebody else's success when the
columns are genuinely there — it never reads "the call failed" as "somebody
else did it". This is strictly better than the lock design achieved, and it
needs no lock at all.

Two limits, stated because they are real: `addColumns` APPENDS, so a migrated
table's column order differs from a fresh one (nothing resolves columns
positionally); and a `FixedSizeList` vector column cannot be produced this way
(`CAST(NULL AS FLOAT)` yields a scalar). No table needs one added after the
fact today.

**The lesson, which is the point of this entry.** A capability claim about a
dependency is a fact with a version attached. It must be re-checked against
the installed package — the `.d.ts` in `node_modules`, and a throwaway script
against the real binary — not inherited from a comment. One wrong sentence in
a memory file generated days of unnecessary and defect-prone machinery, and
every review round that followed audited the machinery instead of the claim
underneath it. The verified facts are now recorded WITH the version they were
verified against (0.15.0 / lance 0.22.0, 2026-08-07) in both root memory files
and in the header of `db/migrations.ts`, so the next person knows exactly what
to re-check on an upgrade.

### Settings that could not be read were treated as settings that did not exist
**Completed:** feature/todos-w1-queue (2026-08-07)
Was HIGH. `readSettingsBytes` caught every error from `readFile` and returned
null, so EACCES, EIO and ENOTDIR all resolved to "the user has no settings
file" and therefore to the built-in defaults. One of those defaults destroys
data: `retention.approvalQueueDays` defaults to 365 while the explicit opt-out
is 0, and the post-approval sweep in `actions/approval.ts` reads it. A user
who set 0 to keep their approval audit trail forever would have had rows
deleted the first time the file was momentarily unreadable — an irreversible
action taken because we could not read the instruction saying not to.

ENOENT alone now means "absent, first run, defaults are right". Every other
errno throws with the errno and the path. A file that exists but does not
parse throws for the same reason: unparsable is not evidence that the user
configured nothing. Tested against real filesystem failures rather than
malformed strings — a directory where a file is expected (EISDIR), a file used
as a path component (ENOTDIR), and chmod 000 (EACCES, skipped only under
root).

Follow-on, in the same wave: the runner read the auto-apply toggle from inside
the try that populates `applyError`, so a settings-read failure would have been
reported as "some Gmail changes may already have been applied" for a batch
where nothing was claimed and no Gmail call was made. The read moved outside
that try; when it fails, auto-apply is not attempted and the batch stays
queued, which makes every surface's "N changes await your approval" literally
true.

### loadSettings cache made the auto-apply kill switch stale
**Completed:** feature/todos-w1-queue (2026-08-07)
Was P1. `loadSettings()` cached the parsed config for the life of the process,
so a long-running `serve` that read `gmail.autoApplyActions` as ON kept
auto-applying after the user turned it off, until restart.

The first fix keyed the cache on `path + mtimeMs + size` and was **wrong**, in
a way that left the same staleness fully reachable: `mtimeMs + size` is not
file identity. `git checkout`, a restore from backup, `rsync --times` and any
editor that preserves timestamps all reproduce the mtime, and two valid
settings files differing only in a boolean are trivially the same byte
length. Reproduced against a built `dist` by codex (gpt-5.6-sol xhigh):
equal-length content, mtime restored after the rewrite, and the process
reported the kill switch ON while the file said OFF, with no bound on how
long. The same check also had a genuine TOCTOU — the `stat()` ran before the
`readFile`, so an entry could tag pre-read metadata onto different bytes.

Settled shape: `loadSettings()` **reads the file on every call** — it is a
small local file — and caches only the parse, keyed on a sha256 of the bytes
it actually read. The cheap path skips the JSON parse and normalization when
the content is unchanged; it never skips the read. That closes both the
identity hole and the TOCTOU, because the bytes validated are the bytes
parsed. A missing file is cached as "missing" (null hash) so a settings.json
created later is picked up. `clearSettingsCache()` is now only a test
affordance and a way to drop the retained object — every real edit
invalidates by construction. The earlier commit message's claim that "every
file change is detected" held only for changes that move mtime or size; it
holds without qualification now. Pinned by the reviewer's exact reproduction
in `config/settings.test.ts` ("sees a kill-switch flip that preserves BOTH
mtime and byte length"), which asserts the equal mtime/size premise before
asserting the new value is read.

**The Next.js module-instance question is answered, and the answer was the
bad one.** Verified from a production `next build` rather than a running
server, so it is empirical without needing one: every route entry requires
the single shared `webpack-runtime.js`, which holds one module registry per
process — but webpack does not always place a module in a shared chunk.
`app/api/auth/callback/route.js` carries its OWN inlined copy of
`config/defaults.ts` + `config/settings.ts` (the distinctive literals
`"Summarize the following email concisely"` and `approvalQueueDays` appear in
`chunks/982.js`, `chunks/170.js` AND that route entry). `/api/settings` (the
writer) loads chunk 982; `/api/approvals/apply` loads 982 and 170. So
separate module instances DO occur, and a process-global invalidation hook
would only ever clear the caller's own copy. The per-call re-read is
therefore necessary, not merely sufficient: it is per-instance and
file-driven, so every copy converges on the file regardless of how many exist.
Caveat: measured on the production build; dev-mode on-demand compilation was
not checked, and the same reasoning applies to it because the mechanism is
the file, not the cache.

### Approval queue: recovery, retention, dedupe, ordering, and honest failures
**Completed:** feature/todos-w1-queue (2026-08-07)
Nine entries closed together because they are one path. In queue order:

- **Parent row before queue rows** (was P2). Queue rows are stamped
  `batchId = resultId` and were written before the `action_results` row,
  whose failure was only logged — leaving rows pointing at a batch that was
  never recorded, unattributable with nothing to reconcile against. The
  parent is now written first; if it fails, queueing is skipped and
  `queueError` says plainly that nothing was applied. Deliberate direction:
  proposals are reproducible by re-running the action, orphaned queue rows
  are not reconstructable.
- **Dedupe identical pending operations** (was P3). An enqueue now looks up
  still-pending rows for the batch's emails and drops proposals whose
  `(account, message, type, sorted labels)` identity already appears there,
  plus duplicates inside the incoming batch.

  **Best-effort, for the common serial case — not a uniqueness guarantee.**
  It is a check-then-insert: two concurrent action runs can both finish the
  read before either writes, and both then insert rows with distinct UUIDs.
  The queue shows the duplicate pending proposals and will let the user apply
  both. Left that way deliberately. LanceDB's only insert-if-absent primitive
  is `mergeInsert(on).whenNotMatchedInsertAll()`, which matches on column
  equality alone and cannot express "insert unless a matching row is
  PENDING"; keying on the dedupe identity would also suppress re-proposals
  after a rejection or an apply, and a suppressed re-proposal is invisible,
  leaving the user nothing to act on. Trading a visible duplicate for a
  hidden proposal is the wrong direction. The collapse of duplicates *within*
  one batch is exact, because the whole batch is in hand. Scoped to PENDING
  only, and
  that is the judgement call: a re-proposal after a rejection is legitimate
  — the user said no to one instance, and suppressing the next would hide
  the proposal entirely, leaving them nothing to act on. Same argument for
  `applied` (mail restored from Trash, a label re-added). What is never
  useful is two identical rows in the pending list at once.
  `enqueueOperations()` keeps its `string[]` return; the new
  `enqueueOperationsDetailed()` reports what was actually written.
- **Resolve rows per operation rather than per batch** (was P3). Implemented
  as chunked claim-apply-resolve, `APPLY_RESOLUTION_CHUNK_SIZE = 10`. The
  argument: `applyOperations` awaits one Gmail round trip per operation
  (~100-300ms), so a chunk is ~1-3s of mutated-but-unrecorded exposure
  whatever the batch size, while LanceDB table rewrites stay proportional to
  batch/10 instead of batch. A failure to record a chunk aborts the rest of
  the batch rather than being swallowed — continuing to mutate mail whose
  fate cannot be written down is the exact failure the gate exists to
  prevent.

  The first version claimed **every** id as `applying` before the loop and
  the comment claimed a crash stranded at most one chunk. That was false:
  only the mutated-but-unrecorded set was bounded. A crash after the claim,
  or a first-chunk `resolveClaimedOperations()` failure, left the entire
  remaining batch claimed — with 200 rows, up to 200 became ineligible for
  approval *or* rejection even though only 10 had reached Gmail. The claim is
  now inside the loop (`applyClaimedOperationsInChunks`, dependency-injected
  so the sequencing is testable without LanceDB or Gmail), each chunk mints
  its own token, and what is guaranteed is now what is written down: at most
  one chunk stranded in `applying`, every later id still `pending` and still
  approvable or rejectable.
  Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.
- **Auto-apply failure said "nothing was applied"** — closed in two steps.
  Wave 1 split the fields: it had reused `queueError`, whose comment claimed
  the rows stay queued — false post-claim, since
  `applyPendingOperationsByIds` can throw after every Gmail call completed.
  Auto-apply failures set a separate `applyError`, worded "may already have
  been applied; their outcome could not be recorded"; `persistError` is a lost
  history row; `queueError` means only a pre-Gmail queue failure. That changed
  nothing a user saw. feature/todos-w7-surface-adoption (2026-08-07) wired it
  up: both surfaces branch on `applyError` first, print core's string verbatim,
  and neither reports the batch as awaiting approval nor prompts to apply the
  remainder.
- **Surface rows stranded in `applying`** — closed in two steps.
  `claimedAt` is stamped whenever a row leaves `pending`, and
  `getStaleApplyingOperations()` returns rows claimed longer ago than a
  threshold (default 15 minutes). `createdAt` could not serve: it records when
  the change was proposed, so a row queued days ago and claimed a second ago
  would read as stranded. A row whose timestamp cannot be parsed surfaces
  rather than hides. Deliberately a report, not an auto-retry.
  feature/todos-w7-surface-adoption (2026-08-07) gave it callers on both
  surfaces plus `adjudicateStrandedOperations`, which AT THAT POINT recorded
  only what the USER reported about Gmail and verified nothing. That last
  clause is no longer true of the function, and this entry is kept corrected
  rather than left as shipped, because an archived present-tense sentence is
  read as current: feature/todos-w11-bugfixes made
  `adjudicateStrandedOperations` the SINGLE write path for both sources —
  `options.evidence` says which — and the second source,
  `verifyStrandedApplyingOperations()`, does check Gmail, reading the message's
  current labels back before anyone is asked (see "Verify a stranded apply
  against Gmail instead of asking the user" above). What did NOT change: it is
  adjudication, not recovery — neither source establishes CAUSATION, nothing
  re-applies and nothing rolls back. Do not restate either as recovery.
- **Retention / prune policy** (was P2). `prunePendingOperations(olderThanIso)`
  runs opportunistically after every apply and reject, counting before
  deleting because a LanceDB delete rewrites the table. Only `applied` and
  `rejected` are eligible: `pending`/`applying` are unresolved, and `failed`
  is excluded on purpose — it looks terminal but it is the diagnostic record
  of an attempted mutation the user may still be chasing. Window is
  `retention.approvalQueueDays`, default 365; a non-positive or non-finite
  value disables pruning rather than pruning everything, because the failure
  that matters is losing evidence that cannot be reconstructed.
- **The claimToken migration dropped the audit trail** (was P3). It dropped
  the whole table, taking applied/rejected rows — the record of Gmail changes
  that really happened — while warning only about "queued (unapproved)"
  changes. It now reads every row, drops, recreates and re-inserts. Each new
  column is filled with its documented unset sentinel, so a queued row comes
  back exactly as a fresh enqueue writes it.

  The first version of that fix was **not durable and not concurrency-safe**,
  and its warning text, commit title and test all said otherwise. Read →
  drop → create → add has no atomicity of its own: a crash, a full disk or a
  failing `add()` after the drop destroyed every row, and the retry then saw
  a fresh current-schema table and skipped recovery — so the loss was both
  silent and permanent. `initPromise` is module-local and never serialized a
  `serve` against a CLI run.

  Settled shape, in `db/pending-operations-migration.ts` +
  `db/table-backup.ts` + `db/migration-lock.ts`: the projected rows are
  written to a durable snapshot (temp file → fsync → atomic rename → dir
  fsync) BEFORE the drop; the re-inserted row count is read back and
  verified; the snapshot is deleted only then. A snapshot found on startup is
  proof a migration was interrupted, and is replayed — merged by `id` with
  whatever the table currently holds, on-disk rows winning, so a concurrent
  write made after the snapshot is not erased by the recovery. An unreadable
  snapshot aborts init loudly instead of being read as "nothing happened". A
  cross-process `mkdir` lock (stale after 5 min, 60 s wait, then throw rather
  than migrate unlocked) serializes migrations; the fast path — no snapshot,
  table already current — takes no lock at all.

  **SUPERSEDED, same day.** All of the above is deleted. The drop it was
  built to survive was never necessary: LanceDB 0.15.0 has `addColumns`, and
  the column is now added in place with every row preserved. See "The
  `pending_operations`/`action_results`/`emails` migrations, and the
  machinery built for a drop that was never necessary" at the top of this
  section. Kept here only so the sequence of decisions is readable — do not
  treat this paragraph as describing current code.
  Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.
- **Column-probe self-heal for pending_operations** (was P3). Generalized
  from "is `claimToken` there" to "which of the current schema's columns are
  missing", so the next added column is handled by construction. The
  projection also strips columns the current schema no longer declares, which
  the `action_results` path does not do. (The probe survived the mechanism
  swap and is still `missingColumns()`; the projection did not — `addColumns`
  rewrites no rows, so nothing needs projecting, and a column the schema no
  longer declares is now left in place rather than dropped.)
- **`resolvePendingOperations` dead code** (was P3). Deleted rather than
  un-exported: it resolved on a bare `status = 'pending'` predicate, so the
  next caller would have reintroduced the claim race, and an "internal"
  marker is only a comment.

Test coverage, stated exactly. Every table's migration runs against a real
temp-directory LanceDB (`db/schema-migration.test.ts`, which replaced
`db/pending-operations-migration.test.ts` when the mechanism was swapped), and
the chunked apply's
claim/apply/resolve ordering is pinned through injected dependencies
(`actions/approval.test.ts`). Everything else is pure-helper only — filters,
projections, the dedupe key, the age rule, the retention cutoff. The
wording tests on both surfaces (`action-run-contract.test.ts`,
`run-action.test.ts`, and the stranded blocks in `approvals-contract.test.ts`
and `approvals.test.ts`) are pure-function tests: they pin the sentences, but
nothing fails if a component or route stops calling the function that produces
them. See "THE SURFACES WAVE" item 3 above. Remaining LanceDB halves are listed under "Queue
helpers with real-table behaviour are unit-tested only".

### `tokensUsed` means a different thing in every executor
**Completed:** feature/todos-w4-executors (2026-08-07)
Was P3. Four executors reported four different measurements into one column:
the Claude CLI executor recorded `usage.output_tokens` only, codex recorded
input+output, the SDK executor summed input+output, and `openai-compatible.ts`
preferred `total_tokens`. Any aggregate over `action_results.tokensUsed` was
comparing unlike things.

Picked one definition and gave it a single home (`agents/tokens.ts`):
**tokensUsed = total tokens processed = all input (cached counted at full
weight) + all output.** It measures work, not money — we deliberately do not
model per-provider cache discounts, because each provider prices them
differently and none reports a normalised figure. `0` now means "not reported",
never "free".

The root cause of the drift turned out to be worth writing down: providers use
the same field name for opposite things, so "sum input and output" is not a
portable instruction.
- **Anthropic** (Claude CLI + Agent SDK): `input_tokens` is the *uncached
  remainder*; `cache_creation_input_tokens` and `cache_read_input_tokens` are
  **additive**. Live `claude -p --output-format json` run whose entire answer was
  the word "pong": `input_tokens: 2`, `cache_creation_input_tokens: 13901`,
  `cache_read_input_tokens: 15242`, `output_tokens: 4` — a true total of
  **29,149** against the **4** the executor was recording. Roughly four orders of
  magnitude of under-reporting, on the default agent.
- **Codex**: `input_tokens` is the *complete* input and `cached_input_tokens` is
  a **subset** of it (see the next entry).
- **OpenAI-compatible**: `total_tokens` is already the total.
- **Gemini**: `tokens.total` derives from `usageMetadata.totalTokenCount`, also
  already a total.

Unit tests pin each provider's arithmetic against its recorded shape and guard
explicitly against both historical miscounts (output-only; double-counted
cached input). Documented in `agents/tokens.ts`, the agents `MODULE.md`, and
`CLAUDE.md`/`AGENTS.md`. One piece was left open at the time — the comment at the
schema field declarations, which lived in another wave's territory — and landed
on `feature/todos-w4b-config` (2026-08-07); see the config-hygiene entry at the
top of this section.

### Codex token counts are inferred, not verified
**Completed:** feature/todos-w4-executors (2026-08-07)
Was P3 (the gemini half of the original entry remains open above). The suspicion
was that codex's **27,124 tokens for a one-word reply** was cached-context
accounting rather than the request's own usage. It is not — the number was
real, and the parsing was already correct; only the interpretation was wrong.

Live `codex exec --json` run (codex-cli 0.145.0), whole answer "pong":

```json
{"type":"turn.completed","usage":{"input_tokens":21403,
 "cached_input_tokens":5888,"cache_write_input_tokens":0,
 "output_tokens":5,"reasoning_output_tokens":0}}
```

A delta test settled the semantics: adding ~4,000 tokens of filler to the prompt
moved `input_tokens` 21,403 → 25,412 (**+4,009**) while `output_tokens` stayed
at 5. So `input_tokens` is **request-scoped and tracks the prompt 1:1** — not
cumulative across a session — and `cached_input_tokens` is a **subset** of it,
since a ~21k prompt cannot also carry 5,888 additional tokens. The old 27,124
figure is what you get by adding the cached field in (21,403 + 5,888 + 5 =
27,296, same shape); the executor never did that, so no fix to the arithmetic
was needed.

The ~21k baseline is genuine: codex ships its own system prompt, tool
definitions and skill descriptions on **every** request. That is a real cost
signal, so recording `null`/0 instead — the alternative the entry offered —
would have discarded information rather than improving it. Rejected on that
basis.

Two secondary findings recorded in code comments: the legacy
`msg.info.total_token_usage.total_tokens` branch has **never** been observed
(0.145.0 emits no `msg` envelope at all) and its semantics remain unverified;
and `reasoning_output_tokens` is treated as a subset of `output_tokens`, which
matches OpenAI convention but was 0 in every observed run and so is itself
unconfirmed.

### User actions are silently broken on the declared Node floor
**Completed:** worktree-approval-gate-bypass (2026-08-06)
Was P2. `package.json` engines said `>=20.12.0`; Node at that floor cannot
strip `.ts` type annotations at all (unflagged support landed in 22.18), so
`loadUserAction()`'s native-loader import failed for every user action, and the
failure was swallowed by `catch { // Skip invalid files }` — the web listed the
action and then reported "Action not found", the CLI just omitted it. Nobody
had hit this because development runs a much newer Node. Fixed by raising the
engines floor to `>=22.18.0` (root `package.json`; the workspace packages don't
declare their own `engines`, so nothing else needed updating there), updating
`setup.sh`'s version-gate check and failure message, and updating the two
Node-version mentions in README.md. `loadUserAction`'s import now has its own
`catch` that `console.warn`s the filename and error before continuing to the
next file — a future load failure (malformed export, runtime error in the
action's own code) is diagnosable instead of invisible; skip semantics are
unchanged. This also retires the "inert on the declared floor" scoping fact
above — `.action.ts` files now import for real on the Node version we claim to
support, not just on whatever a developer happens to have installed.
Found by: codex (gpt-5.6-sol xhigh) adversarial pass during /review
(2026-08-06); fixed in worktree-approval-gate-bypass.

### User actions can bypass the gate entirely
**Completed:** worktree-approval-gate-bypass (2026-08-06)
Was P1. A generated `.action.ts` (dynamically imported in-process) could
`import { applyOperations } from "@email-agent/core"` — or any raw Gmail write
op — and mutate Gmail with no queue row, no approval, no audit trail. Closed by
construction with fix (a)+(d) of the original entry: `applyOperations`, the
six write operations (`markAsRead`, `markAsUnread`, `trashMessage`,
`markAsSpam`, `addLabels`, `removeLabels`), and — caught by the /review
security pass — the raw client factories (`createGmailClient`,
`createGmailClientForAccount`, whose gmail.modify-scoped client every write op
wraps in one line) are no longer exported from any public barrel, and the
package `exports` map (exact keys, no wildcards, key set pinned by test) is the
only thing Node's loader consults for a by-name import, so no public
specifier reaches mutation.

**Scope of what this actually closed, measured during /review.** Weaker than
the original entry implied, and worth stating so nobody re-derives it: from the
real `ACTIONS_DIR` (`~/.email-agent/actions`) NO bare specifier resolves —
`@email-agent/core`, `@email-agent/core/gmail` and even `googleapis` all give
`ERR_MODULE_NOT_FOUND`, because the resolver walks up from that directory and
finds no `node_modules` containing them. So the literal one-line bypass the
entry described was already failing there; what the barrel change buys is
defense in depth for workspace-resolvable contexts and a loud failure instead
of a silent mutation. It is NOT an enforcement boundary: a user action runs
in-process with full Node privileges, and
`new URL("./gmail/operations.js", import.meta.resolve("@email-agent/core"))`
reaches every raw mutator by path from any context where the package name
resolves. Real enforcement came later, from a different direction entirely: user
action files stopped being executed at all (see "User action files are parsed as
pure data instead of being imported"), which is why the approval-provenance idea
this entry pointed at was ultimately rejected. Core keeps using relative
imports; web's manual
mail actions (the click-is-the-approval path) moved to a webpack-only
`@email-agent/core/gmail/operations` tsconfig path that Node refuses at runtime
(`ERR_PACKAGE_PATH_NOT_EXPORTED`). Both skill docs now prohibit any import
beyond `type { EmailAction }` and explain that mutation flows through the
approval queue. `barrel-surface.test.ts` pins the absent exports, the surviving
approval surface, and the runtime resolution refusal. Deliberately NOT a
sandbox: absolute-path `import()` of dist files by local code is out of scope,
as the section header states.

### Chained `.where()` silently dropped every filter but the last
**Completed:** feature/approval-gate (2026-08-06)
LanceDB's `where()` maps to `onlyIf`, which REPLACES the predicate rather than
ANDing it, so `query().where(A).where(B)` matched B alone — verified empirically
against `@lancedb/lancedb` 0.15.0. Consequences: `getEmails({unreadOnly,
accountId})` dropped the account filter, so `run-action --account work@` and the
web equivalent fed **every** account's unread mail into the runner and queued
proposals stamped with the wrong account; `getActionResults` dropped its
`actionId` filter whenever an `accountId` was passed; `getPendingOperations`
dropped its status filter. Fixed by joining predicates into one string at all
three call sites (`emails.ts`, `actions.ts`, `pending-operations.ts`), and the
CLAUDE.md gotcha that endorsed chaining now warns against it. The approval gate
itself was never breached — every safety-critical predicate
(`buildClaimFilter`, `buildPendingResolutionFilter`) was already a single
combined string. Found by: Fable pre-merge review of the approval gate.

### Codebase audit remediation
**Completed:** feature/audit-fixes (2026-08-06)
Semantic audit of the whole repo (no TODO/FIXME markers existed — every finding
was an unmarked stub, stale export, or wrong implementation), then four reviewed
waves. Correctness: OAuth login-CSRF state, named Gmail accounts throwing
instead of silently falling back to gcloud ADC (cross-account contamination),
LanceDB sort-before-limit, `action_results` account scoping, executors no longer
swallowing failures or parsing obsolete CLI shapes, real end-to-end streaming,
web cache/abort/settings fixes, CLI setup/port/cron/validation fixes. Cleanup:
~1,700 net lines of dead code removed (notifications module, Gmail Pub/Sub, the
threads vertical, an orphaned setup page, ~25 consumer-free exports), duplicated
logic extracted, docs resynced. Reviewed three times by Codex (gpt-5.6-sol,
xhigh); its findings — including a root `.env` that setup wrote and nothing
loaded, and a `process.loadEnvFile` call below the declared Node floor — were
fixed before merge. Tests 43 → 76.

### Approval gate for Gmail-mutating actions
**Completed:** feature/approval-gate (2026-07-31)
AI-proposed Gmail changes are queued in `pending_operations` and require explicit
user approval via the web panel or CLI; opt-in auto-apply is gated behind a
recorded acknowledgement of its warnings.
