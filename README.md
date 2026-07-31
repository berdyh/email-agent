# Email Agent

A local, AI-powered email analysis tool that uses multiple LLM agents (Claude, Codex, Gemini, OpenRouter) to summarize, prioritize, cluster, and act on your emails — all from your machine.

## Features

- **Multi-agent support** — Routes tasks to Claude Code, OpenAI Codex, Google Gemini CLI, or OpenRouter (with direct API fallback)
- **Email actions** — Extensible plugin system for custom email analysis (priority detection, spam scoring, subscription detection, and more)
- **AI summaries** — On-demand email summarization with citation mapping back to source text
- **Semantic clustering** — Groups similar emails using vector embeddings and k-means clustering
- **Subscription digests** — Aggregates newsletter and marketing emails into a single AI-generated digest
- **Web UI** — Three-panel mail interface with dark mode, resizable panels, and AI features built in
- **CLI** — Fetch emails, run actions, and start the web server from the terminal

## Prerequisites

- **Node.js** >= 20.12 (`process.loadEnvFile` is used to load the root `.env`)
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
npx email-agent config set preferredAgent codex   # claude | codex | gemini | openrouter
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

# Run an action on unread emails
npx email-agent run-action priority
npx email-agent run-action subscription
npx email-agent run-action junk

# Start the web UI
npx email-agent serve
```

### Web UI

```bash
npm run dev    # Start development server
npm run start  # Start on port 3847
```

Then open [http://localhost:3847](http://localhost:3847).

**Pages:**
- `/mail` — Three-panel inbox with email list, reader, and AI summaries
- `/actions` — Browse and run AI actions on your emails
- `/clusters` — Semantic email clustering visualization
- `/digest` — AI-generated subscription digest
- `/settings` — Configure agents and prompts

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

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20.12+, TypeScript 5.8 |
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

## License

MIT
