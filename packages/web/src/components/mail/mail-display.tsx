"use client";

import { useEmailStore } from "@/store/email-store";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { MailSummary } from "./mail-summary";
import { MailContent } from "./mail-content";

interface EmailDetail {
  id: string;
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

  const { data: email, isLoading } = useQuery<EmailDetail>({
    queryKey: ["email", selectedEmailId],
    queryFn: async (): Promise<EmailDetail> => {
      const res = await fetch(`/api/gmail/${selectedEmailId}`);
      if (!res.ok) throw new Error("Failed to fetch email");
      return res.json() as Promise<EmailDetail>;
    },
    enabled: Boolean(selectedEmailId),
  });

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
          </div>
        </div>

        <Separator className="my-4" />

        <MailSummary emailId={email.id} bodyText={email.bodyText} />

        <Separator className="my-4" />

        <MailContent bodyHtml={email.bodyHtml} bodyText={email.bodyText} />
      </div>
    </ScrollArea>
  );
}

function safeParseLabels(labels: string): string[] {
  try {
    const parsed = JSON.parse(labels);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
