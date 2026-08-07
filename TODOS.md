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
**Priority:** P3
`packages/web/src/app/api/actions/route.ts:64` returns a flat
`{ error: "Action not found" }` whenever `loadUserAction()` yields nothing. Two
different situations reach that line: no file answers to the id at all, and a
file answers to it and cannot be loaded — a numeric `id`, a value import, a
construct the evaluator refuses. The second is now diagnosed loudly in the
server log by `loadUserAction()`, but the user sees the same 404 either way and
the reason never reaches the browser.

`UserActionMeta.problem` (from `listUserActions()`) carries the exact reason, so
the fix is to look the id up and answer 422 with `problem` when one exists,
reserving 404 for an id nothing presents. Not done in this pass because it is in
`packages/web`, which was out of scope for the review round that found it.
Found by: codex (gpt-5.6-sol xhigh) adversarial pass, round 2 (2026-08-07).

### Record which surface approved an operation
**Priority:** P3
**No longer blocked** (2026-08-07).
Add an `approvedVia` column to `pending_operations` — `web` | `cli` |
`auto-apply` — written when a row is claimed. This is **attribution only, zero
prevention**: as the residual above explains, the value is set by whichever
in-process caller performs the apply and proves nothing about who asked for it.
It is worth having anyway, because "was this batch applied by a person or by
the auto-apply setting?" is currently unanswerable from the table, which is the
one question an audit trail exists to answer.
The block is gone, and the sentence that created it was false: it read "LanceDB
has no ALTER TABLE, so adding a column means drop+recreate, and the migration
that would do it currently discards resolved rows". `@lancedb/lancedb` 0.15.0 has
`Table.addColumns`, no migration drops anything any more, and `ensureTableColumns`
adds a column in place with a per-table sentinel. Adding `approvedVia` is now a
field in `pendingOperationSchema` plus an entry in
`pendingOperationColumnDefaults` — see "The `pending_operations`/`action_results`
/`emails` migrations…" in Completed, whose closing lesson is exactly this: a
capability claim about a dependency is a fact with a version attached, and this
entry inherited the wrong one.

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
was written down nowhere. **`packages/cli/src/commands/config.ts` still uses its
own private `getNestedValue`/`setNestedValue`**, so the guard protects no caller
yet — see the CLI entry below.

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
this as closing the in-flight window. **Two answers, no retry, no
verification:** the buttons say "I checked Gmail — it happened" / "— it didn't",
the toast says the outcome was recorded "on your word", and an `applied` row
carries `STRANDED_APPLIED_NOTE` saying Email Agent did not check. Skipping is a
first-class answer. Do not describe any of this as recovery.

**3. A test must go through a surface. DONE** (feature/todos-w3-tests) — see
"THE SURFACES WAVE item 3" in Completed for what the CLI and web tests cover.
The pure-function tests named here still exist and still pin the wording; what
has changed is that the WIRING is now checked too, so a page or command that
stopped calling its formatter, or a route that stopped returning the field,
fails a test.

**What that closure does NOT include, stated because it is easy to lose:** React
component rendering (there is no component testing library in this repo, so
`ApprovalPanel` and `StrandedOperationsPanel` are still only type-checked), and
a successful Gmail mutation (no linked account, so every apply path in the tests
ends in a per-operation failure). The `app/actions/page.tsx` server component
itself is also not rendered by a test — the route it calls is.

**4. The retention window has a surface. DONE** — see its own entry below.

Found by: wave 1 (feature/todos-w1-queue, 2026-08-07); scope corrected after
the codex (gpt-5.6-sol xhigh) review of PR #8, 2026-08-07, which found the
branch describing these as fixed.

### An apply hung past the staleness threshold still loses its outcome
**Priority:** P2
**Narrowed:** feature/todos-w7-surface-adoption (2026-08-07)
The stranded-row adjudication protects an outcome recorded BEFORE it claims. It
does not protect an apply that is in flight AT claim time — it can only refuse
to touch rows that are not stale, which is what
`buildStrandedClaimFilter(ids, cutoffIso)` now does, folding the age test into
the same atomic write that stamps the token (a JS pre-filter would leave a
window between the test and the destructive stamp).

**What remains, exactly.** An apply that claims a row, calls Gmail, hangs past
`STALE_APPLYING_THRESHOLD_MS` (15 minutes) and THEN succeeds. The user, seeing
the row listed as stranded, answers "it didn't happen"; the adjudication stamps
its own token and requeues the row; the apply's write-back — scoped to the token
it no longer holds — matches zero rows. **What a user would observe:** the change
really is in Gmail (the message is in Trash), the queue row is `pending` again
and re-approvable, and the audit trail says the change never happened. Approving
it again sends the same mutation a second time. For `trash`/`spam` that is
idempotent; for a label pair racing an opposing operation it is not.

`resolveClaimedOperations` now DETECTS this: it keeps its claim token on every
row it writes, reads back by token, and warns with the row ids and — for a lost
`applied` — the double-mutation consequence. It reports, it does not repair;
overwriting the adjudication would replace an answer the user personally
checked with a record they have already contradicted.

**Why this losing direction was chosen.** The other direction (a hung apply's
late write wins) leaves a user who has personally looked in Gmail unable to
close out the row at all, which is the exact failure the stranded surface exists
to remove. Closing the window entirely needs the apply to hold a lease it
renews, or a two-phase record that survives the process — neither of which
LanceDB's update primitives express without a lock. Pinned by
`db/stranded-adjudication.race.test.ts`, which drives both directions against a
real temp-directory LanceDB under a throwaway `$HOME`.
Found by: codex adversarial review of PR #13, 2026-08-07.

### The adjudication count can undercount, and other queue helpers still hold stale handles
**Priority:** P3
**Found while fixing the above:** a LanceDB `Table` handle is PINNED to the
version it was opened at. A handle another writer has moved past reads OLD rows
with no error and THROWS `Commit conflict for version N` on write;
`checkoutLatest()` refreshes it in place. Verified on a real table against
`@lancedb/lancedb` 0.15.0, 2026-08-07.

`db/pending-operations.ts` now routes its claim/resolve/adjudicate writes
through `updateAtLatestVersion`/`queryAtLatestVersion` (refresh + bounded
conflict retry). **The other modules do not.** `db/emails.ts`, `db/actions.ts`
and `db/clusters.ts` each open a handle and write, and a multi-step sequence
there would hit the same conflict. Nothing observed yet, and the email/cluster
paths are single-write, so this is recorded rather than swept.

Also open, and smaller: `resolveStrandedApplyingOperations` can UNDERCOUNT what
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

### The retention window is visible, but the sweep still is not
**Priority:** P3
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

**Still open:** the sweep itself is opportunistic and inspectable nowhere. A CLI
`approvals prune [--older-than-days N]` would make it something a user can run
and see the result of, instead of a side effect of the next apply or reject.
Not built here.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07).

### Tighten the two fields declared optional for the surfaces' benefit
**Priority:** P4
`PendingOperationRecord.claimedAt` and `AppConfig.retention` are both
declared optional purely so the `PendingOperationRecord` / `AppConfig`
literals in `packages/cli/src/commands/approvals.test.ts` and
`packages/web/src/modules/api/validation.test.ts` kept compiling while core
changed on its own branch. Neither is optional in reality: the Arrow column
is non-nullable and `normalizeSettings` always populates `retention`. Add the
fields to those fixtures and make both required.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07).

### The batched email lookup is duplicated in two surfaces
**Priority:** P3
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

Core-side follow-ups this carries with it, deferred because `packages/core` was
owned by another branch:
  - `escapeSql` is hand-copied into both surfaces. The core version should be the
    only one.
  - The duplicate-row case the `.limit()` fix now tolerates would be better
    prevented: nothing enforces one row per `(accountId, id)` in the `emails`
    table. `upsertEmails` deletes that pair before appending it (it no longer
    merges — see the fetch entry in Completed), so a duplicate can only arrive by
    another path, but the invariant is unwritten and unenforced. Either state it
    where the schema is defined or make the lookup pick deterministically
    (newest `date` wins) rather than "last row scanned wins".
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
**Priority:** P3
Found while investigating the above (`feature/todos-w4-executors`, 2026-08-07).
`GeminiExecutor.isAvailable()` probes `npx --no-install @google/gemini-cli
--version`, which answers "is the CLI present", not "can it run a prompt". On
this machine it returns **true** while the CLI is unauthenticated, so the router
will select gemini as a fallback and then block on an interactive OAuth prompt
until the 120s `execFile` timeout kills it — a dead agent run per attempt,
surfacing as a timeout rather than a usable error.

Options: probe something auth-sensitive and cheap; cache a negative result for
the process lifetime after the first auth failure; or map the CLI's documented
exit codes (`1` general/API failure, `42` input error, `53` turn limit) to a
clear "installed but not authenticated" message. Deliberately not fixed here —
every option needs a live authenticated CLI to validate against, which is the
same thing blocking the entry above.

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
**Priority:** P3
**Half done** by `feature/todos-w4b-config` (2026-08-07). Core now has ONE
implementation of "autoApplyActions requires autoApplyAcknowledged" —
`normalizeAutoApplyConsent` in `config/settings.ts`, called by
`normalizeSettings`, exported from `@email-agent/core/config`, with the truth
table and the truthy-non-boolean refusals under test.

What is NOT done, because `packages/web` belonged to a concurrent branch: the
web copy still exists. `normalizeGmailConfig` in
`packages/web/src/modules/api/validation.ts` is a hand-written duplicate of the
same body with the same signature, called from `mergeSettingsUpdate` and
`sanitizeSettingsForResponse`. It should become a call to the core export,
imported from `@email-agent/core/config` — the specifier that file already uses
for `defaultConfig` and `AppConfig`. Keep the second enforcement point; it is
deliberate defense in depth at the API boundary. Only the second *implementation*
goes away.

## Web

### The local API still has no shared secret
**Priority:** P2
The Host-header hole is closed at the layer that can actually close it — the
listener binds `127.0.0.1`, so an off-box process cannot open the socket at all
— and mutations now require `Origin` or `Sec-Fetch-Site` to be present, which
refuses the bare `curl -X POST -H 'Host: localhost:3847'` one-liner. Both of
those are honest about what they are: the bind is the boundary, the header
requirement is a speed bump an attacker defeats by setting the header.

What is still open is **another process on this machine, running as another
user**. It reaches loopback and passes every check. The fix is a
locally-generated shared secret at `~/.email-agent/session.token` (mode 0600,
`randomBytes(32)`), required by `mutationGuardResponse` and `readGuardResponse`
via an `x-email-agent-token` header or an httpOnly `SameSite=Strict` cookie,
compared with `timingSafeEqual` (the `oauth-state.ts` compare is the model).

The reason it did not ship in wave 2 is the bootstrap, and it is worth writing
down so it is not rediscovered: **there is no safe in-band handshake.** Any
process that can reach the port can also `GET /`, so a cookie the server issues
on document load is issued to the attacker too. The secret has to arrive
out-of-band, which means the Jupyter model — `email-agent serve` prints/opens
`http://127.0.0.1:3847/?token=…`, a route handler exchanges the query token for
the cookie, and a browser without the cookie gets an "unlock" page telling the
user to `cat ~/.email-agent/session.token`. That is a real UX change and it
cannot be verified from here (no browser harness), so it needs its own wave with
a live run. `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` must keep bypassing it.

**Still out of scope even then, by construction:** a process running as *this*
user. It can read the token file, and it can read the OAuth tokens under
`~/.email-agent/accounts/` and call Gmail without the app at all.
Found by: audit wave 2 (todos-w2-surfaces), 2026-08-07.

### Snapshot restore is reachable from the CLI but not the UI
**Priority:** P3
`email-agent actions snapshots list|restore` now exists, so the recovery path is
no longer unreachable. The web actions page still has no restore control, which
is where a user who overwrote an action via the edit chat actually is when they
notice. Wants a "Previous versions" affordance on the action card, calling the
existing `GET/POST /api/actions/user/snapshots`, and it must surface an
`UnsafeActionSourceError` refusal as the specific rule violations (the CLI
already does) rather than as a generic failure toast.
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

### OAuth redirect URI is now origin-derived
**Priority:** P3
`getOAuthRedirectUri(request)` builds the callback from
`request.nextUrl.origin` so `serve --port N` works, which means **every origin
the app is served on must be registered as an authorized redirect URI in the
Google Cloud console** — previously only `localhost:3847` had to be. Also: two
add-account flows started concurrently in one browser share the single state
cookie, so the second overwrites the first and the first callback 403s. Both are
acceptable today; document them in the setup guide rather than let a user
discover them at the consent screen.

## CLI

### `actions snapshots` list/restore are only covered by their filename parser
**Priority:** P4
`originalFilenameFromSnapshot` is unit-tested; `collectSnapshots` and the
restore path are not, because they read and write the real
`~/.email-agent/actions/.snapshots` directory and the suite has no filesystem
fixture convention. The interesting case — restoring a pre-guard snapshot and
getting the `UnsafeActionSourceError` branch instead of the generic one — is
verified by reading only.
Found by: audit wave 2 (todos-w2-surfaces), 2026-08-07.

### Adopt the shared dotted-path config helpers
**Priority:** P3
`packages/cli/src/commands/config.ts` still declares its own `getNestedValue` and
`setNestedValue`. Replace both with `getNestedConfigValue`/`setNestedConfigValue`
from `@email-agent/core` (`config/dotted-path.ts`, added on
`feature/todos-w4b-config`, 2026-08-07), which refuse `__proto__`, `constructor`
and `prototype` in any path position and also fix a latent bug the CLI copy has:
`typeof null === "object"`, so a null intermediate is walked into rather than
replaced.

Until this lands the guard has no caller, so `config set __proto__.x true` still
writes to `Object.prototype` in the CLI process. That is not currently
exploitable — see "The consent flag records consent…" above for why, and for why
the guard exists regardless — but "not currently exploitable" is the whole reason
this is P3 rather than higher, not a reason to skip it.

`UnsafeConfigPathError` carries `path` and `segment`, so the command can print a
specific message instead of a stack trace.

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
chained-`.where()`, query-limit, email-storage and cross-process-claim tests all
use the core fixture; the web route tests and the CLI e2e tests use the two
surface harnesses over the same fixture. Three files were left on their own setup
DELIBERATELY, noted here so nobody reads them as missed:
  - `db/schema-migration.test.ts` needs a bare `connect(dir)` rather than
    `initDb()`, because it constructs LEGACY table shapes and then migrates
    them — a thing the fixture cannot express by design.
  - `db/stranded-adjudication.race.test.ts` predates the fixture and its
    hand-rolled `$HOME` swap is the pattern the fixture was derived from. Its
    setup is now the fixture's, minus the ordering guard.
  - both `email-lookup.test.ts` copies inject their own table through the
    module's `EmailLookupTable` seam and build it with `db.createTable` from
    arbitrary rows. Porting them onto the fixture would LOSE their point: the
    duplicate-`(accountId, id)` case cannot be produced through `upsertEmails`,
    which replaces that pair. They each gained a 15-row case for the query-limit
    fix instead.

**WHAT IS STILL NOT COVERED, and must not be described as covered:**
  - **React component rendering.** There is no component testing library in this
    repo and this wave did not add one. `ApprovalPanel`, `StrandedOperationsPanel`,
    the settings page and the action chat are never rendered by any test. What
    was extracted out of them (`groupOperationsByBatch`) is tested; the
    components themselves are not.
  - **Next itself.** The harness drives handlers, not the framework: routing,
    middleware, streaming responses and server-component rendering are outside
    it.
  - **A successful Gmail mutation.** Every apply path in the new tests ends in a
    per-operation failure, because there is no linked account. The claim, the
    resolution, the reporting and the exit codes are covered; "the trash really
    reached Gmail" is not, and cannot be from here.
  - **The action runner's agent half.** Nothing drives a real model, so a run
    still cannot be exercised end to end from prompt to queued operations.
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

**Still NOT covered, exactly:**
  - **The approval panel and the stranded panel were never seen POPULATED.**
    There is no Gmail account on that machine and the queue was empty, so both
    rendered their empty state. Every checkbox, the review dialog, the
    destructive-change confirmation, the toasts and the stranded adjudication
    buttons are unobserved in a browser.
  - **No automated React test exists**, so nothing prevents a regression in any
    of the above — the pass was manual and is not repeatable by CI.
  - Streaming chat generation and its abort-on-close behaviour, and the per-card
    action Run/Delete pending state under concurrency, were not exercised.

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

### `validationResponse` does not recognise a malformed JSON body
**Priority:** P4
`await request.json()` throws a `SyntaxError` that `validationResponse` does not
match, so every mutating route answers **500** — with a stack trace logged — for
a body that is simply not JSON. A well-formed body with a bad shape is correctly
a 400. Found while writing the route tests; pinned as-is in
`approvals.route.test.ts` with a comment saying it is a wart rather than a
contract, so the behaviour cannot drift unnoticed. When it becomes a 400, change
that assertion in the same commit.

## Completed

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

**Still not covered:** React component rendering (no testing library in this
repo) and a successful Gmail mutation (no linked account). Both are stated in
the test files themselves and in the harness entry above.

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
  original. **The CLI still uses its private copies**, so the guard has no caller
  yet; tracked under "Adopt the shared dotted-path config helpers".
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
  surfaces plus `adjudicateStrandedOperations`, which records what the USER
  reports about Gmail and verifies nothing. It is adjudication, not recovery —
  do not restate it as recovery.
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
