# Email Agent

A local, AI-powered email analysis tool that uses multiple LLM agents (Claude, Codex, Gemini, OpenRouter) to summarize, prioritize, cluster, and act on your emails — all from your machine.

## Features

- **Multi-agent support** — Routes tasks to Claude Code, OpenAI Codex, Google Gemini CLI, or OpenRouter (with direct API fallback)
- **Email actions** — Extensible plugin system for custom email analysis (priority detection, spam scoring, subscription detection, and more)
- **Approval gate** — Gmail changes an action proposes (trash, spam, archive, labels) are queued for review first. Nothing touches your mailbox until you approve it from the web UI or the CLI
- **AI summaries** — On-demand email summarization with citation mapping back to source text
- **Semantic clustering** — Groups similar emails using vector embeddings and k-means clustering
- **Subscription digests** — Aggregates newsletter and marketing emails into a single AI-generated digest
- **Web UI** — Three-panel mail interface with dark mode, resizable panels, and AI features built in
- **CLI** — Fetch emails, run actions, and start the web server from the terminal

## Prerequisites

- **Node.js** 22.18+ or 23.6+ (needed for unflagged TypeScript type stripping, which the native loader uses to import user-created `.action.ts` files; also covers `process.loadEnvFile`, used to load the root `.env`). Note 23.0–23.5 are excluded: they are newer than 22.18 but still gate type stripping behind a flag
- **Google Cloud CLI** (`gcloud`) — for Gmail API authentication
- **At least one AI agent CLI** (optional but recommended):
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - [Google Gemini CLI](https://github.com/google/gemini-cli) (`npx @google/gemini-cli`)
- **API key for embeddings** — OpenAI or [OpenRouter](https://openrouter.ai) (or pick the `local` embedding provider in setup for deterministic lexical embeddings)

## Setup

```bash
# One-command setup (installs deps, authenticates, initializes DB)
./setup.sh
```

Or step by step:

```bash
npm install
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify
npx email-agent setup --project <your-gcp-project-id>
```

### Environment Variables

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | For OpenAI embeddings / direct-api mode | Embeddings, clustering, and the direct LLM API |
| `ANTHROPIC_API_KEY` | For the `claude-sdk` executor | Claude Agent SDK access without the CLI |
| `OPENROUTER_API_KEY` | For OpenRouter | Embeddings (Qwen3) + LLM access via openrouter.ai |
| `OPENROUTER_MODEL` | No | OpenRouter LLM model (default: `qwen/qwen3-8b`) |
| `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS` | No | Set to `1` only for trusted remote deployments that need non-local browser writes |

The root `.env` is loaded by both the CLI and the web server at startup (it holds
API keys). Agent selection, embedding provider, GCP project, and data dir are
**not** env vars — they live in `~/.email-agent/settings.json`:

```bash
npx email-agent config set agentMode direct-api   # all-agents | hybrid | direct-api
npx email-agent config set preferredAgent codex   # claude | codex | gemini | openrouter | claude-sdk | direct-api
```

## Usage

### CLI

```bash
# Fetch unread emails and generate embeddings
npx email-agent fetch

# Fetch with a custom limit
npx email-agent fetch --limit 50

# List available actions
npx email-agent list-actions

# Run an action on unread emails (Gmail changes are queued for approval)
npx email-agent run-action priority
npx email-agent run-action subscription
npx email-agent run-action junk

# Review the Gmail changes actions queued for you
npx email-agent approvals              # list what is waiting
npx email-agent approvals review       # decide per email: apply / reject / skip
npx email-agent approvals apply        # approve everything pending, after a confirm
npx email-agent approvals reject       # discard everything pending

# Start the web UI
npx email-agent serve
```

`review`, `apply`, and `reject` all take `--batch <id>` to scope the decision to a
single action run. `approvals list` prints the batch id next to each group; a
prefix works as long as it matches exactly one batch.

### Web UI

```bash
npm run dev    # Start development server
npm run start  # Start on port 3847
```

Then open [http://localhost:3847](http://localhost:3847).

**Pages:**
- `/mail` — Three-panel inbox with email list, reader, and AI summaries
- `/actions` — Browse and run AI actions, and approve or reject the Gmail changes they queue
- `/clusters` — Semantic email clustering visualization
- `/digest` — AI-generated subscription digest
- `/settings` — Configure agents, prompts, and the Gmail auto-apply opt-in

The sidebar shows a badge with the number of Gmail changes waiting for you.

## Architecture

```
packages/
  core/   @email-agent/core   — Gmail API, LanceDB, agents, actions, analysis
  web/    @email-agent/web    — Next.js 15 App Router UI
  cli/    @email-agent/cli    — Commander.js CLI
```

For agent-safe module boundaries, start with
[`docs/architecture/module-index.md`](docs/architecture/module-index.md), then
load the local `MODULE.md` card beside the area being changed.

### Agent System

The agent router tries your preferred CLI agent first, then falls back through others:

| Mode | Behavior |
|---|---|
| `all-agents` | Try preferred CLI → other CLIs → OpenRouter → error |
| `hybrid` | Try preferred CLI → other CLIs → OpenRouter → direct API |
| `direct-api` | API only — OpenAI-compatible direct API or OpenRouter, whichever is configured (`preferredAgent` picks the order) |

### Action Plugin System

Create custom email actions by dropping `*.action.ts` files in `~/.email-agent/actions/`:

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "my-action",
  name: "My Custom Action",
  description: "What this action does",
  prompt: `Analyze each email and return JSON with your findings.`,
};

export default action;
```

User actions are auto-discovered and run from either the CLI (`npx email-agent run-action <id>`) or the web `/actions` page alongside built-ins.

See [CREATE_ACTION_SKILLS.md](CREATE_ACTION_SKILLS.md) for the full action creation guide with examples, and [EDIT_ACTION_SKILLS.md](EDIT_ACTION_SKILLS.md) for modifying existing actions.

### Built-in Actions

| Action | Description |
|---|---|
| `priority` | Classifies emails as high/medium/low priority |
| `subscription` | Detects newsletters and marketing emails |
| `junk` | Scores emails for spam likelihood (0-100) |

### Approval Gate

Actions never write to Gmail on their own. When an action decides an email should
be trashed, marked spam, archived, or relabelled, that change is written to a
local `pending_operations` queue and stops there. You decide what actually
happens:

- **Web** — the `/actions` page lists everything queued with the email it affects.
  Rows are ticked once they have been on screen, so untick anything you don't
  want. Changes that arrive from a background refresh after you last looked are
  never swept into a bulk apply.
- **CLI** — `run-action` prompts you at the end of a run, and
  `npx email-agent approvals` picks up anything you left pending.

Approved and rejected rows stay in the `pending_operations` table as an audit
trail. The UI and CLI only list what is still pending, so reading the resolved
history means querying the table directly.

Per-email actions you click yourself in the mail UI still apply immediately — the
click is the approval.

**Turning the gate off.** Settings → Gmail has an auto-apply toggle that applies
each batch as soon as the action finishes. It is off by default and takes effect
only once you have accepted its cautions: `gmail.autoApplyActions` is forced back
to false on every read unless `gmail.autoApplyAcknowledged` is also true. The
Settings page is the only place that shows those cautions, and `config set`
refuses both keys, so the CLI can never arm it. While it is on, the `/actions`
page keeps a warning banner up and the CLI says so on every run. Changes are
still queued first, so the audit trail is unchanged.

> **Upgrading from an older install?** The old `gmail.syncActions` setting is
> gone. Any value you had is dropped and auto-apply starts off, so the first run
> after upgrading queues its Gmail changes for approval instead of applying them.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22.18+ / 23.6+, TypeScript 5.8 |
| Build | Turbo monorepo, ESM |
| Database | LanceDB (embedded vector DB) |
| Embeddings | OpenAI text-embedding-3-small or OpenRouter Qwen3 (768d) |
| Gmail | googleapis |
| Web | Next.js 15, React 19, Tailwind CSS v4 |
| State | Zustand + TanStack Query |
| CLI | Commander.js, ora, chalk |

## Development Checks

```bash
npm test
npm run lint
npm run check:boundaries
npm run build
```

Known gaps and deferred work live in [TODOS.md](TODOS.md).

## License

MIT
