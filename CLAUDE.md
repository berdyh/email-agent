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
- **Action system**: Plugin architecture — `*.action.ts` files auto-discovered from built-in + user dirs
- **Approval gate**: Action runs never mutate Gmail directly. `ActionRunner` maps results to Gmail operations and always enqueues them in the LanceDB `pending_operations` table first (`actions/approval.ts`, batchId = action_results row id), so every proposed change is recorded before anything touches Gmail. Mutations then happen via `applyPendingOperationsByIds()` after explicit user approval: web `ApprovalPanel` on `/actions` (per-email checkboxes + review dialog, `/api/approvals*` routes) or CLI (`run-action` prompt, `approvals` command). Rejected/applied rows are kept as an audit trail. Manual per-email actions the user clicks in the mail UI stay immediate — the click is the approval. The mutating surface is **barrel-private**: `applyOperations`, the raw Gmail write ops, and the client factories (`createGmailClient`/`createGmailClientForAccount` — every write op is a one-line wrapper over them) are not exported from any public barrel, and the `exports` map exposes no subpath to `gmail/operations` or `actions/apply`, so the one-line `import { applyOperations } from "@email-agent/core"` bypass is closed (pinned by `packages/core/src/barrel-surface.test.ts`, which also checks the dist surface and pins the `exports`-map keys — keep it passing when touching barrels). Scope it honestly: this is defense in depth against a *naive* import (the realistic failure, since actions are LLM-written), not an enforcement boundary. A user action runs in-process with full Node privileges, so a hostile one never needs core at all: it can read the stored OAuth tokens at `~/.email-agent/accounts/{email}/token.json` and call the Gmail REST API directly. Even staying inside core, `new URL("./gmail/operations.js", import.meta.resolve("@email-agent/core"))` is built entirely from public specifiers and returns every raw mutator — the `exports` map blocks the subpath-key form, not the resolve-root-then-relative-URL form. Note also that from the real `ACTIONS_DIR` (`~/.email-agent/actions`) NO bare specifier resolves at all, not even `googleapis`; the barrel privacy therefore bites in workspace-resolvable contexts (web bundling, any future in-tree action loading), and makes a by-name mutation import fail loudly everywhere. Both skill docs prohibit actions from importing anything but `type { EmailAction }`.
- **Auto-apply opt-in** (`gmail.autoApplyActions` + `gmail.autoApplyAcknowledged`): bypasses the approval prompt by applying the queued batch immediately after a run. Both flags are required — `normalizeSettings()` (core) and `normalizeGmailConfig()` (web validation) force `autoApplyActions` to false unless `autoApplyAcknowledged` is true, so no path (web PUT, `config set`, hand-edited settings.json) can enable unattended Gmail writes without the acknowledgement alongside them. `config set` refuses both keys outright, so the CLI cannot arm it at all; the web Settings → Gmail card is the only surface that shows the risk cautions before recording the acknowledgement (a direct PUT or a hand-edited settings.json setting both booleans is still honoured — the invariant is consent-recorded, not UI-only). The Actions page shows a persistent warning banner while it is on. Queueing still happens first, so the audit trail is identical.
- **Coding agent skills**: Two skill docs drive runtime action creation via `POST /api/actions/generate`:
  - `CREATE_ACTION_SKILLS.md` (CREATE skill) — system prompt teaching the AI to generate new `.action.ts` files from scratch (template, interface, examples)
  - `EDIT_ACTION_SKILLS.md` (EDIT skill) — system prompt for modifying existing actions; current action code is appended to the prompt
  - Route: `packages/web/src/app/api/actions/generate/route.ts` — loads skill doc based on `mode: "create" | "edit"`, passes it as `systemPrompt` to `AgentRouter`
  - UI: `packages/web/src/components/actions/action-chat-card.tsx` + `store/action-chat-store.ts` — chat interface for create/edit conversations
  - Saved actions go to `~/.email-agent/actions/<id>.action.ts` via `POST /api/actions/user`
- **DB**: LanceDB vector database with Apache Arrow schemas

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
- `packages/core/src/actions/approval.ts` — Approval queue: enqueue, apply/reject by queue row id
- `packages/core/src/db/pending-operations.ts` — LanceDB helpers for the `pending_operations` table
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
- Web resolves `@email-agent/core/*` subpaths via tsconfig `paths` to source files. One deliberate deep path exists: `@email-agent/core/gmail/operations` (manual mail actions in `api/gmail/[id]/route.ts`, enforced as the sole consumer by `check-module-boundaries.mjs`) — webpack-only; Node's `exports` map refuses it at runtime, which is what keeps Gmail writes out of reach of user actions. Do not add it to the `exports` map or re-export write ops from a barrel. Its tsconfig entry must stay ABOVE the `@email-agent/core/*` wildcard: a resolver that matched the wildcard first would map it to `gmail/operations/index.ts`, which does not exist
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
- **Never chain `.where()`** — LanceDB's `where()` maps to `onlyIf`, which REPLACES the previous predicate instead of ANDing it, so `query().where(A).where(B)` silently matches B only (verified against `@lancedb/lancedb` 0.15.0). Always join with `" AND "` into one string. `buildEmailFilters()` / `buildPendingOperationFilters()` return arrays for exactly this join; `countEmails` passes the same combined string to `table.countRows(filter)`

### Web (Next.js)
- `next.config.ts` has webpack `extensionAlias` (`.js` → `.ts/.tsx/.js`) — required because core uses `.js` extensions but web resolves to `.ts` source via tsconfig `paths`
- Dynamic filesystem patterns (`readdir`, `import.meta.url` dirs) in core don't work in webpack — use static imports in web routes (e.g. `ActionRegistry.loadStatic()`)
- For runtime `import()` of files outside the bundle (e.g. user plugins in `~/.email-agent/actions/`), use the `new Function("p", "return import(p)")` escape hatch — webpack can't statically trace it, so Node's native loader handles the call. See `loadUserAction()` in `actions/user-actions.ts`. Without this, the import silently fails inside webpack and the route returns 404
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
- Core module changes (via tsconfig `paths`) may not hot-reload in Next.js — restart `npm run dev` after modifying `packages/core/` source

## Code Style

- ESM throughout (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript with `noUncheckedIndexedAccess`
- No default exports except action plugin files (`*.action.ts`)
