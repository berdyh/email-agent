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
**Blocked on:** "The claimToken migration drops the audit trail" (below).
Add an `approvedVia` column to `pending_operations` — `web` | `cli` |
`auto-apply` — written when a row is claimed. This is **attribution only, zero
prevention**: as the residual above explains, the value is set by whichever
in-process caller performs the apply and proves nothing about who asked for it.
It is worth having anyway, because "was this batch applied by a person or by
the auto-apply setting?" is currently unanswerable from the table, which is the
one question an audit trail exists to answer.
Blocked because LanceDB has no ALTER TABLE, so adding a column means
drop+recreate, and the migration that would do it currently discards resolved
rows — doing this first would destroy the very audit rows it exists to enrich.
Fix that entry first, then add the column through the preserving path.

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
"UI only". Separately, `setNestedValue` should reject `__proto__`/`constructor`
/`prototype` path segments as hygiene — the prototype-pollution route was
probed and does not currently work, because `saveSettings` always writes both
keys as own properties.

### The mutation guard trusts the Host header
**Priority:** P2
`mutationGuardResponse` derives "is local" from `new URL(request.url).hostname`,
and `Origin`/`Sec-Fetch-Site` are simply absent on non-browser clients. Any
process that can reach port 3847 with `Host: localhost` can bulk-approve the
whole queue. `GET /api/approvals` has no guard at all and returns subjects,
senders, and snippets. Pre-existing, but this change points it at the endpoint
that represents the user's personal consent.

## Core actions / approval queue

### ⚠ THE SURFACES WAVE — nothing wave 1 added is visible to a user yet
**Priority:** P1
**Read this before claiming any wave-1 queue improvement is "fixed".** Wave 1
(feature/todos-w1-queue) added core data and core capabilities. It changed
**nothing** about what the web UI or the CLI shows. Two of the improvements
below are worded as if the user-facing bug were fixed; it is not, and the
misleading message a user reads after a failed auto-apply is still shipped.

**1. `applyError` / `persistError` / `duplicateOperations` are written and
never read.** `ActionRunResult` distinguishes three failures; no surface reads
more than `queueError`, and on an auto-apply failure `queueError` is UNSET, so
neither surface prints its copy — they take different wrong branches instead.
Concretely, when Gmail trash succeeds and the queue write-back then fails, the
runner leaves `pendingOperations` populated and sets `applyError` — the web
still reports those now-`applying` rows as "N changes await your approval", and
the CLI queries `status: "pending"` for the batch and prints "nothing was
applied" when that comes back empty (a multi-chunk abort instead leaves later
ids pending, so it prompts to apply those). Every one of those messages is
false about mail that has really been trashed.

Files that must change:
- `packages/web/src/hooks/use-actions.ts` — the run-result type omits
  `applyError`, `persistError` and `duplicateOperations`; add them.
- `packages/web/src/app/actions/page.tsx` (~L49-52) — reads `queueError`
  only. Print `applyError` when present, with the "may already have been
  applied" emphasis, and stop reporting `pendingOperations` as awaiting
  approval when `applyError` is set (those rows are `applying`, not
  `pending`).
- `packages/cli/src/commands/run-action.ts` (~L73-79) — same field, same
  wrong message; it must not print "nothing was applied" when `applyError`
  is set.
- Print the core strings (`describeAutoApplyFailure`,
  `describeUnrecordedBatchFailure`, exported from `@email-agent/core`)
  rather than composing new copy — they are already worded for display.
- Surface `duplicateOperations` ("3 were already awaiting approval")
  instead of silently showing fewer rows than the action proposed.

**2. `getStaleApplyingOperations()` has no caller.** Exported from
`@email-agent/core` and `@email-agent/core/db`, threshold
`STALE_APPLYING_THRESHOLD_MS` (15 min), returns `pending_operations` rows a
crash left claimed. Nothing calls it, so those rows are invisible on every
surface — not listed, not actionable. Needed: a section in
`packages/web/src/components/actions/approval-panel.tsx` (plus a
`/api/approvals/stranded` route) and an `approvals stranded` block in
`packages/cli/src/commands/approvals.ts`, each stating plainly that the Gmail
change may or may not have landed and letting the user resolve the row by
hand. Do NOT auto-retry — re-trashing an already-trashed message is not free,
and only the user can adjudicate.

**3. A test must go through a surface.** `packages/core/src/actions/runner.test.ts`
only asserts the text of two string builders; it cannot pin what a user is
told. The regression that closes item 1 has to exercise the surface, which
needs the harness tracked under "Integration harness for the approval gate".

Found by: wave 1 (feature/todos-w1-queue, 2026-08-07); scope corrected after
the codex (gpt-5.6-sol xhigh) review of PR #8, 2026-08-07, which found the
branch describing these as fixed. Deferred here because a concurrent branch
owns `packages/web/**` and `packages/cli/**`.

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

### The retention window has no surface
**Priority:** P3
`retention.approvalQueueDays` (default 365) governs pruning of resolved
`pending_operations` rows and is honoured by `loadSettings`, but the web
Settings page cannot show or edit it: `sanitizeSettingsForResponse` and
`SettingsUpdate` in `packages/web/src/modules/api/validation.ts` build
explicit literals that omit it. It does survive a settings PUT — the merge
spreads `...current` first — so the only gap is visibility, and hand-editing
`~/.email-agent/settings.json` is currently the only way to change it. A CLI
`approvals prune [--older-than-days N]` would also make the sweep
inspectable rather than purely opportunistic.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07).

### Queue helpers with real-table behaviour are unit-tested only
**Priority:** P2
Most of what wave 1 added is covered at the pure-helper level only — filters,
the dedupe key, the age rule, the retention cutoff. What no test touches is
the LanceDB behaviour they depend on: that `table.delete(filter)` removes
exactly the rows `buildPruneFilter` selects, and that
`getPendingOperationsForEmails` returns the pending rows a dedupe check needs.
Belongs to the integration harness below.

Two of the original items here are now genuinely covered and should not be
re-listed: every table's migration runs against a real temp-directory LanceDB
in `db/schema-migration.test.ts` (legacy `pending_operations`, `action_results`
and `emails` shapes, rows in `applied`/`rejected`/`failed`/`applying`, both
halves of a concurrent-init race, and a refusal that leaves rows intact), and
the chunked apply's claim/apply/resolve ordering — including the per-call
scope of the stranded-chunk bound — is pinned in `actions/approval.test.ts`
through injected dependencies.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07); narrowed after the
PR #8 review pass, 2026-08-07.

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

### Cross-process claim atomicity is unconfirmed
**Priority:** P2
The claim/lease design is correct **if** two concurrent `table.update()` calls
on the same rows (a CLI run and a `serve` process) cannot both commit — i.e. if
LanceDB either errors on commit conflict or re-evaluates the predicate for the
loser. That behaviour is still not confirmed against the local-filesystem
backend, so the guarantee the whole gate rests on is currently assumed.

Adjacent evidence exists now and must NOT be mistaken for an answer. Two
processes calling `Table.addColumns()` on the same table were tested against
the installed 0.15.0 (five forked runs): one commits, the loser fails with
"Column already exists in the dataset", and no row is lost in any
interleaving. That shows Lance commits are conflict-checked for a *schema*
operation. It says nothing about whether two `update()` commits with
overlapping predicates can both land, which is a different conflict class.
Confirm the `update()` case specifically — a two-process test over one row, or
the Rust commit-conflict path — and write down the answer.
Found by: Fable pre-merge review, 2026-08-06 (listed as unverifiable from a
read-only review); narrowed 2026-08-07 after the addColumns concurrency probe.

### action_results `accountId: ""` carries two meanings
**Priority:** P3
`""` means either "legacy/unscoped ADC row" or "an all-accounts run whose emails
spanned more than one account" — a single-account batch now resolves to that
account via `deriveResultAccountId`, but a mixed batch falls back to the same
sentinel as legacy rows. Account-filtered history therefore cannot represent a
genuine multi-account run. An explicit representation (a `mixed` marker, or
per-account result rows) was deferred. Same theme as "Ambiguous account identity
for queued unscoped rows" below, different table.

## Core agents / executors

Opened by the codebase audit and its Codex (gpt-5.6-sol) review passes,
2026-08-06. The executor layer was the weakest area of the audit: it had been
swallowing failed runs, dropping system prompts, and parsing obsolete CLI
output shapes. Those are fixed; what follows is what the fixes did not reach.

### Document the `tokensUsed` definition at the schema field
**Priority:** P4
Follow-up left open by `feature/todos-w4-executors` (2026-08-07), which unified
the definition across every executor but could not touch the schema because
`db/**` and `actions/**` belonged to a concurrent wave. The canonical meaning —
**total tokens processed = all input (cached at full weight) + all output; `0`
means "not reported", never "free"** — is now stated in
`packages/core/src/agents/tokens.ts`, the agents `MODULE.md`, and
`CLAUDE.md`/`AGENTS.md`, but not where a reader of the column would look first.
Add a comment at all three declarations: `db/connection.ts:65`
(`new Field("tokensUsed", new Int32())`), `db/schema.ts:34`, and
`actions/types.ts:59`. Pure documentation — no behaviour change.

Worth a glance while in there: `Int32` is a real ceiling, not a formality. A
single codex request already costs ~21k tokens (see below), so anything that
sums this column will reach 2^31 far sooner than the old output-only numbers
suggested.

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

### Notify when a legacy gmail.syncActions key is dropped
**Priority:** P3
Upgrading users silently lose the old preference (fail-safe direction — it lands
off), but nothing tells them their auto-sync setting was reset.

### Share one consent-invariant implementation
**Priority:** P3
The rule "autoApplyActions requires autoApplyAcknowledged" is implemented twice:
`normalizeSettings` (core) and `normalizeGmailConfig` (web validation). The
duplication is deliberate defense-in-depth at the API boundary, but the two must
not drift — export the core normalizer and have the web layer call it.

### Rename GmailSyncConfig
**Priority:** P4
The interface no longer has a "sync" field; it now holds the auto-apply flags,
and the name points readers at the unrelated `gmail/sync.ts` pipeline.

## Web

### Batch the email lookup in GET /api/approvals
**Priority:** P2
The route does one `getEmailById` LanceDB scan per distinct queued email. The
60s sidebar poll no longer hits it (that moved to `/api/approvals/count`), but
the list still walks the emails table per row. One `id IN (...)` query plus a Map
would remove the N+1. Same shape in the CLI's `loadOperationDisplays`.

### The OAuth state/CSRF guard has no test and no live run
**Priority:** P2
The login-CSRF fix (random state in an httpOnly SameSite=Lax cookie,
timing-safe compare, 403 before `addAccount` on mismatch) is the security
control on the account-linking flow, and nothing exercises it: there are no
route-level tests for the callback or accounts handlers, and the cookie
round-trip was never run against a live Google consent flow this session. It is
verified by reading only. Add handler tests with a fabricated request/cookie
pair, then walk one real add-account flow.
Found by: audit wave 1 (own concern) + Codex review, 2026-08-06.

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

### Snapshot restore has no surface
**Priority:** P3
`GET/POST /api/actions/user/snapshots` is the only recovery path for a user
action that the edit flow overwrote, and it has no UI and no CLI command — the
audit kept the routes deliberately for this reason, but a recovery path nobody
can reach is not a recovery path. Add an `approvals`-style CLI command or a
restore control on the actions page.

### Distinguish "already resolved" from a no-op apply
**Priority:** P3
POST /api/approvals/apply returns 200 with all-zero counts when every submitted
id is stale (another tab or the CLI resolved the batch first), and the UI toasts
"Applied 0 changes" as success. Return a skipped/notPending count or 409.

### Share the email-detail query with mail-display
**Priority:** P3
`EmailReviewDialog` re-implements the email-detail fetch and uses the query key
`["email", emailId, accountId]` — the reverse of `mail-display`'s
`["email", accountId, emailId]` — so the same email caches under two keys and
targeted invalidation misses one.

### Client DTOs are hand-mirrored from route responses
**Priority:** P4
`ApprovalEmailSummary`/`ApprovalOperation` are declared in both the route and
the hook; nothing ties them together, so a field added on one side still
compiles on the other.

## CLI

### `approvals review` drops rejections when the apply throws
**Priority:** P3
`packages/cli/src/commands/approvals.ts:169-170` runs `applyOperationIds`
before `rejectOperationIds`, so if the apply throws (network down mid-batch) the
user's explicit per-email "no" answers are never recorded. The rows stay pending
rather than being wrongly applied, so it fails safe — but the decisions the user
just made are lost without being told. Reject first, or wrap the apply so the
reject still runs.
Found by: Fable pre-merge review, 2026-08-06.

## Core Gmail

### Concurrency / batchModify for applying operations
**Priority:** P3
`applyOperations` awaits one Gmail round trip per operation, so approving a large
batch serializes N network calls with the panel blocked. A bounded pool, or
`messages.batchModify` for the label/read operations, would cut this. Any change
must keep outcome ordering aligned with the input array.

### Ambiguous account identity for queued unscoped rows
**Priority:** P3
`accountEmail: ""` (the gcloud/ADC sentinel) is replayed at approval time, which
may resolve to a different identity than when the message was read if accounts
changed in between. Named-account rows are unaffected.

## Testing

### Integration harness for the approval gate
**Priority:** P2
31 of 32 coverage gaps are structurally untestable today: no test DB, no mocking
layer, no React testing library, no HTTP harness. The queue persistence, API
routes, runner gate, CLI prompts, and panel interactions all need one. Until
then, only pure helpers are covered. Wave 1 added more of them — prune,
dedupe, chunked resolution and the drop/recreate migration all have pure
cores under test and untested LanceDB halves; see "Queue helpers with real-
table behaviour are unit-tested only" above for the specific cases.

### No browser-level verification of the web surfaces
**Priority:** P3
Everything shipped in the audit waves was verified by type-check, unit tests,
module-boundary checks, and live CLI smoke runs of the executors. Nothing was
opened in a browser. The flows whose fixes are therefore unobserved in a real
UI: streaming chat generation and its abort-on-close behaviour, the approval
panel, the settings dirty-guard (unsaved edits surviving a refetch), and the
per-card action Run/Delete pending state under concurrency. This overlaps the
integration-harness entry above but is cheaper: one manual pass would cover it.

### The chained-`.where()` fix has no regression test
**Priority:** P2
Chained `.where()` calls were silently dropping every filter but the last (see
the Completed entry below); the fix joins predicates with `" AND "` at all three
call sites. Nothing prevents the next person from reintroducing the chain — the
bug is invisible to the type checker, and the existing tests only cover the pure
filter *builders*, which were always correct. A single temp-directory LanceDB
test asserting that a two-filter query returns the intersection would pin it,
and would be the first brick of the integration harness above.

### Extract remaining inline pure logic for unit tests
**Priority:** P3
The batch-grouping `useMemo` in `ApprovalPanel`, and the CLI's review-answer
classification, are pure but inlined where tests cannot reach them.

## Completed

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
- **Auto-apply failure said "nothing was applied"** — **NOT CLOSED, only
  half-built** (still P2, tracked above under "THE SURFACES WAVE"). It reused
  `queueError`, whose comment claimed the rows stay queued — false
  post-claim, since `applyPendingOperationsByIds` can throw after every Gmail
  call completed. Auto-apply failures now set a separate `applyError`, worded
  "may already have been applied; their outcome could not be recorded" and
  pointing at the stranded rows; `persistError` is new for a lost history
  row; `queueError` now means only a pre-Gmail queue failure. **What this did
  NOT change is what the user sees.** No surface reads `applyError` or
  `persistError` — the web result type omits both — and because `queueError`
  is unset on an auto-apply failure, neither surface prints its copy either:
  the web reports the now-`applying` rows as "N changes await your approval",
  and the CLI either says "nothing was applied" (nothing left pending) or
  prompts to apply the ids the crashed call never reached. A user whose mail
  was really trashed is told nothing happened. The field separation is a prerequisite
  for the fix, not the fix. Listed here only because the core data changed.
- **Recover rows stranded in `applying`** — **NOT CLOSED, only half-built**
  (still P2, tracked above). `claimedAt` is now stamped whenever a row leaves
  `pending`, and `getStaleApplyingOperations()` returns rows claimed longer
  ago than a threshold (default 15 minutes). `createdAt` could not serve: it
  records when the change was proposed, so a row queued days ago and claimed
  a second ago would read as stranded. A row whose timestamp cannot be parsed
  surfaces rather than hides. Deliberately a report, not an auto-retry.
  **Nothing calls it**, so stranded rows remain invisible on every surface —
  the recovery capability exists, the recovery does not.
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
"failure wording" tests assert the text of two string builders and reach no
surface, so they say nothing about the message a user is shown; see "THE
SURFACES WAVE" above. Remaining LanceDB halves are listed under "Queue
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
`CLAUDE.md`/`AGENTS.md`. One piece is deliberately left open — the comment at
the schema field declarations, which live in another wave's territory; see
"Document the `tokensUsed` definition at the schema field" above.

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
