# TODOS

Deferred work, grouped by component then priority (P0 highest). Completed items
move to the bottom section with the branch and date that shipped them (this repo
does not version its packages independently).

## Approval gate — enforcement boundaries

These are the gate's known limits. It stops the AI action pipeline from
mutating Gmail without approval; it is not a sandbox against local code.

**Read this before any other entry in this section.** The gate protects the
app's own mutation path from an *innocently generated* action — the realistic
failure, since these files are written by an LLM following our skill docs. It
is not, and cannot be by any barrel/exports mechanism, a control against a
*malicious* one. A user action's top-level code runs in-process with full Node
privileges before anything inspects it, so a hostile action never needs a core
symbol at all: `import("node:fs")`, read the stored OAuth tokens at
`~/.email-agent/accounts/{email}/token.json` (scope `gmail.modify`), and call
the Gmail REST API over https directly — mailbox mutated, zero queue rows,
nothing in this repo touched. Every residual below is therefore about raising
the bar for innocent code and keeping the audit trail honest.

**The main defense is now the save-time source guard**, not the barrels:
`assertSafeActionSource()` (`actions/action-source-guard.ts`) runs inside
`saveUserAction()`. It parses the file with the TypeScript compiler and accepts
only a pure-data shape — type-only imports/exports, type declarations,
variables initialised to literals/objects/arrays, and `export default`. A file
that passes contains no call, member access, `new`, function, tagged or
interpolated template, spread, computed key or getter, so there is nothing in
it that can execute at import time. That is the right layer, because it
inspects the file BEFORE it can ever be imported, which is the only moment
refusing is still possible, and it closes the generate→save path for every
residual below.

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
still looked like a literal. Ambient statements and decorators are refused now.
All of these are regression tests. The lesson to carry: when adding a case to
this allowlist, ask not "is this syntax inert?" but "does this syntax BIND what
it appears to bind at runtime?"

Its remaining limits, stated plainly: it runs only on save, so a file
hand-dropped into `ACTIONS_DIR` is never inspected, and files written before
the guard existed are not re-checked. Full containment would still need
out-of-process isolation.

Two facts that scope the residuals below, both measured 2026-08-06:
- From the real `ACTIONS_DIR` (`~/.email-agent/actions`) NO bare specifier
  resolves — `@email-agent/core`, `@email-agent/core/gmail` and even
  `googleapis` give `ERR_MODULE_NOT_FOUND`. So in the shipped install location
  the import-a-core-symbol routes are inert; the protection there is "the
  package is not on the action's resolution path", not the barrel privacy.
  (Verify with `--experimental-import-meta-resolve` and an explicit parent —
  the two-arg `import.meta.resolve` silently ignores the parent without it and
  reports a false positive.)
- The declared Node floor was 20.12, which cannot strip TS types, so
  `.action.ts` files did not import at all there — the attack surface was
  inert on the runtime we claimed to support and live only on newer Node (see
  Completed: "User actions are silently broken on the declared Node floor").
  The floor is now `>=22.18.0`, which strips types unflagged, so this is no
  longer a hypothetical: `.action.ts` files import for real on the Node
  version we ship against, and the residuals below apply there directly.

### A user action can still approve its own queue rows
**Priority:** P2
The direct-mutation bypass is closed (see Completed), but the approval-side
surface is still public by necessity: the CLI can only import from the root
barrel, and `approvals apply` / the web approvals routes legitimately need
`enqueueOperations` and `applyPendingOperationsByIds`. So a generated action
that goes out of its way can enqueue a batch and immediately apply it by id —
the rows ARE recorded (audit trail intact, unlike the closed bypass), but the
user never approved them. The generate→save path is now closed by the source
guard, which rejects the value import this route needs before the file is ever
written — so what remains is a hand-dropped file, i.e. the hostile-local-code
case the section header scopes out. Downgraded from the P0 codex assigned it
for that reason, and because the recorded rows keep the audit trail intact.
The real fix is still option (b) from the closed item: approval
provenance — make `applyPendingOperationsByIds` require proof that the approval
came from a user surface (web route / CLI prompt), e.g. a token minted outside
the module graph reachable by actions. Do not remove the exports; that breaks
the CLI's own approvals flow.
Found by: scoping the barrel-export fix (worktree-approval-gate-bypass,
2026-08-06).

### `saveSettings` lets plugin code arm auto-apply for itself
**Priority:** P2
`config/index.ts` exports `saveSettings`, which accepts both auto-apply
booleans. `normalizeSettings` only checks that `autoApplyAcknowledged` is
`true` — never who set it — so in-process code that can reach the config
module writes a fabricated acknowledgement and arms unattended Gmail writes
for every subsequent run. Same shape as the existing "consent flag records
consent" entry below, but this is the programmatic route rather than a
hand-edited file, and it persists. Gated by the same resolution reality as the
entries above (nothing resolves by name from `ACTIONS_DIR`) and now by the
save-time source guard, which refuses the value import this needs — so it is a
hostile-plugin route, not a naive one. Fix shape is the same approval
provenance work: settings writes that arm mutation should require a
user-surface credential rather than trusting any in-process caller.
Found by: codex (gpt-5.6-sol xhigh) adversarial pass during /review
(2026-08-06).

### No end-to-end denied-case test through `loadUserAction()`
**Priority:** P3
`barrel-surface.test.ts` pins the surface at the namespace/resolution level
(source barrels, dist barrels, `exports`-map keys, deep-path refusal), but the
actual attack vector — a real `.action.ts` file loaded through
`loadUserAction()`'s native-import escape hatch trying to reach Gmail mutation
— has no test. Write a temp action file that imports `@email-agent/core/gmail`
(and one that tries the deep operations path), load it through the real code
path, and assert the mutating names are unreachable / the import rejects. This
also documents empirically how bare specifiers resolve from
`~/.email-agent/actions/`. Partly superseded: `action-source-guard.test.ts`
now covers the save-time denial thoroughly (including the token-exfiltration
shape), so what is still missing is only the load-side half — which needs
`ACTIONS_DIR` to be injectable, since it is currently a homedir constant and a
test cannot write there safely.
Found by: testing specialist during /review (2026-08-06).

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
never read.** `ActionRunResult` distinguishes three failures; both surfaces
collapse them into the `queueError` copy. Concretely, when Gmail trash
succeeds and the queue write-back then fails, the runner leaves
`pendingOperations` populated and sets `applyError` — the web still reports
those now-`applying` rows as "N changes await your approval", and the CLI
queries only `status: "pending"`, finds none, and prints "nothing was
applied". Both statements are false about mail that has really been trashed.

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

### Enqueue dedupe is best-effort, not race-free
**Priority:** P3
`enqueueOperationsDetailed` is a check-then-insert: it reads the still-pending
rows for the batch's emails, then writes. Two concurrent action runs (a
`serve` and a CLI run, or two runs of the same action) can both finish the
read before either writes, and both then insert rows with distinct UUIDs. The
queue shows duplicate pending proposals for the same change and permits both
to be applied. Documented as best-effort everywhere it is described; do not
restate it as a uniqueness guarantee.

Not fixed, deliberately. LanceDB's only insert-if-absent primitive is
`mergeInsert(on).whenNotMatchedInsertAll()`, which matches on column equality
alone and cannot express "insert unless a matching row is PENDING". Keying on
the dedupe identity would suppress re-proposals after a rejection or an apply
— and a suppressed re-proposal is invisible, leaving the user nothing to act
on, which is strictly worse than a duplicate they can see and reject. Fixing
it properly needs either a `pending`-scoped uniqueness mechanism LanceDB does
not offer, or an application-level lock around enqueue (the migration lock in
`db/migration-lock.ts` is the same primitive and could be reused per
`batchId`'s email set, at the cost of a filesystem lock per run). Do not
weaken the PENDING scoping to get it.
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
re-listed: the `pending_operations` drop/recreate migration runs against a
real temp-directory LanceDB in `db/pending-operations-migration.test.ts`
(including a crash injected after the drop, and recovery from a leftover
snapshot in all four post-crash table states), and the chunked apply's
claim/apply/resolve ordering is pinned in `actions/approval.test.ts` through
injected dependencies.
Found by: wave 1 (feature/todos-w1-queue, 2026-08-07); narrowed after the
PR #8 review pass, 2026-08-07.

### `action_results` migrates with no snapshot and no lock
**Priority:** P2
`runInit()` in `db/connection.ts` still migrates `action_results` the naive
way: read every row, `dropTable`, `createEmptyTable`, `add`. That is exactly
the sequence that was found unrecoverable for `pending_operations` — a crash
or a failing `add()` after the drop loses every row, and the retry sees a
current-schema table and skips recovery. Action results are not
reconstructable (the agent run that produced them is gone), so this is real
data loss, just less severe than losing the Gmail-mutation audit trail.
`emails` has the same shape but is re-fetchable, so it is fine as is.
The machinery already exists and is table-agnostic:
`db/table-backup.ts` (`writeTableBackup` / `readTableBackup` /
`mergeRowsById`) and `db/migration-lock.ts` (`withMigrationLock`).
`db/pending-operations-migration.ts` is the template — generalize it to take
a table name, an Arrow schema and a defaults map, then point both callers at
it.
Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.

### Ordinary queue writes ignore the migration lock
**Priority:** P3
`withMigrationLock` serializes *migrations* against each other, which is the
catastrophic case (two processes running drop/recreate over one table). It
does not make the table safe to write during a migration: `savePendingOperations`,
`claimPendingOperations` and `resolveClaimedOperations` do not take the lock,
because a filesystem lock on every queue write is too costly. So a process
already past `initDb()` can write into the drop window and lose that write.
The durable snapshot bounds the damage — recovery merges the snapshot with
whatever the table holds — but a write landing strictly between the snapshot
and the drop is gone. Closing it needs either migration-aware write paths (a
shared/exclusive lock, read side held only for the duration of one write) or
a startup barrier that refuses queue writes until init completes across
processes. Note the realistic exposure is small: the window exists only on
the first start after a schema-changing upgrade.
Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.

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
loser. That behaviour was not confirmed against the local-filesystem backend, so
the guarantee the whole gate rests on is currently assumed. Confirm it against
the installed version (a two-process test, or reading the Rust commit-conflict
path), and write down the answer.
Found by: Fable pre-merge review, 2026-08-06 (listed as unverifiable from a
read-only review).

### The action_results migration has never met a real legacy table
**Priority:** P2
`initDb` drops and recreates `action_results` when the `accountId` column is
missing, and now reads every legacy row first and re-inserts it with
`accountId: ""` so history survives (LanceDB has no ALTER TABLE). That
read→drop→recreate→reinsert path was reasoned through and unit-tested around,
but never run against an actual pre-column table — and the failure mode it
guards against is exactly the one it could cause: losing every past action run.
Build a fixture with the old schema and exercise it before an upgrade does.
The `pending_operations` migration now runs the same shape through the pure
helpers in `db/migrations.ts` (`missingColumns` + `projectRowsToSchema`), which
also strip columns the current schema no longer declares; `action_results`
still does its own `{ ...row, accountId: "" }` spread. Adopting the shared
helpers would make one fixture cover both — deliberately not done in wave 1,
because changing an untested migration that can lose every past action run is
not a free refactor.
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
would only ever clear the caller's own copy. The mtime revalidation is
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
  `persistError` — the web result type omits both, and web and CLI still
  print the `queueError` copy — so a user whose mail was really trashed is
  still told "nothing was applied". The field separation is a prerequisite
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
  Found by: codex (gpt-5.6-sol xhigh) adversarial review of PR #8, 2026-08-07.
- **Column-probe self-heal for pending_operations** (was P3). Generalized
  from "is `claimToken` there" to "which of the current schema's columns are
  missing", so the next added column is handled by construction. The
  projection also strips columns the current schema no longer declares, which
  the `action_results` path does not do.
- **`resolvePendingOperations` dead code** (was P3). Deleted rather than
  un-exported: it resolved on a bare `status = 'pending'` predicate, so the
  next caller would have reintroduced the claim race, and an "internal"
  marker is only a comment.

Test coverage, stated exactly. The `pending_operations` migration and its
crash recovery run against a real temp-directory LanceDB
(`db/pending-operations-migration.test.ts`), and the chunked apply's
claim/apply/resolve ordering is pinned through injected dependencies
(`actions/approval.test.ts`). Everything else is pure-helper only — filters,
projections, the dedupe key, the age rule, the retention cutoff. The
"failure wording" tests assert the text of two string builders and reach no
surface, so they say nothing about the message a user is shown; see "THE
SURFACES WAVE" above. Remaining LanceDB halves are listed under "Queue
helpers with real-table behaviour are unit-tested only".

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
resolves. Real enforcement needs approval provenance (see the P2 entries above)
or out-of-process isolation. Core keeps using relative imports; web's manual
mail actions (the click-is-the-approval path) moved to a webpack-only
`@email-agent/core/gmail/operations` tsconfig path that Node refuses at runtime
(`ERR_PACKAGE_PATH_NOT_EXPORTED`). Both skill docs now prohibit any import
beyond `type { EmailAction }` and explain that mutation flows through the
approval queue. `barrel-surface.test.ts` pins the absent exports, the surviving
approval surface, and the runtime resolution refusal. Remaining approval-side
residual is tracked above as "A user action can still approve its own queue
rows". Deliberately NOT a sandbox: absolute-path `import()` of dist files by
local code is out of scope, as the section header states.

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
