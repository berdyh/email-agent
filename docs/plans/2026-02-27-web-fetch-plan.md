# Web + CLI Email Fetching — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable email fetching from the web UI (manual + auto-refresh) and CLI (scope flag + cron scheduling).

**Architecture:** Extract the fetch→embed→store pipeline from CLI into a shared `syncEmails()` function in core. Web gets a POST API route + toolbar UI with interval/scope controls. CLI gets `--scope` flag and a `cron` command for scheduling.

**Tech Stack:** TypeScript, Next.js 15 API routes, TanStack Query mutations, Zustand, Commander.js, crontab

---

### Task 1: Add `fetchEmails()` with scope to core fetcher

**Files:**
- Modify: `packages/core/src/gmail/fetcher.ts:65-90`

**Step 1: Add the `FetchOptions` type and `fetchEmails()` function**

In `packages/core/src/gmail/fetcher.ts`, add above the existing `fetchUnreadEmails`:

```ts
export interface FetchOptions {
  scope: "unread" | "all";
  maxResults?: number;
}

export async function fetchEmails(
  options: FetchOptions,
): Promise<GmailMessage[]> {
  const gmail = await createGmailClient();
  const response = await gmail.users.messages.list({
    userId: "me",
    q: options.scope === "unread" ? "is:unread" : undefined,
    maxResults: options.maxResults ?? 50,
  });

  const messageIds = response.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const messages = await Promise.all(
    messageIds.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: id!,
        format: "full",
      });
      return parseGmailMessage(msg.data);
    }),
  );

  return messages;
}
```

**Step 2: Refactor `fetchUnreadEmails()` to delegate**

Replace the existing `fetchUnreadEmails` body:

```ts
export async function fetchUnreadEmails(
  maxResults = 50,
): Promise<GmailMessage[]> {
  return fetchEmails({ scope: "unread", maxResults });
}
```

**Step 3: Export from gmail barrel**

In `packages/core/src/gmail/index.ts`, update the fetcher exports line:

```ts
export { fetchUnreadEmails, fetchEmails, fetchEmail, fetchThread, type FetchOptions } from "./fetcher.js";
```

**Step 4: Verify core type-checks**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
git add packages/core/src/gmail/fetcher.ts packages/core/src/gmail/index.ts
git commit -m "feat(core): add fetchEmails with scope option"
```

---

### Task 2: Create shared `syncEmails()` pipeline in core

**Files:**
- Create: `packages/core/src/gmail/sync.ts`
- Modify: `packages/core/src/gmail/index.ts`

**Step 1: Create `packages/core/src/gmail/sync.ts`**

```ts
import { initDb, upsertEmails, generateEmbeddings } from "../db/index.js";
import { fetchEmails, type FetchOptions } from "./fetcher.js";

export interface SyncResult {
  fetched: number;
}

export async function syncEmails(options: FetchOptions): Promise<SyncResult> {
  await initDb();

  const emails = await fetchEmails(options);
  if (emails.length === 0) return { fetched: 0 };

  const texts = emails.map(
    (e) => `${e.subject}\n${e.from}\n${e.bodyText.slice(0, 500)}`,
  );

  let vectors: number[][];
  try {
    vectors = await generateEmbeddings(texts);
  } catch {
    // Graceful degradation: store with zero vectors if embedding fails
    vectors = texts.map(() => Array(768).fill(0) as number[]);
  }

  const records = emails.map((e, i) => ({
    id: e.id,
    threadId: e.threadId,
    from: e.from,
    to: e.to,
    subject: e.subject,
    date: e.date,
    bodyText: e.bodyText,
    bodyHtml: e.bodyHtml,
    labels: JSON.stringify(e.labels),
    isUnread: e.isUnread,
    senderDomain: e.senderDomain,
    snippet: e.snippet,
    vector: vectors[i] ?? (Array(768).fill(0) as number[]),
  }));

  await upsertEmails(records);

  return { fetched: emails.length };
}
```

**Step 2: Export from gmail barrel**

Add to `packages/core/src/gmail/index.ts`:

```ts
export { syncEmails, type SyncResult } from "./sync.js";
```

**Step 3: Verify core type-checks**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add packages/core/src/gmail/sync.ts packages/core/src/gmail/index.ts
git commit -m "feat(core): extract syncEmails shared pipeline"
```

---

### Task 3: Add fetch config to AppConfig

**Files:**
- Modify: `packages/core/src/config/types.ts:40-44`
- Modify: `packages/core/src/config/defaults.ts:40-43`

**Step 1: Extend UiConfig**

In `packages/core/src/config/types.ts`, add to the `UiConfig` interface:

```ts
export interface UiConfig {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  panelWidths: [number, number, number];
  fetchInterval: number;
  fetchScope: "unread" | "all";
}
```

**Step 2: Add defaults**

In `packages/core/src/config/defaults.ts`, update the `ui` section of `defaultConfig`:

```ts
  ui: {
    theme: "system",
    sidebarCollapsed: false,
    panelWidths: [20, 35, 45],
    fetchInterval: 0,
    fetchScope: "unread",
  },
```

**Step 3: Verify all packages type-check**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add packages/core/src/config/types.ts packages/core/src/config/defaults.ts
git commit -m "feat(core): add fetchInterval and fetchScope to AppConfig"
```

---

### Task 4: Refactor CLI fetch to use `syncEmails()`

**Files:**
- Modify: `packages/cli/src/commands/fetch.ts`

**Step 1: Rewrite the fetch command**

Replace the entire file content of `packages/cli/src/commands/fetch.ts`:

```ts
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { syncEmails } from "@email-agent/core";

export function registerFetch(program: Command) {
  program
    .command("fetch")
    .description("Fetch emails from Gmail and store in the database")
    .option("-l, --limit <n>", "Maximum emails to fetch", "20")
    .option(
      "-s, --scope <scope>",
      'Fetch scope: "unread" or "all"',
      "unread",
    )
    .action(async (options: { limit: string; scope: string }) => {
      const limit = parseInt(options.limit, 10);
      const scope = options.scope === "all" ? "all" as const : "unread" as const;

      const spinner = ora(
        `Fetching ${scope === "all" ? "all" : "unread"} emails...`,
      ).start();

      try {
        const result = await syncEmails({ scope, maxResults: limit });

        spinner.succeed(`Stored ${result.fetched} emails with embeddings`);
        console.log(
          chalk.green(
            `\nRun ${chalk.cyan("email-agent serve")} to view them.\n`,
          ),
        );
      } catch (err) {
        spinner.fail("Failed to fetch emails");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });
}
```

**Step 2: Verify CLI type-checks**

Run: `npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add packages/cli/src/commands/fetch.ts
git commit -m "refactor(cli): use shared syncEmails pipeline, add --scope flag"
```

---

### Task 5: Add CLI cron command

**Files:**
- Create: `packages/cli/src/commands/cron.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Create `packages/cli/src/commands/cron.ts`**

Uses `execFileSync` (not `exec`/`execSync`) to avoid shell injection.

```ts
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";

const MARKER = "# email-agent-cron";

function getCurrentCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function setCrontab(content: string): void {
  execFileSync("crontab", ["-"], {
    encoding: "utf-8",
    input: content,
  });
}

function removeAgentEntries(crontab: string): string {
  return crontab
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function resolveNpxPath(): string {
  try {
    return execFileSync("which", ["npx"], { encoding: "utf-8" }).trim();
  } catch {
    return "npx";
  }
}

export function registerCron(program: Command) {
  const cron = program
    .command("cron")
    .description("Manage scheduled email fetching via crontab");

  cron
    .command("setup")
    .description("Install a crontab entry for periodic email fetching")
    .option(
      "-i, --interval <minutes>",
      "Fetch interval in minutes (1, 5, 10, 30)",
      "5",
    )
    .option(
      "-s, --scope <scope>",
      'Fetch scope: "unread" or "all"',
      "unread",
    )
    .option("-l, --limit <n>", "Maximum emails per fetch", "20")
    .action(
      (options: { interval: string; scope: string; limit: string }) => {
        const interval = parseInt(options.interval, 10);
        if (![1, 5, 10, 30].includes(interval)) {
          console.error(
            chalk.red("Interval must be one of: 1, 5, 10, 30 (minutes)"),
          );
          process.exit(1);
        }

        const scope = options.scope === "all" ? "all" : "unread";
        const limit = options.limit;
        const npx = resolveNpxPath();

        const spinner = ora("Setting up crontab entry...").start();

        const crontab = getCurrentCrontab();
        const cleaned = removeAgentEntries(crontab);
        const entry = `*/${interval} * * * * ${npx} email-agent fetch --scope ${scope} --limit ${limit} ${MARKER}`;
        const updated = cleaned.trimEnd() + "\n" + entry + "\n";

        setCrontab(updated);

        spinner.succeed(
          `Crontab installed: fetch ${scope} emails every ${interval} minutes`,
        );
        console.log(chalk.dim(`  ${entry}`));
      },
    );

  cron
    .command("remove")
    .description("Remove the email-agent crontab entry")
    .action(() => {
      const spinner = ora("Removing crontab entry...").start();

      const crontab = getCurrentCrontab();
      if (!crontab.includes(MARKER)) {
        spinner.info("No email-agent crontab entry found");
        return;
      }

      const cleaned = removeAgentEntries(crontab);
      setCrontab(cleaned);

      spinner.succeed("Removed email-agent crontab entry");
    });

  cron
    .command("status")
    .description("Show the current email-agent crontab entry")
    .action(() => {
      const crontab = getCurrentCrontab();
      const entries = crontab
        .split("\n")
        .filter((line) => line.includes(MARKER));

      if (entries.length === 0) {
        console.log(chalk.dim("No email-agent crontab entry configured."));
        console.log(
          chalk.dim(`Run ${chalk.cyan("email-agent cron setup")} to add one.`),
        );
        return;
      }

      console.log(chalk.bold("Active email-agent crontab:"));
      for (const entry of entries) {
        console.log(chalk.green(`  ${entry.replace(MARKER, "").trim()}`));
      }
    });
}
```

**Step 2: Register in CLI entry point**

In `packages/cli/src/index.ts`, add import:

```ts
import { registerCron } from "./commands/cron.js";
```

Add before `program.parse()`:

```ts
registerCron(program);
```

**Step 3: Verify CLI type-checks**

Run: `npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add packages/cli/src/commands/cron.ts packages/cli/src/index.ts
git commit -m "feat(cli): add cron command for scheduled email fetching"
```

---

### Task 6: Create web API fetch endpoint

**Files:**
- Create: `packages/web/src/app/api/gmail/fetch/route.ts`

**Step 1: Create the POST endpoint**

Create `packages/web/src/app/api/gmail/fetch/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { syncEmails, type FetchOptions } from "@email-agent/core/gmail";

export const dynamic = "force-dynamic";

let fetching = false;

export async function POST(request: NextRequest) {
  if (fetching) {
    return NextResponse.json(
      { error: "Fetch already in progress" },
      { status: 409 },
    );
  }

  try {
    fetching = true;

    const body = (await request.json()) as Partial<FetchOptions>;
    const options: FetchOptions = {
      scope: body.scope === "all" ? "all" : "unread",
      maxResults: body.maxResults ?? 50,
    };

    const result = await syncEmails(options);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("auth") || message.includes("token")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    fetching = false;
  }
}
```

**Step 2: Verify web type-checks**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add packages/web/src/app/api/gmail/fetch/route.ts
git commit -m "feat(web): add POST /api/gmail/fetch endpoint"
```

---

### Task 7: Create `useFetchEmails` hook

**Files:**
- Create: `packages/web/src/hooks/use-fetch-emails.ts`

**Step 1: Create the hook**

Create `packages/web/src/hooks/use-fetch-emails.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useCallback } from "react";
import { useSettings, useUpdateSettings } from "./use-settings";

interface FetchResponse {
  fetched: number;
}

interface FetchParams {
  scope: "unread" | "all";
  maxResults?: number;
}

export function useFetchEmails() {
  const queryClient = useQueryClient();

  return useMutation<FetchResponse, Error, FetchParams>({
    mutationKey: ["fetchEmails"],
    mutationFn: async (params) => {
      const res = await fetch("/api/gmail/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      return res.json() as Promise<FetchResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });
}

export function useAutoFetch(
  fetchFn: (params: FetchParams) => void,
  isFetching: boolean,
) {
  const { data: settings } = useSettings();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ui = settings as Record<string, unknown> | undefined;
  const uiObj = (ui?.ui ?? {}) as Record<string, unknown>;
  const fetchInterval = (uiObj.fetchInterval as number) ?? 0;
  const fetchScope = (uiObj.fetchScope as string) ?? "unread";

  const doFetch = useCallback(() => {
    if (!isFetching) {
      fetchFn({ scope: fetchScope === "all" ? "all" : "unread" });
    }
  }, [fetchFn, fetchScope, isFetching]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (fetchInterval > 0) {
      intervalRef.current = setInterval(doFetch, fetchInterval * 60_000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchInterval, doFetch]);

  return { fetchInterval, fetchScope };
}

export function useFetchSettings() {
  const { data: settings } = useSettings();
  const { mutate: updateSettings } = useUpdateSettings();

  const ui = ((settings as Record<string, unknown> | undefined)?.ui ?? {}) as Record<string, unknown>;

  const fetchInterval = (ui.fetchInterval as number) ?? 0;
  const fetchScope = ((ui.fetchScope as string) ?? "unread") as "unread" | "all";

  const setFetchInterval = (interval: number) => {
    updateSettings({ ui: { ...ui, fetchInterval: interval } });
  };

  const setFetchScope = (scope: "unread" | "all") => {
    updateSettings({ ui: { ...ui, fetchScope: scope } });
  };

  return { fetchInterval, fetchScope, setFetchInterval, setFetchScope };
}
```

**Step 2: Verify web type-checks**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add packages/web/src/hooks/use-fetch-emails.ts
git commit -m "feat(web): add useFetchEmails hook with auto-refresh"
```

---

### Task 8: Create mail toolbar component and integrate

**Files:**
- Create: `packages/web/src/components/mail/mail-toolbar.tsx`
- Modify: `packages/web/src/components/mail/mail-list.tsx`

**Step 1: Create `packages/web/src/components/mail/mail-toolbar.tsx`**

```tsx
"use client";

import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  useFetchEmails,
  useAutoFetch,
  useFetchSettings,
} from "@/hooks/use-fetch-emails";
import { useState, useEffect } from "react";

const INTERVAL_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "1", label: "1 min" },
  { value: "5", label: "5 min" },
  { value: "10", label: "10 min" },
  { value: "30", label: "30 min" },
];

export function MailToolbar() {
  const { mutate: fetchEmails, isPending, isSuccess, data } = useFetchEmails();
  const { fetchInterval, fetchScope, setFetchInterval, setFetchScope } =
    useFetchSettings();
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [timeAgo, setTimeAgo] = useState("");

  useAutoFetch(fetchEmails, isPending);

  useEffect(() => {
    if (isSuccess) {
      setLastFetched(new Date());
    }
  }, [isSuccess, data]);

  useEffect(() => {
    if (!lastFetched) return;

    const update = () => {
      const diffSec = Math.floor(
        (Date.now() - lastFetched.getTime()) / 1000,
      );
      if (diffSec < 60) setTimeAgo(`${diffSec}s ago`);
      else setTimeAgo(`${Math.floor(diffSec / 60)}m ago`);
    };

    update();
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [lastFetched]);

  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <span className="text-sm font-medium">Inbox</span>

      <div className="ml-auto flex items-center gap-2">
        {lastFetched && (
          <span className="text-xs text-muted-foreground">
            Fetched {timeAgo}
          </span>
        )}

        <Select
          value={fetchScope}
          onChange={(e) =>
            setFetchScope(e.target.value as "unread" | "all")
          }
          className="h-8 w-24 text-xs"
        >
          <option value="unread">Unread</option>
          <option value="all">All</option>
        </Select>

        <Select
          value={String(fetchInterval)}
          onChange={(e) => setFetchInterval(Number(e.target.value))}
          className="h-8 w-24 text-xs"
        >
          {INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchEmails({ scope: fetchScope })}
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Fetch
        </Button>
      </div>
    </div>
  );
}
```

**Step 2: Integrate toolbar into `packages/web/src/components/mail/mail-list.tsx`**

Add import at the top:

```ts
import { MailToolbar } from "./mail-toolbar";
```

Replace the component's return statement to wrap content in a flex column with toolbar at top:

```tsx
export function MailList() {
  const filterUnreadOnly = useEmailStore((s) => s.filterUnreadOnly);
  const selectedEmailId = useEmailStore((s) => s.selectedEmailId);
  const selectEmail = useEmailStore((s) => s.selectEmail);

  const { data: emails, isLoading } = useEmails({
    unreadOnly: filterUnreadOnly,
    limit: 50,
  });

  return (
    <div className="flex h-full flex-col">
      <MailToolbar />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Loading emails...
        </div>
      ) : !emails?.length ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No emails found
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col">
            {emails.map((email) => (
              <button
                key={email.id}
                className={cn(
                  "flex flex-col gap-1 border-b p-3 text-left transition-colors hover:bg-accent",
                  selectedEmailId === email.id && "bg-accent",
                )}
                onClick={() => selectEmail(email.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      email.isUnread && "font-semibold",
                    )}
                  >
                    {email.from}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(email.date)}
                  </span>
                </div>
                <span
                  className={cn(
                    "truncate text-sm",
                    email.isUnread ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  {email.subject}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {email.snippet}
                </span>
                {email.isUnread && (
                  <Badge variant="secondary" className="w-fit text-xs">
                    Unread
                  </Badge>
                )}
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
```

Keep the existing `formatDate` function unchanged at the bottom of the file.

**Step 3: Verify web type-checks**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit`
Expected: 0 errors

**Step 4: Manual test**

1. Start dev server: `npm run dev`
2. Open `http://localhost:3847/mail`
3. Verify toolbar appears with Fetch button, scope dropdown, interval dropdown
4. Click Fetch — should show spinner, then "Fetched Xs ago"
5. Set interval to 1 min — should auto-fetch after 1 minute

**Step 5: Commit**

```bash
git add packages/web/src/components/mail/mail-toolbar.tsx packages/web/src/components/mail/mail-list.tsx
git commit -m "feat(web): add mail toolbar with fetch button and auto-refresh"
```

---

### Task 9: Final verification

**Step 1: Type-check all packages**

Run all three in sequence:
```bash
npx tsc -p packages/core/tsconfig.json --noEmit && \
npx tsc -p packages/web/tsconfig.json --noEmit && \
npx tsc -p packages/cli/tsconfig.json --noEmit
```
Expected: 0 errors for all three

**Step 2: Test CLI fetch with scope**

```bash
npx email-agent fetch --scope unread --limit 5
npx email-agent fetch --scope all --limit 5
```

**Step 3: Test CLI cron commands**

```bash
npx email-agent cron status
npx email-agent cron setup --interval 5 --scope unread
npx email-agent cron status
npx email-agent cron remove
```

**Step 4: Test web UI end-to-end**

1. Open `http://localhost:3847/mail`
2. Click Fetch button — emails appear in list
3. Change scope to "All" — click Fetch again
4. Set interval to 1m — wait 1m — list updates automatically
5. Set interval to Off — confirm no more auto-fetches

**Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "feat: web + CLI email fetching with auto-refresh and cron"
```
