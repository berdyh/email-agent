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
npx email-agent actions snapshots  # List saved versions of user actions (--action <file>)
npx email-agent actions snapshots restore <snapshot>  # Restore a snapshot (--action <file>, -y)
npx email-agent approvals          # List Gmail changes queued for approval
npx email-agent approvals review   # Approve/reject each queued change interactively (--batch <id>)
npx email-agent approvals apply    # Approve and apply queued changes in bulk (--batch <id>)
npx email-agent approvals reject   # Reject queued changes without applying (--batch <id>)
npx email-agent serve              # Start web UI (--port, --host; binds loopback unless --host/EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1)
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
- **Approval gate**: Action runs never mutate Gmail directly. `ActionRunner` maps results to Gmail operations and always enqueues them in the LanceDB `pending_operations` table first (`actions/approval.ts`, batchId = action_results row id). Mutations then happen via `applyPendingOperationsByIds()` after explicit user approval: the web `ApprovalPanel` on `/actions` (`/api/approvals*`) or the CLI (`run-action` prompt, `approvals` command). Resolved rows stay as an audit trail. Both surfaces distinguish "already resolved elsewhere" from a no-op: core claims each row before touching Gmail, so `requested - (applied + failed)` is exactly the set of ids another tab/the CLI/auto-apply got to first — `POST /api/approvals/apply` reports it as `skipped` and answers 409 when nothing at all was claimed, and the CLI says so instead of "Applied 0 changes". Manual per-email clicks in the mail UI stay immediate — the click is the approval.
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
- `packages/web/src/modules/api/approvals-contract.ts` — The `/api/approvals*` wire types + stale-apply accounting, imported by BOTH the routes and `hooks/use-approvals`
- `packages/web/src/modules/api/email-lookup.ts` / `packages/cli/src/email-lookup.ts` — Batched `(accountId, id IN …)` email fetch for the approval surfaces (duplicated; core-side follow-up in TODOS)
- `packages/web/src/hooks/use-email-detail.ts` — The one email-detail query + its `["email", accountId, emailId]` key
- `packages/cli/src/commands/action-snapshots.ts` — `actions snapshots list|restore`, the only reachable recovery path for an overwritten user action
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
- `emails` table has `accountId` column — must be included in all insert records
- All `.where()` string interpolation must use `escapeSql()` from `db/utils.ts` — LanceDB has no parameterized queries
- LanceDB's DataFusion SQL parser folds unquoted identifiers to lowercase — wrap camelCase columns in backticks (e.g. `` `actionId` = '...' ``) or queries fail with `No field named actionid`. See `emails.ts` for the convention
- `countEmails` uses `table.countRows(filter)` (single combined string) vs `getEmails` which chains `.where()` — `buildEmailFilters()` in `emails.ts` bridges both patterns
- Do not use LanceDB table overwrite for updates; use `mergeInsert` for keyed rows or scoped delete/update plus append so unrelated records are preserved. Email rows must merge on both `accountId` and `id`.

### Web (Next.js)
- `next.config.ts` has webpack `extensionAlias` (`.js` → `.ts/.tsx/.js`) — required because core uses `.js` extensions but web resolves to `.ts` source via tsconfig `paths`
- Dynamic filesystem patterns (`readdir`, `import.meta.url` dirs) in core don't work in webpack — use static imports in web routes (e.g. `ActionRegistry.loadStatic()`)
- For runtime `import()` of files outside the bundle (e.g. user plugins in `~/.email-agent/actions/`), use the `new Function("p", "return import(p)")` escape hatch — webpack can't statically trace it, so Node's native loader handles the call. See `loadUserAction()` in `actions/user-actions.ts`. Without this, the import silently fails inside webpack and the route returns 404
- **Local-only enforcement is the bind, not the headers.** `mutationGuardResponse`/`readGuardResponse` (`packages/web/src/modules/api/validation.ts`) check the `Host` header **read straight off the request**, `Origin` and `Sec-Fetch-Site` — all of which a non-browser caller sets itself. **Never derive the host from `request.url`:** installed Next composes that URL from the server's own configured hostname (`attachRequestMeta` in `next/dist/server/next-server.js`; the render server defaults the hostname to `localhost`), so under both `next dev --hostname 127.0.0.1` and `next start --hostname 127.0.0.1` every request reaches the handler claiming `http://localhost:<port>` whatever `Host` arrived. The earlier version did exactly that, and it broke both ways: the browser that opened the `http://127.0.0.1:3847` URL Next itself prints got 403 on every mutation, and a DNS-rebound `Host: evil.example` was never seen at all, so the anti-rebinding property did not exist. `Origin` now has to name a local hostname on the port the caller addressed, so `localhost` and `127.0.0.1` both work while another app on `localhost:8080` does not; `X-Forwarded-Host` is deliberately ignored, since a rebound page is same-origin with itself and can set it. They buy anti-DNS-rebinding and anti-CSRF for *browsers*, plus a speed bump: mutations now require at least one of `Origin`/`Sec-Fetch-Site` to be present, so a bare `curl -X POST -H 'Host: localhost:3847'` is refused. The actual boundary is that `next dev`/`next start`/`email-agent serve` bind `127.0.0.1`, so an off-box process cannot open the socket at all. **Every** handler under `packages/web/src/app/api` carries a guard: mutations `mutationGuardResponse`, reads `readGuardResponse` (`/api/approvals`, `/api/approvals/count`, `/api/gmail`, `/api/gmail/[id]`, `/api/gmail/unread-count`, `/api/accounts`, `/api/actions`, `/api/actions/[id]/results`, `/api/actions/user`, `/api/settings`). There is exactly ONE deliberate exemption — `GET /api/auth/callback`, which Google reaches as a top-level cross-site navigation the guard would refuse, and which is protected by its one-time OAuth state cookie instead. `packages/web/src/modules/api/route-guards.test.ts` walks the route tree and fails on any unguarded handler not on that named list, so "is everything covered?" is a test result rather than a claim (`GET /api/actions/[id]/results`, which returns the model's raw text and the email ids it acted on, was missed by exactly that claim). Reads deliberately do NOT require the fetch metadata, so the address bar and local debugging still work. `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` relaxes every check *and* opens the bind to `0.0.0.0`. **Not stopped by any of this:** a process on the same machine as the same user — it reaches loopback and can read `~/.email-agent/accounts/{email}/token.json` and call Gmail directly. A shared-secret token would raise that to "same machine, same user *only*"; TODOS carries the design and why it needs an out-of-band launch URL
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
