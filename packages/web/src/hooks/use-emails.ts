import { useQuery } from "@tanstack/react-query";

export interface EmailListItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
  labels: string;
}

export function useEmails(options?: { unreadOnly?: boolean; limit?: number; offset?: number }) {
  return useQuery<EmailListItem[]>({
    queryKey: ["emails", options],
    queryFn: async (): Promise<EmailListItem[]> => {
      const params = new URLSearchParams();
      if (options?.unreadOnly) params.set("unreadOnly", "true");
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.offset) params.set("offset", String(options.offset));
      const res = await fetch(`/api/gmail?${params}`);
      if (!res.ok) throw new Error("Failed to fetch emails");
      return res.json() as Promise<EmailListItem[]>;
    },
  });
}
