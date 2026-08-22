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

- **Node.js** 22.18+ or 23.6+ (needed for unflagged TypeScript type stripping, which the native loader uses to import the built-in `.action.ts` files when running from source; also covers `process.loadEnvFile`, used to load the root `.env`). User-created `.action.ts` files are parsed rather than imported, so they no longer depend on type stripping. Note 23.0–23.5 are excluded: they are newer than 22.18 but still gate type stripping behind a flag
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

### Adding Gmail accounts: authorized redirect URIs

Adding an account runs a Google OAuth consent flow, and Google only returns to a
redirect URI that was registered on the OAuth client beforehand. Two things about
that are better known now than discovered at the consent screen.

**Register every origin you serve the app on.** The web callback URI is built
from the origin of the request that starts the flow, so that `serve --port N`
works — which makes the port part of the URI Google has to already know.
Registering the default is enough only while you always use the default: run
`npx email-agent serve --port 4000` and you also need
`http://localhost:4000/api/auth/callback`, and reaching the app as `127.0.0.1`
instead of `localhost` is a different origin needing its own entry. Miss one and
Google refuses with `redirect_uri_mismatch` before it even asks you to consent.
The CLI's own flow is fixed at `http://localhost:9876/callback` and is
unaffected by the port you serve on.

Google Cloud console → APIs & Services → Credentials → your OAuth 2.0 client →
Authorized redirect URIs:

```
http://localhost:3847/api/auth/callback   # web UI, default port
http://localhost:9876/callback            # CLI
```

**Add one account at a time in a given browser.** The flow is protected against
login CSRF by a state value in a single cookie, so two add-account flows started
at once in the same browser share it: the second overwrites the first. Whichever
callback returns first with a stale state is refused with a 403 — and because a
refusal also clears the shared cookie, it can take the other flow down with it,
so both tabs may end up rejected. Nothing is damaged and no account is
half-added; just start the account again, one at a time.

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
| `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS` | No | Set to `1` only for trusted remote deployments. Relaxes the API's local-origin checks, makes `email-agent serve` bind `0.0.0.0` instead of loopback, **and** bypasses the browser unlock/session gate described below |

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
npx email-agent approvals stranded     # changes stuck mid-apply, whose outcome was never recorded

# Recover a user action the edit flow overwrote
npx email-agent actions snapshots                    # every saved version, newest first
npx email-agent actions snapshots --action junk.action.ts
npx email-agent actions snapshots restore junk.action.ts.2026-02-28T12-00-00-000Z.ts

# Start the web UI (binds 127.0.0.1 by default)
npx email-agent serve
npx email-agent serve --host 0.0.0.0   # expose it deliberately; see the warning it prints
```

A restore is re-validated by the same source guard that runs on save, so a
snapshot taken before that guard existed — one that imports a value, for
instance — is refused rather than restored. The command prints the specific
rules it violated; copy what you need out of `~/.email-agent/actions/.snapshots/`
by hand in that case.

`review`, `apply`, and `reject` all take `--batch <id>` to scope the decision to a
single action run. `approvals list` prints the batch id next to each group; a
prefix works as long as it matches exactly one batch.

### Web UI

```bash
npm run dev    # Start development server
npm run start  # Start on port 3847
```

`npm run dev`/`npm run start` never mint an unlock link (only `email-agent
serve`/`email-agent unlock` do, see below) — open the printed link from one
of those, or run `npx email-agent unlock` in another terminal to print one
for a server already running under `npm run dev`.

### Unlocking the local UI

Since 2026-08-22, opening [http://localhost:3847](http://localhost:3847) or
[http://127.0.0.1:3847](http://127.0.0.1:3847) with a fresh browser lands on
an unlock screen, not the mail UI directly. `npx email-agent serve` prints a
**one-time link** — `http://<host>:<port>/unlock?exchange=1#token=…`, good for
ten minutes — before it starts the server. Open it once and the browser stays unlocked: the
resulting session is a rolling 24-hour idle window that renews itself on
daily use, so it does not re-lock on its own as long as you keep using the
app. If the link is lost, expired, or you're running `npm run dev` directly
(which never prints one), run:

```bash
npx email-agent unlock
```

from the project directory — it works whether or not a server is currently
running, and does not require restarting one that already is. The unlock
page also accepts the link or the bare token pasted into a form, for when
only the token was copied, or when a terminal or mail client truncated the
link at the `#`.

**The token is after the `#` on purpose.** A URL fragment is never sent to a
server by any browser, so it cannot land in a server log, a proxy log, or a
`Referer` header — the browser reads it locally and posts it in a request
body. That is not cosmetic: `serve` runs Next's dev server, whose request
logger prints the complete URL of every request, so while the token rode in
the query string (`/?token=…`, before 2026-08-22) every unlock echoed the
live token straight back into the terminal. What a fragment does *not* fix,
and this is worth knowing rather than assuming: the token is still in your
terminal's scrollback, in your clipboard if you copied it, and possibly in
your browser's own history database, which can record the URL — fragment
included — before the page's script gets a chance to strip it. All of those
are on the machine that printed the token in the first place; what moved is
the copy that used to reach a *server*.

**"One time" holds across processes, not just within one.** The token's burn,
the sessions it mints and the failed-attempt counter all live in one file, and
a second Email Agent process — `serve` beside `npm run dev`, two `serve`s, or
`unlock` run while the browser is redeeming — used to be able to read and
write it at the same moment as the first, so both could redeem the same link.
Measured, before the fix: twenty of twenty attempts. Writes now take a lock,
and a lock left behind by a killed process is detected by asking the operating
system whether its owner still exists, so a crash can never leave you unable
to unlock. If two processes genuinely collide, the link is refused with "try
again in a moment" and is *not* spent.

This raises the bar from "anything that can reach the port" to "anything
that can read your home directory" — a process on this machine that is NOT
running as you (a different Unix user, a container sharing the network
namespace) previously got the whole app for free on an open port; now it
gets the lock screen. That sentence was an overclaim until the second factor
below landed: a neighbouring loopback port could be handed the session cookie
by your own browser and replay it, without reading anything of yours at all. It does **not** raise the bar against a process running
AS you: that can already read the OAuth tokens directly from
`~/.email-agent/accounts/` and call Gmail without this app at all, unlock
token or not.

**Two things travel with an unlocked browser, not one.** The session cookie
is a bearer credential, and cookies are scoped by host with no port
component — so every other program listening on a loopback port shares this
app's cookie jar, and one that could steer your browser to it would receive
a working cookie. `httpOnly` does not help there: it stops page scripts
reading the value, and the thing holding it is an HTTP server. So the unlock
exchange also issues an opaque second value, which the browser keeps in
`localStorage` — scoped by *origin*, which does include the port — and sends
back in a request header on every API call. A neighbouring port cannot read
it, so a captured cookie on its own buys nothing; both together are what a
normal unlocked browser holds. The consequence you may
notice: clearing this site's data, or blocking storage for it, means one more
`npx email-agent unlock`, even though you are technically still signed in.
The page you land on says so. `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` bypasses this gate the
same way it bypasses the header checks below — a LAN deployment via
`serve --host 0.0.0.0` never prints a token, because nothing is checking for
one.

**The server binds `127.0.0.1` only.** The API's "is this local?" checks read the
`Host`, `Origin` and `Sec-Fetch-Site` headers, all of which a non-browser client
sets for itself, so they stop cross-site pages and DNS-rebound pages but not a
determined caller. Binding to loopback is the part no header can talk its way
past.

If you genuinely want it reachable from elsewhere, use the CLI — either form
works and they do the same thing:

```bash
npx email-agent serve --host 0.0.0.0
EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1 npx email-agent serve
```

Each binds every interface **and** turns the header checks off for that run.
Both halves are needed: a guard that insists on a local `Host` refuses the LAN
browser the open bind exists for, so a bind without the relaxation just returns
403 to everything. Anything that can then reach the port can read your mail and
approve queued Gmail changes; `serve` prints that warning before it starts.

`npm run dev` and `npm run start` always bind `127.0.0.1`. The hostname is
hardcoded in `packages/web/package.json` and `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS`
does not move it — but it does turn off the header checks **and the browser
unlock gate** on those servers, so an unauthenticated local caller gets the whole
app. It does not have to be typed into a shell to do that: `next.config.ts` loads
the repo-root `.env`, and `.env.example` ships a commented line for the variable.
The web server now prints a security warning naming that file, once, when it
starts with the flag set — if you see it and did not mean it, check
`<repoRoot>/.env`. Use `email-agent serve` for remote access.

None of this protects you from another process running as **you** on this
machine: it can reach loopback, and it can read the OAuth tokens under
`~/.email-agent/accounts/` and talk to Gmail without the app at all.

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

**An action file must be pure data, and it is never executed.** Files in
`~/.email-agent/actions/` are *parsed*, not imported: the loader statically
evaluates the file and lifts the exported object out of it, so nothing in that
directory ever runs in the app's process. A file may contain only `import type`,
type declarations, variables whose values are literals/objects/arrays, and
`export default`. Anything that computes — a value import, a function call,
`a.b`, `new`, an arrow function, a spread, a computed key, or `${...}`
interpolation — is refused, and the refusal is logged with the exact rules
broken, so an action that does not appear is diagnosable rather than silently
missing. Prompt text is never read as code, so a prompt that talks about
importing, fetching or processing email is fine. If you hand-wrote an action
that builds its prompt at load time, hoist the value into a plain constant
(`const PROMPT = "..."` then `prompt: PROMPT`) — that works; computing it does
not.

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
