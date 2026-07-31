# TODOS

Deferred work, grouped by component then priority (P0 highest). Completed items
move to the bottom section with the branch and date that shipped them (this repo
does not version its packages independently).

## Approval gate — enforcement boundaries

These are the gate's known limits. It stops the AI action pipeline from
mutating Gmail without approval; it is not a sandbox against local code.

### User actions can bypass the gate entirely
**Priority:** P1
`applyOperations` is still exported from the core barrel, and
`trashMessage`/`markAsSpam` from `gmail/index.ts`. User actions are arbitrary
`.action.ts` modules dynamically imported from `~/.email-agent/actions/` — and
they are written by the AI via `POST /api/actions/generate`. A generated action
that imports `applyOperations` directly mutates Gmail with no queue row, no
approval, and no audit trail. The gate currently rests on `ActionRunner` being
the only caller, which does not bind plugin code. Options: drop the export from
the public barrel, rename it so a bypass is visible at the call site, or lint
generated action source for direct Gmail imports.
Found by: adversarial review during /ship.

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

### Column-probe self-heal for pending_operations
**Priority:** P3
`initDb` only checks that the table exists, unlike `emails`/`action_results`
which probe for a missing column and drop+recreate. The first added column will
need the established pattern.

## Core config

### loadSettings cache makes the auto-apply kill switch stale
**Priority:** P1
`loadSettings()` caches indefinitely in-process. `gmail.autoApplyActions` is the
kill switch for unattended Gmail mutation, so a long-running `serve` process
that read it as ON keeps auto-applying after the user turns it off, until
restart. Stat/mtime-check `SETTINGS_PATH`, or bypass the cache for that read.

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

### Extract remaining inline pure logic for unit tests
**Priority:** P3
The batch-grouping `useMemo` in `ApprovalPanel`, and the CLI's review-answer
classification, are pure but inlined where tests cannot reach them.

## Completed

### Approval gate for Gmail-mutating actions
**Completed:** feature/approval-gate (2026-07-31)
AI-proposed Gmail changes are queued in `pending_operations` and require explicit
user approval via the web panel or CLI; opt-in auto-apply is gated behind a
recorded acknowledgement of its warnings.
