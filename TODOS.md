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
check matched the word `type` anywhere. Both are regression tests now.

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
