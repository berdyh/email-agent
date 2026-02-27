import { useQuery } from "@tanstack/react-query";

export interface ThreadData {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageDate: string;
  summary: string;
  summaryData: string;
  priority: string;
}

export function useThread(id: string | null) {
  return useQuery<ThreadData>({
    queryKey: ["thread", id],
    queryFn: async (): Promise<ThreadData> => {
      const res = await fetch(`/api/threads/${id}`);
      if (!res.ok) throw new Error("Failed to fetch thread");
      return res.json() as Promise<ThreadData>;
    },
    enabled: Boolean(id),
  });
}
