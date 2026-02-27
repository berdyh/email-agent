# Gmail Reader

Local AI-powered Gmail analysis tool. Monorepo with Turbo.

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
npx gmail-reader fetch              # Fetch unread emails → LanceDB
npx gmail-reader run-action <id>    # Run an action (priority, subscription, junk)
npx gmail-reader list-actions       # List available actions
npx gmail-reader serve              # Start web UI
```

## Architecture

```
packages/
  core/   @gmail-reader/core    — Business logic, Gmail API, LanceDB, agents, actions, analysis
  web/    @gmail-reader/web     — Next.js 15 App Router UI (port 3847)
  cli/    @gmail-reader/cli     — Commander.js CLI tool
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
- `~/.gmail-reader/actions/` — User-created actions (auto-discovered)

## Gotchas

- LanceDB `createEmptyTable()` requires Apache Arrow `Schema`/`Field` objects, NOT plain JS objects
- DB record interfaces need `[key: string]: unknown` index signatures for `table.add()`
- Core uses `composite: true`; CLI uses `references: [{ path: "../core" }]` — core MUST build before CLI type-checks
- Web tsconfig needs `lib: ["ES2022", "DOM", "DOM.Iterable"]` (base tsconfig only has ES2022)
- Web resolves `@gmail-reader/core/*` subpaths via tsconfig `paths` to source files
- CLI imports from `@gmail-reader/core` barrel export only (no subpath imports) due to rootDir constraint
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
