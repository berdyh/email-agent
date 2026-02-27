# Web + CLI Email Fetching

## Problem

The web UI can only read cached emails from LanceDB. Fetching requires running `npx email-agent fetch` from the CLI. Users need to fetch emails directly from the web UI and schedule automatic fetching from both web and CLI.

## Design

### Core — Shared fetch pipeline

**`core/gmail/fetcher.ts`** — Add `fetchEmails(options)` alongside existing `fetchUnreadEmails()`:

```ts
export interface FetchOptions {
  scope: "unread" | "all";
  maxResults?: number;
}

export async function fetchEmails(options: FetchOptions): Promise<GmailMessage[]>
```

Uses `q: "is:unread"` for unread scope, no query filter for all. `fetchUnreadEmails()` becomes a thin wrapper for backward compat.

**`core/gmail/sync.ts`** (new) — Extract the embed-and-store pipeline into a reusable function:

```ts
export async function syncEmails(options: FetchOptions): Promise<{ fetched: number }>
```

Does: `fetchEmails()` → `generateEmbeddings()` → `upsertEmails()`. Both CLI and web API call this single function.

### Config

Add to `AppConfig.ui`:

```ts
fetchInterval: 0 | 1 | 5 | 10 | 30;  // minutes, 0 = disabled
fetchScope: "unread" | "all";
```

### Web — API + UI

**`POST /api/gmail/fetch`** — Calls `syncEmails()`. Accepts `{ scope, limit }`. Returns `{ fetched: number }`.

**Mail list toolbar** (new component above email list):
- Fetch button with spinner while active
- Interval dropdown (Off, 1m, 5m, 10m, 30m)
- Scope toggle (Unread / All)
- "Last fetched: X ago" status text

**`useFetchEmails()` hook** — TanStack Query mutation + `setInterval` for auto-refresh. Invalidates `["emails"]` query after success.

### CLI changes

**`email-agent fetch --scope <unread|all>`** — Add scope option (defaults to unread for backward compat).

**`email-agent cron`** — New command with subcommands:
- `cron setup` — Interactive: prompts for interval + scope, writes crontab entry with `# email-agent` marker
- `cron remove` — Removes the crontab entry by marker
- `cron status` — Shows current crontab entry

### Error handling

- Gmail auth expired → 401, UI shows auth message
- Embedding API fails → store with zero vectors (graceful degradation)
- Fetch already in progress → 409 Conflict, UI debounces

## Files changed

| Layer | File | Change |
|-------|------|--------|
| Core | `gmail/fetcher.ts` | Add `fetchEmails(options)` with scope param |
| Core | `gmail/sync.ts` | **New** — `syncEmails()` shared pipeline |
| Core | `gmail/index.ts` | Export new functions |
| Core | `config/types.ts` | Add `fetchInterval`, `fetchScope` to AppConfig |
| Core | `config/defaults.ts` | Default values for new fields |
| Web | `api/gmail/fetch/route.ts` | **New** — POST endpoint |
| Web | `hooks/use-fetch-emails.ts` | **New** — mutation + auto-refresh |
| Web | `components/mail/mail-toolbar.tsx` | **New** — toolbar UI |
| Web | `components/mail/mail-list.tsx` | Import toolbar |
| CLI | `commands/fetch.ts` | Add `--scope`, use `syncEmails()` |
| CLI | `commands/cron.ts` | **New** — cron subcommands |
| CLI | `index.ts` | Register cron command |
