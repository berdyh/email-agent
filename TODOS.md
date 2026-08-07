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

### Recover rows stranded in `applying`
**Priority:** P2
The claim/lease means a crash mid-batch now leaves rows in `applying` rather
than `pending`, so a later pass will NOT silently re-apply them (only `pending`
rows can be claimed) — the dangerous half of this is fixed. What remains is
that such rows are stranded: nothing surfaces them, nothing retries them, and
`getPendingOperations({status:"pending"})` hides them from every UI. Needs a
recovery path — surface stale `applying` rows past some age, and let the user
decide whether the Gmail mutation actually landed.
Found by: data-migration specialist and adversarial review during /ship.

### Auto-apply failure after the Gmail calls says "nothing was applied"
**Priority:** P2
`runner.ts:151-159` reuses `queueError` for auto-apply failures, and its comment
("the rows stay queued") is false for the post-claim case.
`applyPendingOperationsByIds` can only throw before any Gmail call (claim) or
**after every Gmail call has completed** (`resolveClaimedOperations`,
`approval.ts:163`). In the second case the CLI prints "could not be queued for
approval — nothing was applied" (`run-action.ts:73-79`) and the web toasts the
same (`actions/page.tsx:49-52`) — while the mail really was trashed or marked
spam, and the rows sit in `applying`, invisible to every surface. The user is
told the opposite of what happened to their mailbox. Give auto-apply failures
their own field (`applyError`) with honest wording: "changes may have been
applied; their outcome could not be recorded". Pairs with "Recover rows stranded
in `applying`" above, which covers the rows but not the false reassurance.
Found by: Fable pre-merge review, 2026-08-06.

### `resolvePendingOperations` is dead code without claim discipline
**Priority:** P3
`db/pending-operations.ts:186-224`, exported at `db/index.ts:31`, has no
production caller — `resolveClaimedOperations` superseded it. It resolves on a
bare `status='pending'` predicate, so the first person to reach for it
reintroduces exactly the claim race this branch fixed. Delete it, or un-export
it and mark it internal.
Found by: Fable pre-merge review, 2026-08-06.

### The claimToken migration drops the audit trail, and says it doesn't
**Priority:** P3
`db/connection.ts:176-187` drops the whole `pending_operations` table when the
`claimToken` column is missing, so applied and rejected rows — the audit trail
the feature exists to keep — go with it. The warning text mentions only
"queued (unapproved) Gmail changes". Either preserve resolved rows the way the
`action_results` migration now does, or state the audit-trail loss plainly.
Found by: Fable pre-merge review, 2026-08-06.

### Cross-process claim atomicity is unconfirmed
**Priority:** P2
The claim/lease design is correct **if** two concurrent `table.update()` calls
on the same rows (a CLI run and a `serve` process) cannot both commit — i.e. if
LanceDB either errors on commit conflict or re-evaluates the predicate for the
loser. That behaviour was not confirmed against the local-filesystem backend, so
the guarantee the whole gate rests on is currently assumed. Confirm it against
the installed version (a two-process test, or reading the Rust commit-conflict
path), and write down the answer.
Found by: Fable pre-merge review, 2026-08-06 (listed as unverifiable from a
read-only review).

### Resolve rows per operation rather than per batch
**Priority:** P3
Status is still written once for the whole batch after every Gmail call
completes, so the window above exists at all. Per-row (or chunked) resolution
would shrink it to a single operation, at the cost of one LanceDB update per
row — LanceDB updates rewrite the table, so this is a real tradeoff at batch
sizes above a few dozen.

### Write the action_results row before enqueueing its operations
**Priority:** P2
`runner.ts` stamps queue rows with `batchId = resultId` and writes them before
the parent `action_results` row, whose failure is only logged. That can leave
queue rows referencing a batch that was never recorded, with no reconciliation.

### Retention / prune policy for pending_operations
**Priority:** P2
Rows are append-only and never deleted (resolved rows are kept as an audit
trail), so the table grows for the life of the install and every query scans it.
Add `prunePendingOperations(olderThanIso)` and call it from apply/reject or
`initDb`, or expose `approvals prune`.

### Dedupe identical pending operations
**Priority:** P3
Re-running an action over the same unread emails before approving enqueues a
second identical `(emailId, type)` pending row under a new batch. Neither the UI
nor the apply path dedupes.

### The action_results migration has never met a real legacy table
**Priority:** P2
`initDb` drops and recreates `action_results` when the `accountId` column is
missing, and now reads every legacy row first and re-inserts it with
`accountId: ""` so history survives (LanceDB has no ALTER TABLE). That
read→drop→recreate→reinsert path was reasoned through and unit-tested around,
but never run against an actual pre-column table — and the failure mode it
guards against is exactly the one it could cause: losing every past action run.
Build a fixture with the old schema and exercise it before an upgrade does.
Found by: Codex pre-merge review, 2026-08-06.

### action_results `accountId: ""` carries two meanings
**Priority:** P3
`""` means either "legacy/unscoped ADC row" or "an all-accounts run whose emails
spanned more than one account" — a single-account batch now resolves to that
account via `deriveResultAccountId`, but a mixed batch falls back to the same
sentinel as legacy rows. Account-filtered history therefore cannot represent a
genuine multi-account run. An explicit representation (a `mixed` marker, or
per-account result rows) was deferred. Same theme as "Ambiguous account identity
for queued unscoped rows" below, different table.

### Column-probe self-heal for pending_operations
**Priority:** P3
`initDb` only checks that the table exists, unlike `emails`/`action_results`
which probe for a missing column and drop+recreate. The first added column will
need the established pattern.

## Core agents / executors

Opened by the codebase audit and its Codex (gpt-5.6-sol) review passes,
2026-08-06. The executor layer was the weakest area of the audit: it had been
swallowing failed runs, dropping system prompts, and parsing obsolete CLI
output shapes. Those are fixed; what follows is what the fixes did not reach.

### `tokensUsed` means a different thing in every executor
**Priority:** P3
`claude-executor.ts:82` records `usage.output_tokens` only; `codex-executor.ts`
records input+output (or `total_token_usage.total_tokens`); the SDK executor
sums input+output; `openai-compatible.ts` prefers `total_tokens`. Cost or usage
reporting built on the `action_results.tokensUsed` column therefore compares
values that are not the same measurement. Pick one definition (total is the
obvious one), apply it across all executors, and say which it is at the schema
field. Only direct-api/openrouter were standardized during the cleanup.

### Codex/Gemini token counts are inferred, not verified
**Priority:** P3
The *text* parsing of both CLIs is live-verified (a one-word canary and a
system-prompt canary both round-trip). The token-count field shapes were read
from docs, not observed: `msg.info.total_token_usage.total_tokens` for codex and
`stats.totalTokenCount` for gemini. A live codex smoke run reported **27,124
tokens for a one-word reply**, which looks like cached-context accounting rather
than the request's own usage — verify against a real run before trusting the
number for cost tracking.

### The Gemini executor path is effectively unexercised
**Priority:** P3
`isAvailable()` now probes without installing (it used to `npx`-install the CLI
as a side effect of the availability check), so on a machine without the CLI it
correctly reports false — which also means nothing has ever exercised its
execute/parse path end to end. Verify on a machine with `gemini` installed, or
decide the executor is unsupported and say so.

### direct-api / OpenRouter routing is unit-tested only
**Priority:** P3
`apiExecutorOrder()` (`router.ts`) and the availability semantics are covered by
unit tests, but no live call has been made through either API executor. The
first real use is also the first test of the request shape, error handling, and
abort propagation.

## Core config

### loadSettings cache makes the auto-apply kill switch stale
**Priority:** P1
`loadSettings()` caches indefinitely in-process. `gmail.autoApplyActions` is the
kill switch for unattended Gmail mutation, so a long-running `serve` process
that read it as ON keeps auto-applying after the user turns it off, until
restart. Stat/mtime-check `SETTINGS_PATH`, or bypass the cache for that read.
Note for the fix: `clearSettingsCache()` — the obvious invalidation hook — was
deleted during the audit cleanup because it had zero callers at the time
(`chore: audit cleanup wave`). Reinstating it, or an mtime check inside
`loadSettings`, is part of this work rather than a regression to report.
This may be worse than "until restart": if Next.js gives each route bundle its
own module instance, a web PUT that disables auto-apply updates one
`cachedSettings` copy while the actions route keeps reading its own. Unverified
(needs a running server) — check it while fixing, because it decides whether an
mtime check is sufficient or the read must bypass the cache entirely.

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
then, only pure helpers are covered.

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
