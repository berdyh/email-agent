# Email Agent

Local AI-powered email analysis tool. Monorepo with Turbo.

> **Worktree:** This directory (`main/`) is a git worktree. The bare repo is at `../.bare/`. See global AGENTS.md for git worktree SOPs.

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
npx email-agent serve              # Start web UI
npx email-agent cron setup         # Install crontab for periodic fetching (--interval, --scope)
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
- **Email identity**: Treat Gmail message ids as account-scoped. DB upserts, read-state updates, detail routes, Gmail write operations, and selected-mail UI state must carry `accountId` with `id`; empty `accountId` is the legacy/gcloud ADC account sentinel and is valid when explicitly present.
- **Unread sync reconciliation**: Complete unread-scoped syncs should mark same-account local unread rows as read when Gmail no longer returns them; do not use whole-table overwrite to clear stale unread rows.
- **Agent system**: Strategy pattern executors (Codex SDK/CLI + Codex/Gemini CLI + DirectAPI + OpenRouter) with AgentRouter; supports streaming via `executeStream()`
- **Action system**: Plugin architecture — `*.action.ts` files auto-discovered from built-in + user dirs
- **Approval gate**: Action runs never mutate Gmail directly. `ActionRunner` maps results to Gmail operations and always enqueues them in the LanceDB `pending_operations` table first (`actions/approval.ts`, batchId = action_results row id). Mutations then happen via `applyPendingOperationsByIds()` after explicit user approval: the web `ApprovalPanel` on `/actions` (`/api/approvals*`) or the CLI (`run-action` prompt, `approvals` command). Resolved rows stay as an audit trail. Manual per-email clicks in the mail UI stay immediate — the click is the approval. The queue's own operational rules: the `action_results` row is written **before** its queue rows (they carry `batchId = resultId`, so the reverse order can orphan them; if the parent write fails, nothing is queued); an enqueue makes a **best-effort** skip of proposals identical to a row already **pending** (a re-proposal after a rejection or an apply is legitimate and is NOT suppressed) — it is a check-then-insert, so two concurrent runs can both read before either writes and both insert, producing visible duplicate pending rows that can both be applied; do not document it as a uniqueness guarantee; `applyPendingOperationsByIds()` **claims**, applies and resolves in chunks of 10 — the claim is inside the loop, so the claimed set and the in-flight set coincide and a crash or DB failure strands at most one chunk in `applying` while every later id is still `pending` and still approvable/rejectable (claiming the whole batch up front bounded only the mutated-but-unrecorded set, not the stranded one). Each chunk gets its own claim token; rows a crash left in `applying` are reported by `getStaleApplyingOperations()` (age measured from `claimedAt`) rather than retried, because only the user can say whether the Gmail change landed; and `prunePendingOperations()` deletes `applied`/`rejected` rows past `retention.approvalQueueDays` (default 365, non-positive disables) after every apply/reject — never `pending`, `applying` or `failed`. `ActionRunResult` distinguishes `queueError` (strictly pre-Gmail: nothing was applied) from `applyError` (auto-apply threw after the rows were claimed, so Gmail **may** already have been mutated) and `persistError`; never report the second as the first.
- **Auto-apply opt-in** (`gmail.autoApplyActions` + `gmail.autoApplyAcknowledged`): applies the queued batch immediately instead of waiting for approval. Both flags are required — `normalizeSettings()` (core) and `normalizeGmailConfig()` (web validation) force the toggle off unless the acknowledgement is set, and CLI `config set` refuses both keys outright. Settings → Gmail is the only surface that shows the warnings before recording the acknowledgement; a direct PUT or a hand-edited settings.json setting both booleans is still honoured, so the invariant is "consent recorded", not "web UI only".
- **Coding agent skills**: Two skill docs drive runtime action creation via `POST /api/actions/generate`:
  - `CREATE_ACTION_SKILLS.md` (CREATE skill) — system prompt teaching the AI to generate new `.action.ts` files from scratch (template, interface, examples)
  - `EDIT_ACTION_SKILLS.md` (EDIT skill) — system prompt for modifying existing actions; current action code is appended to the prompt
  - Route: `packages/web/src/app/api/actions/generate/route.ts` — loads skill doc based on `mode: "create" | "edit"`, passes it as `systemPrompt` to `AgentRouter`
  - UI: `packages/web/src/components/actions/action-chat-card.tsx` + `store/action-chat-store.ts` — chat interface for create/edit conversations
  - Saved actions go to `~/.email-agent/actions/<id>.action.ts` via `POST /api/actions/user`
- **DB**: LanceDB vector database with Apache Arrow schemas
- **Embeddings**: OpenAI/OpenRouter embeddings and local deterministic lexical vectors all use the fixed LanceDB vector dimension; sync falls back to local vectors instead of storing empty vectors.

## Key Files

- `packages/core/src/gmail/account-manager.ts` — OAuth2 flow, token storage, account CRUD
- `packages/core/src/config/types.ts` — `AccountConfig`, `OAuthConfig`, `AppConfig`
- `CREATE_ACTION_SKILLS.md` — CREATE skill doc (system prompt for generating new actions)
- `EDIT_ACTION_SKILLS.md` — EDIT skill doc (system prompt for modifying existing actions)
- `packages/core/src/agents/router.ts` — Agent selection logic
- `packages/core/src/actions/runner.ts` — Action execution pipeline
- `packages/web/src/app/api/actions/generate/route.ts` — Coding agent endpoint (loads skill docs, routes to AgentRouter)
- `packages/core/src/db/connection.ts` — LanceDB init with Arrow schemas
- `packages/core/src/config/defaults.ts` — All default config values and prompt templates
- `packages/core/src/gmail/sync.ts` — Shared fetch→embed→store pipeline (used by CLI + web)
- `packages/core/src/gmail/operations.ts` — Gmail write operations (trash, spam, labels, read/unread)
- `packages/core/src/actions/apply.ts` — Maps action results → Gmail operations, applies them
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
- Web resolves `@email-agent/core/*` subpaths via tsconfig `paths` to source files
- CLI imports from `@email-agent/core` barrel export only (no subpath imports) due to rootDir constraint
- `AccountConfig` is in `config/types.ts` (not `gmail/account-types.ts`) — `account-types.ts` only has `OAuthCredentials` and `StoredTokens`
- `actions/built-in/index.ts` is a static barrel for webpack — new built-in actions must be added here too

### Database
- LanceDB `createEmptyTable()` requires Apache Arrow `Schema`/`Field` objects, NOT plain JS objects
- DB record interfaces need `[key: string]: unknown` index signatures for `table.add()`
- Adding columns to existing tables: check schema in `initDb()`, drop+recreate if column missing (LanceDB has no ALTER TABLE)
- Adding a column to `pending_operations`: change `pendingOperationSchema` in `db/pending-operations-migration.ts` and add a default to `pendingOperationMigrationDefaults`. That module owns the whole sequence — probe, **durable pre-drop snapshot**, drop, recreate, re-insert, verify the row count, and only then delete the snapshot. Do NOT re-implement read/drop/create/add inline: the drop/recreate has no atomicity of its own, so a crash or a failing `add()` after the drop destroys every row AND a retry then sees a fresh current-schema table and skips recovery, making the loss silent and permanent. A leftover snapshot in `~/.email-agent/data/migrations/` is proof of an interrupted migration and is replayed on the next start, merged by `id` with whatever the table currently holds (on-disk rows win). An unreadable snapshot aborts init rather than being treated as "no interruption"
- The `pending_operations` migration takes a cross-process `mkdir` lock (`db/migration-lock.ts`) — `initDb()`'s `initPromise` is module-local and does not serialize a `serve` against a CLI run. Scope, precisely: the lock serializes *migrations* against each other; ordinary enqueue/claim/resolve calls do NOT take it, so a process already past `initDb()` can still write into the drop window and lose that write. The snapshot bounds the damage, it does not eliminate it (tracked in TODOS.md)
- `emails` and `action_results` migrations still have neither a snapshot nor the lock. `emails` is re-fetchable; `action_results` is **not** — tracked in TODOS.md
- The only delete path on `pending_operations` is `prunePendingOperations()`; `PRUNABLE_STATUSES` is `applied`/`rejected` only. `failed` is kept deliberately (it is the diagnostic record of an attempted mutation), `pending`/`applying` are unresolved
- `emails` table has `accountId` column — must be included in all insert records
- All `.where()` string interpolation must use `escapeSql()` from `db/utils.ts` — LanceDB has no parameterized queries
- LanceDB's DataFusion SQL parser folds unquoted identifiers to lowercase — wrap camelCase columns in backticks (e.g. `` `actionId` = '...' ``) or queries fail with `No field named actionid`. See `emails.ts` for the convention
- `countEmails` uses `table.countRows(filter)` (single combined string) vs `getEmails` which chains `.where()` — `buildEmailFilters()` in `emails.ts` bridges both patterns
- Do not use LanceDB table overwrite for updates; use `mergeInsert` for keyed rows or scoped delete/update plus append so unrelated records are preserved. Email rows must merge on both `accountId` and `id`.

### Config
- `loadSettings()` **reads `settings.json` on every call** and caches only the parse, keyed on a sha256 of the bytes it just read. Do NOT restore an unconditional cache, and do NOT re-key it on file metadata: `gmail.autoApplyActions` is the kill switch for unattended Gmail mutation, and a stale copy keeps auto-applying after the user turns it off. `mtimeMs + size` was tried and is **not** file identity — `git checkout`, a restore from backup, `rsync --times` and timestamp-preserving editors all reproduce the mtime, and two settings files differing only in a boolean are easily the same byte length. That combination was reproduced against a built `dist`: the kill switch reported ON while the file on disk said OFF, with no bound on how long. Hashing the bytes also closes the TOCTOU the `stat()`-then-`readFile` order had, because the bytes validated are the bytes parsed
- Next.js does **not** guarantee one module instance per process. Verified from a production build: every route entry requires the single shared `webpack-runtime.js` (one module registry), but webpack does not always place a module in a shared chunk — `app/api/auth/callback/route.js` carries its own inlined copy of `config/defaults.ts` + `config/settings.ts` (distinctive literals appear in `chunks/982.js`, `chunks/170.js` **and** that route entry). So a process-global invalidation hook like `clearSettingsCache()` only clears the caller's own copy; the per-call re-read is what makes every instance converge, and it is load-bearing rather than belt-and-braces
- A new top-level settings section survives a web settings PUT (`mergeSettingsUpdate` spreads `...current` first), but it is invisible to the settings UI until `sanitizeSettingsForResponse` lists it. A new key inside `gmail.*` does NOT survive: `normalizeGmailConfig()` rebuilds that section from the two auto-apply booleans alone

### Web (Next.js)
- `next.config.ts` has webpack `extensionAlias` (`.js` → `.ts/.tsx/.js`) — required because core uses `.js` extensions but web resolves to `.ts` source via tsconfig `paths`
- Dynamic filesystem patterns (`readdir`, `import.meta.url` dirs) in core don't work in webpack — use static imports in web routes (e.g. `ActionRegistry.loadStatic()`)
- For runtime `import()` of files outside the bundle (e.g. user plugins in `~/.email-agent/actions/`), use the `new Function("p", "return import(p)")` escape hatch — webpack can't statically trace it, so Node's native loader handles the call. See `loadUserAction()` in `actions/user-actions.ts`. Without this, the import silently fails inside webpack and the route returns 404
- State-changing API routes reject non-local or cross-site browser requests unless `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`; keep this guard aligned with `packages/web/src/modules/api/validation.ts`
- Settings updates are partial deep merges. Preserve omitted nested settings, normalize legacy nullable values such as `notifications.webhooks: null`, and keep stale UI-only fields like `panelWidths` out of persisted responses.
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
- `node-notifier` types are strict — only `title`, `message`, `wait` are valid notification props
- `setup.sh` hardcodes a `settings.json` template — new config fields must be added there too, or they won't appear for fresh installs running setup
- `setup.sh` also writes `~/.email-agent/oauth.json` (step 9) — the JSON format must match what `account-manager.ts` reads (`{clientId, clientSecret}`)

### Agent Executors (Spawning CLIs)
- Codex CLI: `--system-prompt` (NOT `--system`), `--output-format stream-json` for streaming, NO `--max-tokens` flag (use `--max-budget-usd` instead)
- **Large `--system-prompt` args hang the CLI** — combine system prompt into the user prompt instead (see `Codex-executor.ts`)
- **Use `spawn` not `execFile`** for Codex CLI — `execFile` can get killed (exit 143/SIGTERM) by Node.js for long-running processes
- When spawning `Codex` CLI from a process inside Codex, strip `Codex` env var or it refuses as "nested session" — use `cleanEnv()` in `Codex-executor.ts`
- Core module changes (via tsconfig `paths`) may not hot-reload in Next.js — restart `npm run dev` after modifying `packages/core/` source

## Code Style

- ESM throughout (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript with `noUncheckedIndexedAccess`
- No default exports except action plugin files (`*.action.ts`)
