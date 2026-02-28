"use client";

import { useEmails } from "@/hooks/use-emails";
import { useEmailStore } from "@/store/email-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MailToolbar } from "./mail-toolbar";

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

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
