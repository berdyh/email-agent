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
