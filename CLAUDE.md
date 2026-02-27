# Email Agent

Local AI-powered email analysis tool. Monorepo with Turbo.

> **Worktree:** This directory (`main/`) is a git worktree. The bare repo is at `../.bare/`. See global CLAUDE.md for git worktree SOPs.

## Commands

```bash
npm install              # Install all dependencies
npm run build            # Build all packages (core must build first)
npm run dev              # Start all dev servers
npm run start            # Start web UI on port 3847
npm run setup            # Interactive setup wizard (gcloud auth + DB init)
npx tsc -p packages/core/tsconfig.json --noEmit   # Type-check core
npx tsc -p packages/web/tsconfig.json --noEmit    # Type-check web
npx tsc -p packages/cli/tsconfig.json --noEmit    # Type-check CLI
```

### CLI

```bash
npx email-agent fetch              # Fetch unread emails → LanceDB
npx email-agent run-action <id>    # Run an action (priority, subscription, junk)
npx email-agent list-actions       # List available actions
npx email-agent serve              # Start web UI
```

## Architecture

```
packages/
  core/   @email-agent/core    — Business logic, Gmail API, LanceDB, agents, actions, analysis
  web/    @email-agent/web     — Next.js 15 App Router UI (port 3847)
  cli/    @email-agent/cli     — Commander.js CLI tool
```

## Key Patterns

- **Agent system**: Strategy pattern executors (Claude/Codex/Gemini CLI + DirectAPI) with AgentRouter
- **Action system**: Plugin architecture — `*.action.ts` files auto-discovered from built-in + user dirs
- **DB**: LanceDB vector database with Apache Arrow schemas

## Key Files

- `packages/core/src/agents/router.ts` — Agent selection logic
- `packages/core/src/actions/runner.ts` — Action execution pipeline
- `packages/core/src/db/connection.ts` — LanceDB init with Arrow schemas
- `packages/core/src/config/defaults.ts` — All default config values and prompt templates
- `packages/web/src/app/api/` — All Next.js API routes
- `packages/core/src/actions/built-in/` — Built-in actions
- `~/.email-agent/actions/` — User-created actions (auto-discovered)

## Gotchas

- After renaming packages, clean-rebuild core: `rm -rf packages/core/dist packages/core/tsconfig.tsbuildinfo && npx tsc -p packages/core/tsconfig.json` — stale incremental cache can produce `.d.ts.map` without `.d.ts`
- LanceDB `createEmptyTable()` requires Apache Arrow `Schema`/`Field` objects, NOT plain JS objects
- DB record interfaces need `[key: string]: unknown` index signatures for `table.add()`
- Core uses `composite: true`; CLI uses `references: [{ path: "../core" }]` — core MUST build before CLI type-checks
- Web tsconfig needs `lib: ["ES2022", "DOM", "DOM.Iterable"]` (base tsconfig only has ES2022)
- Web resolves `@email-agent/core/*` subpaths via tsconfig `paths` to source files
- CLI imports from `@email-agent/core` barrel export only (no subpath imports) due to rootDir constraint
- `node-notifier` types are strict — only `title`, `message`, `wait` are valid notification props
- `fetch().json()` needs explicit return type annotations with strict TS + TanStack Query generics

## Code Style

- ESM throughout (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript with `noUncheckedIndexedAccess`
- No default exports except action plugin files (`*.action.ts`)

## Environment

See `.env.example` for all variables. Key ones:
- `OPENAI_API_KEY` — Required for embeddings (text-embedding-3-small)
- `GCP_PROJECT_ID` — Required for Gmail API access
- `AGENT_MODE` — "all-agents" | "hybrid" | "direct-api"
