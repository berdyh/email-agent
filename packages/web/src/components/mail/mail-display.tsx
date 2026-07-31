"use client";

import { useEmailStore } from "@/store/email-store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Mail, MailOpen } from "lucide-react";
import { MailSummary } from "./mail-summary";
import { MailContent } from "./mail-content";
import { useEffect, useRef } from "react";

interface EmailDetail {
  id: string;
  accountId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  labels: string;
  isUnread: boolean;
}

export function MailDisplay() {
  const selectedEmailId = useEmailStore((s) => s.selectedEmailId);
  const selectedEmailAccountId = useEmailStore((s) => s.selectedEmailAccountId);
  const openedEmailKey = useRef<string | null>(null);

  const queryClient = useQueryClient();

  const { data: email, isLoading } = useQuery<EmailDetail>({
    queryKey: ["email", selectedEmailAccountId, selectedEmailId],
    queryFn: async (): Promise<EmailDetail> => {
      const res = await fetch(emailDetailPath(selectedEmailId, selectedEmailAccountId));
      if (!res.ok) throw new Error("Failed to fetch email");
      return res.json() as Promise<EmailDetail>;
    },
    enabled: selectedEmailId !== null && selectedEmailAccountId !== null,
  });

  const toggleRead = useMutation<
    { id: string; isUnread: boolean },
    Error,
    boolean
  >({
    mutationFn: async (isUnread: boolean) => {
      const res = await fetch(emailDetailPath(selectedEmailId, selectedEmailAccountId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isUnread }),
      });
      if (!res.ok) throw new Error("Failed to update read status");
      return res.json() as Promise<{ id: string; isUnread: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["email", selectedEmailAccountId, selectedEmailId],
      });
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCount"] });
    },
  });

  useEffect(() => {
    if (!selectedEmailId) {
      openedEmailKey.current = null;
    }
  }, [selectedEmailId]);

  useEffect(() => {
    const emailKey = email ? `${email.accountId}:${email.id}` : null;
    if (
      !email ||
      email.id !== selectedEmailId ||
      email.accountId !== selectedEmailAccountId ||
      toggleRead.isPending ||
      openedEmailKey.current === emailKey
    ) {
      return;
    }

    openedEmailKey.current = emailKey;
    if (email.isUnread) {
      toggleRead.mutate(false);
    }
  }, [
    email?.accountId,
    email?.id,
    email?.isUnread,
    selectedEmailAccountId,
    selectedEmailId,
    toggleRead.isPending,
  ]);

  if (!selectedEmailId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select an email to read
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!email) return null;

  const labels = safeParseLabels(email.labels);

  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{email.subject}</h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{email.from}</span>
            <span>to</span>
            <span>{email.to}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {new Date(email.date).toLocaleString()}
            </span>
            {labels.map((label) => (
              <Badge key={label} variant="outline" className="text-xs">
                {label}
              </Badge>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1 text-xs"
              disabled={toggleRead.isPending}
              onClick={() => toggleRead.mutate(!email.isUnread)}
            >
              {email.isUnread ? (
                <>
                  <MailOpen className="h-3.5 w-3.5" />
                  Mark read
                </>
              ) : (
                <>
                  <Mail className="h-3.5 w-3.5" />
                  Mark unread
                </>
              )}
            </Button>
          </div>
        </div>

        <Separator className="my-4" />

        <MailSummary
          emailId={email.id}
          accountId={email.accountId}
          bodyText={email.bodyText}
        />

        <Separator className="my-4" />

        <MailContent bodyHtml={email.bodyHtml} bodyText={email.bodyText} />
      </div>
    </ScrollArea>
  );
}

function emailDetailPath(emailId: string | null, accountId: string | null): string {
  const path = `/api/gmail/${emailId ?? ""}`;
  if (accountId === null) return path;
  const params = new URLSearchParams({ accountId });
  return `${path}?${params}`;
}

function safeParseLabels(labels: string): string[] {
  try {
    const parsed = JSON.parse(labels);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
