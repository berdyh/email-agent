# Email Agent

Local AI-powered email analysis tool. Monorepo with Turbo.

> **Worktree:** This directory (`main/`) is a git worktree. The bare repo is at `../.bare/`. See global CLAUDE.md for git worktree SOPs.

## Commands

```bash
npm install              # Install all dependencies
npm run build            # Build all packages (core must build first)
npm test                 # Run Node test suite through tsx
npm run check:boundaries # Verify module cards and import boundaries
npm run dev              # Start all dev servers
npm run start            # Start web UI on port 3847
npm run setup            # Interactive setup wizard (gcloud auth + DB init)
npx tsc -p packages/core/tsconfig.json --noEmit   # Type-check core
npx tsc -p packages/web/tsconfig.json --noEmit    # Type-check web
npx tsc -p packages/cli/tsconfig.json --noEmit    # Type-check CLI
```

### CLI

```bash
npx email-agent fetch              # Fetch unread emails → LanceDB (--scope all|unread, --limit N)
npx email-agent fetch --account <email>  # Fetch for a specific account
npx email-agent accounts list      # List configured Gmail accounts
npx email-agent accounts add <email>     # Add account via OAuth2
npx email-agent accounts remove <email>  # Remove account
npx email-agent accounts default <email> # Set default account
npx email-agent run-action <id>    # Run an action (priority, subscription, junk)
npx email-agent list-actions       # List available actions
npx email-agent approvals          # List Gmail changes queued for approval
npx email-agent approvals review   # Approve/reject each queued change interactively (--batch <id>)
npx email-agent approvals apply    # Approve and apply queued changes in bulk (--batch <id>)
npx email-agent approvals reject   # Reject queued changes without applying (--batch <id>)
npx email-agent setup              # Authenticate + configure project + init DB (--project <id>)
npx email-agent serve              # Start web UI (--port <port>, default 3847)
npx email-agent cron setup         # Install crontab for periodic fetching (--interval, --scope, --limit)
npx email-agent cron status        # Show current crontab entry
npx email-agent cron remove        # Remove crontab entry
npx email-agent config get <key>   # Read config value (dotted path, e.g. ui.fetchScope)
npx email-agent config set <key> <value>  # Set config value
```

## Architecture

```
packages/
  core/   @email-agent/core    — Business logic, Gmail API, LanceDB, agents, actions, analysis
  web/    @email-agent/web     — Next.js 15 App Router UI (port 3847)
  cli/    @email-agent/cli     — Commander.js CLI tool
```

For module/submodule work, load `docs/architecture/module-index.md` first, then the local `MODULE.md` card beside the area being changed.

## Key Patterns

- **Multi-account Gmail**: OAuth2 per-account auth in `gmail/account-manager.ts`, tokens at `~/.email-agent/accounts/{email}/token.json`, OAuth creds at `~/.email-agent/oauth.json`. `client.ts` routing: explicit account → default account → gcloud ADC fallback. `accountEmail?: string` threaded through all Gmail operations. Account removal/default-change calls `resetGmailClient()` to invalidate cached clients.
- **Agent system**: Strategy pattern executors (Claude SDK/CLI + Codex/Gemini CLI + DirectAPI + OpenRouter) with AgentRouter; supports streaming via `executeStream()`
- **Action system**: Plugin architecture — `*.action.ts` files auto-discovered from built-in + user dirs. Discovery is not execution: built-ins are real `import()`s (in-repo, reviewed); user files in `~/.email-agent/actions/` are PARSED as pure data and never enter the module graph
- **Approval gate**: Action runs never mutate Gmail directly. `ActionRunner` maps results to Gmail operations and always enqueues them in the LanceDB `pending_operations` table first (`actions/approval.ts`, batchId = action_results row id), so every proposed change is recorded before anything touches Gmail. Mutations then happen via `applyPendingOperationsByIds()` after explicit user approval: web `ApprovalPanel` on `/actions` (per-email checkboxes + review dialog, `/api/approvals*` routes) or CLI (`run-action` prompt, `approvals` command). Rejected/applied rows are kept as an audit trail. Manual per-email actions the user clicks in the mail UI stay immediate — the click is the approval. **User action files are never executed**: `loadUserAction()` and `ActionRegistry`'s `ACTIONS_DIR` pass read each `*.action.ts` and statically evaluate it with `extractActionData()` (`actions/action-source-guard.ts`), which returns the action object without the file entering the module graph. Built-ins stay real `import()`s — they are in-repo and reviewed. This is what makes the save-time guard unnecessary *for safety*: a file that was hand-dropped, or written before the guard existed, cannot run either. Behaviour change to know about: a hand-**written** action that computes anything (concatenation, a value import, a function call) no longer loads at all, and is refused loudly with its violations in a `console.warn` — such a file could never have been saved through the app, so the only people affected are power users hand-authoring executable actions, which the threat model does not want. The mutating surface is **barrel-private**: `applyOperations`, the raw Gmail write ops, and the client factories (`createGmailClient`/`createGmailClientForAccount` — every write op is a one-line wrapper over them) are not exported from any public barrel, and the `exports` map exposes no subpath to `gmail/operations` or `actions/apply`, so the one-line `import { applyOperations } from "@email-agent/core"` bypass is closed (pinned by `packages/core/src/barrel-surface.test.ts`, which also checks the dist surface and pins the `exports`-map keys — keep it passing when touching barrels). Scope it honestly: this is defense in depth against a *naive* import (the realistic failure, since actions are LLM-written), not an enforcement boundary — and now that `ACTIONS_DIR` files do not execute, it is no longer load-bearing for user actions at all. What has NOT changed: any other local code runs in-process with full Node privileges, so a hostile *program* on this machine never needs core — it can read the stored OAuth tokens at `~/.email-agent/accounts/{email}/token.json` and call the Gmail REST API directly. The improvement is narrow and worth stating precisely: a file sitting in `ACTIONS_DIR` is no longer such a program. Even staying inside core, `new URL("./gmail/operations.js", import.meta.resolve("@email-agent/core"))` is built entirely from public specifiers and returns every raw mutator — the `exports` map blocks the subpath-key form, not the resolve-root-then-relative-URL form. Note also that from the real `ACTIONS_DIR` (`~/.email-agent/actions`) NO bare specifier resolves at all, not even `googleapis`; the barrel privacy therefore bites in workspace-resolvable contexts (web bundling, any future in-tree action loading), and makes a by-name mutation import fail loudly everywhere. Both skill docs prohibit actions from importing anything but `type { EmailAction }`. The queue's own operational rules: the `action_results` row is written **before** its queue rows (they carry `batchId = resultId`, so the reverse order can orphan them; if the parent write fails, nothing is queued); an enqueue makes a **best-effort** skip of proposals identical to a row already **pending** (a re-proposal after a rejection or an apply is legitimate and is NOT suppressed) — it is a check-then-insert, so two concurrent runs can both read before either writes and both insert, producing duplicate rows for the same change; do not document it as a uniqueness guarantee. How bad that is depends on auto-apply: with the gate on the duplicates sit in the pending list and the user can reject one, but with `gmail.autoApplyActions` on each racing runner immediately applies its own ids, so neither is ever pending for review and **Gmail receives both calls**; `applyPendingOperationsByIds()` **claims**, applies and resolves in chunks of 10 with the claim inside the loop, so the claimed set and the in-flight set coincide: a crash or DB failure strands at most one chunk in `applying`, and every later id is still `pending` and still approvable/rejectable (claiming the whole batch up front bounded only the mutated-but-unrecorded set). **That bound is PER CALL, not per batch** — nothing serializes two concurrent applies over one batch, and they leapfrog (A claims ids 1-10 and calls Gmail; B loses those, continues, and claims 11-20 while A is in flight), so a crash strands one chunk per in-flight caller; never restate it as a per-batch guarantee; rows a crash left in `applying` can be listed by `getStaleApplyingOperations()` (age measured from `claimedAt`) rather than retried, because only the user can say whether the Gmail change landed; and `prunePendingOperations()` deletes `applied`/`rejected` rows past `retention.approvalQueueDays` (default 365, non-positive disables) after every apply/reject — never `pending`, `applying` or `failed`. `ActionRunResult` distinguishes `queueError` (strictly pre-Gmail: nothing was applied) from `applyError` (auto-apply threw after the rows were claimed, so Gmail **may** already have been mutated) and `persistError`; never report the second as the first.
- **What the approval queue does NOT yet do, stated plainly.** `getStaleApplyingOperations()` has **no caller** — rows a crash stranded in `applying` are invisible on every surface. `applyError`/`persistError`/`duplicateOperations` are populated but **no surface reads them**: the web result type omits them. Be precise about what each surface does instead, because "both print the `queueError` copy" is NOT what happens — on an auto-apply failure `queueError` is unset, the rows queued fine. `packages/web/src/app/actions/page.tsx` falls through to its success branch and reports "N changes await your approval" for rows that are now `applying`, not `pending`; `packages/cli/src/commands/run-action.ts` prompts on whatever is still `status: "pending"` for the batch, so it prints "nothing was applied" only when nothing is left pending (the single-chunk abort) — a multi-chunk abort leaves later ids pending and it cheerfully offers to apply those, never mentioning the chunk that may already have hit Gmail. Different routes, same wrong outcome: neither surface tells the user that mail may really have been trashed. The core fields and the wording helpers (`describeAutoApplyFailure`, `describeUnrecordedBatchFailure`) exist; the user-visible behaviour is unchanged until the adoption pass lands. See TODOS.md — do not describe these as fixed.
- **Auto-apply opt-in** (`gmail.autoApplyActions` + `gmail.autoApplyAcknowledged`): bypasses the approval prompt by applying the queued batch immediately after a run. Both flags are required — `normalizeSettings()` (core) and `normalizeGmailConfig()` (web validation) force `autoApplyActions` to false unless `autoApplyAcknowledged` is true, so no path (web PUT, `config set`, hand-edited settings.json) can enable unattended Gmail writes without the acknowledgement alongside them. `config set` refuses both keys outright, so the CLI cannot arm it at all; the web Settings → Gmail card is the only surface that shows the risk cautions before recording the acknowledgement (a direct PUT or a hand-edited settings.json setting both booleans is still honoured — the invariant is consent-recorded, not UI-only). The Actions page shows a persistent warning banner while it is on. Queueing still happens first, so the audit trail is identical. `loadSettings()` re-READS `SETTINGS_PATH` on every call and keys its cache on a sha256 of the bytes (never mtime+size, which is not file identity), so turning the toggle off takes effect in a running `serve` without a restart. It also fails CLOSED: only ENOENT means "no settings file, use defaults"; every other errno and an unparsable file throw, because falling back to defaults would silently re-arm the 365-day retention sweep over an explicit `approvalQueueDays: 0`.
- **Coding agent skills**: Two skill docs drive runtime action creation via `POST /api/actions/generate`:
  - `CREATE_ACTION_SKILLS.md` (CREATE skill) — system prompt teaching the AI to generate new `.action.ts` files from scratch (template, interface, examples)
  - `EDIT_ACTION_SKILLS.md` (EDIT skill) — system prompt for modifying existing actions; current action code is appended to the prompt
  - Route: `packages/web/src/app/api/actions/generate/route.ts` — loads skill doc based on `mode: "create" | "edit"`, passes it as `systemPrompt` to `AgentRouter`
  - UI: `packages/web/src/components/actions/action-chat-card.tsx` + `store/action-chat-store.ts` — chat interface for create/edit conversations
  - Saved actions go to `~/.email-agent/actions/<id>.action.ts` via `POST /api/actions/user`, gated by `assertSafeActionSource()` (`actions/action-source-guard.ts`). It is an **allowlist over the TypeScript AST**, not a denylist over text: a file may contain only type-only imports/exports, type declarations, variable statements whose initializers are static data, and `export default`. Anything with a call, member access, `new`, function, tagged/interpolated template, spread, computed key or getter is refused, so nothing can execute at import time however it is spelled. Identifiers resolve against names the file itself bound to data earlier, which allows `const PROMPT = "..."` but refuses `process`. The route answers 422 with the violated rules so the chat can show the model what to change. **Do not "improve" this back into a regex/text scan** — that version shipped briefly and was defeated in one line by `({}).constructor.constructor("return process")()` and by `export { default as type } from "data:..."`; both are regression tests now. Also refused: an ambient `declare` (binds nothing, so the name leaks the real global), `using` (its disposal hook is a call the file never spells), and `__proto__` as an object-literal key (sets a prototype rather than binding a property) — the recurring lesson is to ask "does this syntax BIND what it appears to bind at runtime?", not "is this syntax inert?". The same traversal is the load-time extractor: `extractActionData()` returns the values it proves are literal, and `findActionSourceViolations()` is literally that with the values discarded — deliberately one code path, because a second allowlist would drift and the drift would be a bypass. So a hand-dropped file is inspected too; it is parsed instead of imported, and refused with its violations. **Not executing the file is only half the contract**; the value it returns must be the value Node would have produced, or the evaluator is describing a different module than the one on disk. So: a named export is read as a LIVE binding at the end of the walk (`export var action = {…}; var action = null` yields nothing, as `mod.action === null` does) while `export default` snapshots its operand where it stands; `mod.default ?? mod.action` coalesces on the VALUE, so `export default null` still falls back to a named `action`; and files the runtime would reject with `SyntaxError` are refused rather than evaluated, because `parseDiagnostics` is a syntax pass only and misses the strict-mode early errors — `reserved-binding` (`eval`, `arguments`, `await` and the nine strict-mode reserved words), `duplicate-declaration`, `duplicate-export`. Where semantics cannot be matched, the rule is to refuse, never to guess. One deliberate tightening over the old loaders: `id`/`name`/`prompt` must be non-empty **strings**, not merely truthy — and a file that fails that is reported through `extractActionData`'s `onDiagnostic` (both loaders pass `console.warn`), because nothing on this path may fail silently. `restoreSnapshot()` re-validates, so a pre-guard snapshot containing a value import will refuse to restore
- **DB**: LanceDB vector database with Apache Arrow schemas

## Key Files

- `packages/core/src/gmail/account-manager.ts` — OAuth2 flow, token storage, account CRUD
- `packages/core/src/config/types.ts` — `AccountConfig`, `OAuthConfig`, `AppConfig`
- `CREATE_ACTION_SKILLS.md` — CREATE skill doc (system prompt for generating new actions)
- `EDIT_ACTION_SKILLS.md` — EDIT skill doc (system prompt for modifying existing actions)
- `packages/core/src/agents/router.ts` — Agent selection logic
- `packages/core/src/actions/runner.ts` — Action execution pipeline
- `packages/web/src/app/api/actions/generate/route.ts` — Coding agent endpoint (loads skill docs, routes to AgentRouter)
- `packages/core/src/db/connection.ts` — LanceDB init: Arrow schemas, per-table migration sentinels, and `migrateSchema()`
- `packages/core/src/config/defaults.ts` — All default config values and prompt templates
- `packages/core/src/gmail/sync.ts` — Shared fetch→embed→store pipeline (used by CLI + web)
- `packages/core/src/gmail/operations.ts` — Gmail write operations (trash, spam, labels, read/unread)
- `packages/core/src/actions/apply.ts` — Maps action results → Gmail operations, applies them
- `packages/core/src/actions/approval.ts` — Approval queue: enqueue (with dedupe), chunked apply/reject by queue row id, retention sweep
- `packages/core/src/db/pending-operations.ts` — LanceDB helpers for the `pending_operations` table (claim, resolve, prune, stale-`applying` recovery)
- `packages/core/src/db/migrations.ts` — In-place column migrations (`missingColumns` probe + `ensureTableColumns`, which calls LanceDB `addColumns`); no table is ever dropped
- `packages/web/src/components/actions/approval-panel.tsx` — Approval UI (checkboxes, review dialog)
- `packages/web/src/app/api/` — All Next.js API routes
- `packages/core/src/actions/built-in/` — Built-in actions
- `~/.email-agent/actions/` — User-created actions (auto-discovered)
- `~/.email-agent/settings.json` — Runtime config (generated by `setup.sh`)
- `setup.sh` — Interactive setup wizard (embedding provider, agent mode, GCP project, OAuth credentials)

## Gotchas

### Build & TypeScript
- After renaming packages, clean-rebuild core: `rm -rf packages/core/dist packages/core/tsconfig.tsbuildinfo && npx tsc -p packages/core/tsconfig.json` — stale incremental cache can produce `.d.ts.map` without `.d.ts`
- Core uses `composite: true`; CLI uses `references: [{ path: "../core" }]` — core MUST build before CLI type-checks
- Web tsconfig needs `lib: ["ES2022", "DOM", "DOM.Iterable"]` (base tsconfig only has ES2022)

### Imports & Modules
- Web resolves `@email-agent/core/*` subpaths via tsconfig `paths` to source files. One deliberate deep path exists: `@email-agent/core/gmail/operations` (manual mail actions in `api/gmail/[id]/route.ts`, enforced as the sole consumer by `check-module-boundaries.mjs`) — webpack-only; Node's `exports` map refuses it at runtime, so the write ops stay unreachable by name from outside the web bundle. That is no longer what keeps them out of reach of *user actions* — those files never execute at all now — but it still makes an in-tree or future by-name import fail loudly. Do not add it to the `exports` map or re-export write ops from a barrel. Its tsconfig entry must stay ABOVE the `@email-agent/core/*` wildcard: a resolver that matched the wildcard first would map it to `gmail/operations/index.ts`, which does not exist
- CLI imports from `@email-agent/core` barrel export only (no subpath imports) due to rootDir constraint
- `AccountConfig` is in `config/types.ts` (not `gmail/account-types.ts`) — `account-types.ts` only has `OAuthCredentials` and `StoredTokens`
- `actions/built-in/index.ts` is a static barrel for webpack — new built-in actions must be added here too

### Database
- LanceDB `createEmptyTable()` requires Apache Arrow `Schema`/`Field` objects, NOT plain JS objects
- DB record interfaces need `[key: string]: unknown` index signatures for `table.add()`
- **LanceDB HAS schema evolution. Never drop and recreate a table to add a column.** `@lancedb/lancedb` **0.15.0** exposes `Table.addColumns([{ name, valueSql }])`, `alterColumns` and `dropColumns`. Verified 2026-08-07 against the installed native binary (`lance` 0.22.0) on a real table, not from docs: `addColumns` adds the column **in place**, every row survives with its values, and the column is immediately `update()`-able and `where()`-filterable (backticked). The resulting Arrow type is exactly what the CAST names — `CAST('' AS STRING)` → Utf8, `CAST(0 AS INT)` → Int32, `CAST(false AS BOOLEAN)` → Bool — each with the same nullability a fresh `createEmptyTable` of that schema produces. Two caveats: columns are APPENDED, so a migrated table's column order differs from a fresh one (nothing resolves columns positionally, but do not assert order equality); and a `FixedSizeList` vector column cannot be produced this way. **These are facts about a version** — re-verify every one of them if you upgrade `@lancedb/lancedb`
- Adding a column to any table: add the field to that table's Arrow schema in `db/connection.ts` and an SQL sentinel to its `*ColumnDefaults` map. `migrateSchema()` probes with `missingColumns()` and calls `ensureTableColumns()` (`db/migrations.ts`), which adds it in place. The sentinel must produce EXACTLY what a fresh insert writes, so a migrated row is indistinguishable from one written today — for `pending_operations` that means a queued row comes back queued and unclaimed, never silently approved. A missing column with no declared sentinel THROWS rather than being filled with NULL
- **Do not re-introduce read → drop → create → re-insert.** It was adopted from a comment asserting "LanceDB has no ALTER TABLE" that was simply false for the installed version, and it destroys every row if the process dies after the drop — silently, because the retry then sees a fresh current-schema table and concludes there was nothing to migrate. The 953-line durable-snapshot + cross-process-lock + replay-merge subsystem that existed only to survive that drop has been deleted; do not rebuild it. Nothing is dropped now, so there is nothing for a crash to destroy
- All four tables use the one path, `emails` included. `emails` rows are re-fetchable from Gmail, but each carries an embedding that costs a paid API call to rebuild and `""` is already the documented legacy account sentinel, so in-place is both cheaper and leaves zero drop-and-recreate migrations in the tree
- Migrations need no lock. `initDb()`'s `initPromise` is module-local and does not serialize a `serve` against a CLI run — and does not need to: `addColumns` and `createEmptyTable` are single MVCC commits, the loser of a race fails loudly ("Column already exists" / "Table already exists"), and `ensureTableColumns` re-probes the table's current schema before accepting the winner's commit rather than assuming a failure means somebody else did it. Observed over five forked two-process runs: one commit lands, one fails, zero rows lost in every interleaving. There is no longer a drop window for a concurrent queue write to fall into
- The `pending_operations` migration is covered end-to-end in `db/schema-migration.test.ts`: real temp-directory LanceDB, tables seeded in the OLD shape, rows in `applied`/`rejected`/`failed`/`applying`/`pending`, both halves of a concurrent-init race, and a refusal that leaves the rows intact
- The only delete path on `pending_operations` is `prunePendingOperations()`; `PRUNABLE_STATUSES` is `applied`/`rejected` only. `failed` is kept deliberately (it is the diagnostic record of an attempted mutation), `pending`/`applying` are unresolved
- `emails` table has `accountId` column — must be included in all insert records
- All `.where()` string interpolation must use `escapeSql()` from `db/utils.ts` — LanceDB has no parameterized queries
- LanceDB's DataFusion SQL parser folds unquoted identifiers to lowercase — wrap camelCase columns in backticks (e.g. `` `actionId` = '...' ``) or queries fail with `No field named actionid`. See `emails.ts` for the convention
- **Never chain `.where()`** — LanceDB's `where()` maps to `onlyIf`, which REPLACES the previous predicate instead of ANDing it, so `query().where(A).where(B)` silently matches B only (verified against `@lancedb/lancedb` 0.15.0). Always join with `" AND "` into one string. `buildEmailFilters()` / `buildPendingOperationFilters()` return arrays for exactly this join; `countEmails` passes the same combined string to `table.countRows(filter)`

### Config
- `loadSettings()` re-reads the file on every call and keys its cache on a sha256 of the bytes read. Do NOT restore an unconditional cache, and do NOT key it on `mtime + size`: that is not file identity (`git checkout`, a restore from backup and `rsync --times` all reproduce a timestamp, and two settings differing only in a boolean are the same length), and `gmail.autoApplyActions` is the kill switch for unattended Gmail mutation — a stale copy keeps auto-applying after the user turns it off
- `loadSettings()` fails CLOSED on a settings file it cannot use. ENOENT alone means "absent, first run, defaults are right"; every other errno and an unparsable file THROW. Absence of information must never read as permission to destroy data: the defaults set `retention.approvalQueueDays` to 365 while the explicit opt-out is 0, and the post-approval sweep in `actions/approval.ts` reads it, so a momentarily unreadable file used to delete audit rows the user had explicitly opted out of pruning
- Next.js does **not** guarantee one module instance per process. Verified from a production build: every route entry requires the single shared `webpack-runtime.js` (one module registry), but webpack does not always place a module in a shared chunk — `app/api/auth/callback/route.js` carries its own inlined copy of `config/defaults.ts` + `config/settings.ts` (distinctive literals appear in `chunks/982.js`, `chunks/170.js` **and** that route entry). So a process-global invalidation hook like `clearSettingsCache()` only clears the caller's own copy; the per-call re-read is what makes every instance converge, and it is load-bearing rather than belt-and-braces
- A new top-level settings section survives a web settings PUT (`mergeSettingsUpdate` spreads `...current` first), but it is invisible to the settings UI until `sanitizeSettingsForResponse` lists it. A new key inside `gmail.*` does NOT survive: `normalizeGmailConfig()` rebuilds that section from the two auto-apply booleans alone

### Web (Next.js)
- `next.config.ts` has webpack `extensionAlias` (`.js` → `.ts/.tsx/.js`) — required because core uses `.js` extensions but web resolves to `.ts` source via tsconfig `paths`
- Dynamic filesystem patterns (`readdir`, `import.meta.url` dirs) in core don't work in webpack — use static imports in web routes (e.g. `ActionRegistry.loadStatic()`)
- The `new Function("p", "return import(p)")` escape hatch (webpack can't statically trace it, so Node's native loader handles the call) is **gone, and must not come back for user actions**: `loadUserAction()` now parses `~/.email-agent/actions/*.action.ts` as data instead of importing it, so there is nothing to bundle-bust. No other consumer uses the hatch. If you ever need a genuine runtime `import()` of a file outside the bundle, the hatch is still the technique — but it is not the answer for anything in `ACTIONS_DIR`, and `action-source-guard.test.ts` fails if it reappears in `user-actions.ts` or if `registry.ts` imports anything outside its built-in directory
- State-changing API routes reject non-local or cross-site browser requests unless `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`; keep this guard aligned with `packages/web/src/modules/api/validation.ts`
- `packages/web/package-lock.json` is a **symlink** to `../../package-lock.json` — do NOT delete it. Next.js uses it to detect npm as the package manager; without it, it falls back to globally-installed pnpm and fails with `ENOWORKSPACES`
- `packages/web/next.config.ts` has `outputFileTracingRoot` set to monorepo root — prevents Next.js from walking up to stray lockfiles in parent directories
- `fetch().json()` needs explicit return type annotations with strict TS + TanStack Query generics
- `Button` component is a plain `forwardRef`, NOT Radix Slot-based — does NOT support `asChild`. To style a `<Link>` as a button, use `buttonVariants()` from `@/components/ui/button` on the Link's `className`
- `fetcher.ts` paginates Gmail `messages.list` via `nextPageToken` loop, capped at `maxResults` (default 500) — breaks early and trims to exact limit
- New TanStack Query keys must be invalidated in ALL relevant mutation `onSuccess` callbacks — check `use-fetch-emails.ts`, `mail-display.tsx`, `use-actions.ts`

### CLI
- CLI `dev` script uses `tsc --watch` (not `tsx src/index.ts`) because Commander.js CLIs exit immediately without args, which turbo's `persistent: true` treats as failure
- Use `execFileSync`/`execFile` (NOT `execSync`/`exec`) in CLI commands — security hook blocks shell injection patterns

### Other
- `setup.sh` hardcodes a `settings.json` template — new config fields must be added there too, or they won't appear for fresh installs running setup
- `setup.sh` also writes `~/.email-agent/oauth.json` (step 9) — the JSON format must match what `account-manager.ts` reads (`{clientId, clientSecret}`)
- `createGmailClient` throws for a named account (`accountEmail` set to a non-empty string) with missing/invalid stored credentials — it does NOT fall back to gcloud ADC. ADC fallback only applies to the explicit empty-string account id and to the unscoped/no-accounts-configured path (see `gmail/client.ts`)

### Agent Executors (Spawning CLIs)
- Claude CLI: `--system-prompt` (NOT `--system`), `--output-format stream-json` for streaming, NO `--max-tokens` flag (use `--max-budget-usd` instead)
- **Large `--system-prompt` args hang the CLI** — combine system prompt into the user prompt instead (see `claude-executor.ts`)
- **Use `spawn` not `execFile`** for Claude CLI — `execFile` can get killed (exit 143/SIGTERM) by Node.js for long-running processes
- When spawning `claude` CLI from a process inside Claude Code, strip `CLAUDECODE` env var or it refuses as "nested session" — use `cleanEnv()` in `claude-executor.ts`
- **`tokensUsed` means one thing everywhere**: total tokens processed = all input (cached counted at full weight) + all output. `agents/tokens.ts` owns that definition and the per-provider normalizers — call one, never hand-roll the arithmetic. The maths differ because providers disagree on the same field name: Anthropic's `input_tokens` is the *uncached remainder*, so `cache_creation_input_tokens`/`cache_read_input_tokens` are **additive**; codex's `cached_input_tokens` is a **subset** of `input_tokens` and must NOT be added (verified live — adding ~4k tokens of filler moved codex `input_tokens` 21,403→25,412, tracking the prompt 1:1). `0` means "not reported", not "free"
- **Codex bills ~21k tokens for a one-word reply** — real, not a bug: it ships its own system prompt, tool definitions and skill descriptions on every request. Don't "fix" it by discarding the number
- **CLI stdout parsing goes in an exported pure function** (`parseClaudeCliOutput`, `parseCodexOutput`, `parseGeminiOutput`) so it can be unit-tested without spawning anything — some of these CLIs can't run in CI at all (gemini requires interactive browser OAuth)
- **Gemini `--output-format json` has no `stats.totalTokenCount`** — the real path is `stats.models[<model>].tokens.total` (snake_case; `stats` is the raw `uiTelemetryService.getMetrics()` object). A failed run comes back as an `error` object with **no** `response` field, so treat that as an error rather than empty text
- **The API executors take an injectable `baseURL`/`apiKey`/`model`** (defaults unchanged). That seam exists so `api-executors.test.ts` can drive them against a local `node:http` stub — don't remove it; it is the only coverage those paths have without spending money
- Core module changes (via tsconfig `paths`) may not hot-reload in Next.js — restart `npm run dev` after modifying `packages/core/` source

## Code Style

- ESM throughout (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript with `noUncheckedIndexedAccess`
- No default exports except action plugin files (`*.action.ts`)
