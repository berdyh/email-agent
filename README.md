# Email Agent

A local, AI-powered email analysis tool that uses multiple LLM agents (Claude, Codex, Gemini, OpenRouter) to summarize, prioritize, cluster, and act on your emails — all from your machine.

## Features

- **Multi-agent support** — Routes tasks to Claude Code, OpenAI Codex, Google Gemini CLI, or OpenRouter (with direct API fallback)
- **Email actions** — Extensible plugin system for custom email analysis (priority detection, spam scoring, subscription detection, and more)
- **AI summaries** — On-demand email and thread summarization with citation mapping back to source text
- **Semantic clustering** — Groups similar emails using vector embeddings and k-means clustering
- **Subscription digests** — Aggregates newsletter and marketing emails into a single AI-generated digest
- **Desktop & webhook notifications** — Alerts via system notifications, Slack, Discord, or custom webhooks
- **Vector search** — Find semantically similar emails using LanceDB + OpenAI or OpenRouter embeddings
- **Gmail push notifications** — Real-time email updates via Google Cloud Pub/Sub
- **Web UI** — Three-panel mail interface with dark mode, resizable panels, and AI features built in
- **CLI** — Fetch emails, run actions, and start the web server from the terminal

## Prerequisites

- **Node.js** >= 20
- **Google Cloud CLI** (`gcloud`) — for Gmail API authentication
- **At least one AI agent CLI** (optional but recommended):
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - [Google Gemini CLI](https://github.com/google/gemini-cli) (`npx @google/gemini-cli`)
- **API key for embeddings** — OpenAI or [OpenRouter](https://openrouter.ai) (or use `EMBEDDING_PROVIDER=local` for zero-vector fallback)

## Setup

```bash
# One-command setup (installs deps, authenticates, initializes DB)
./setup.sh
```

Or step by step:

```bash
npm install
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/pubsub
npx email-agent setup --project <your-gcp-project-id>
```

### Environment Variables

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `GCP_PROJECT_ID` | Yes | Google Cloud project with Gmail API enabled |
| `OPENAI_API_KEY` | For OpenAI embeddings | Powers semantic search and clustering |
| `OPENROUTER_API_KEY` | For OpenRouter | Embeddings (Qwen3) + LLM access via openrouter.ai |
| `OPENROUTER_MODEL` | No | OpenRouter LLM model (default: `qwen/qwen3-8b`) |
| `AGENT_MODE` | No | `all-agents` (default), `hybrid`, or `direct-api` |
| `PREFERRED_AGENT` | No | `claude` (default), `codex`, `gemini`, or `openrouter` |
| `ANTHROPIC_API_KEY` | For direct-api mode | When using direct API instead of CLI agents |
| `SLACK_WEBHOOK_URL` | No | Slack notification webhook |
| `DISCORD_WEBHOOK_URL` | No | Discord notification webhook |

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
- `/settings` — Configure agents, prompts, notifications, and theme
- `/setup` — First-time setup wizard

## Architecture

```
packages/
  core/   @email-agent/core   — Gmail API, LanceDB, agents, actions, analysis, notifications
  web/    @email-agent/web    — Next.js 15 App Router UI
  cli/    @email-agent/cli    — Commander.js CLI
```

### Agent System

The agent router tries your preferred CLI agent first, then falls back through others:

| Mode | Behavior |
|---|---|
| `all-agents` | Try preferred CLI → other CLIs → OpenRouter → error |
| `hybrid` | Try preferred CLI → other CLIs → OpenRouter → direct API |
| `direct-api` | OpenAI-compatible API only |

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
| Runtime | Node.js 20+, TypeScript 5.8 |
| Build | Turbo monorepo, ESM |
| Database | LanceDB (embedded vector DB) |
| Embeddings | OpenAI text-embedding-3-small or OpenRouter Qwen3 (768d) |
| Gmail | googleapis + Google Cloud Pub/Sub |
| Web | Next.js 15, React 19, Tailwind CSS v4 |
| State | Zustand + TanStack Query |
| CLI | Commander.js, ora, chalk |
| Notifications | node-notifier, Slack/Discord webhooks |

## License

MIT
