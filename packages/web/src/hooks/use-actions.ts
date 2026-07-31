import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface ActionItem {
  id: string;
  name: string;
  description: string;
  builtIn?: boolean;
  filename?: string;
}

export interface GmailOperationItem {
  emailId: string;
  type: string;
  labelIds?: string[];
  accountEmail?: string;
}

export interface ActionApplyResultData {
  applied: number;
  failed: number;
  errors: Array<{ emailId: string; error: string }>;
}

export interface ActionResult {
  actionId: string;
  status: string;
  output?: unknown;
  error?: string;
  pendingOperations?: GmailOperationItem[];
  batchId?: string;
  autoApplied?: boolean;
  /** Set only when the opt-in auto-apply setting applied the batch immediately. */
  applyResult?: ActionApplyResultData;
}

export function useActions() {
  return useQuery<ActionItem[]>({
    queryKey: ["actions"],
    queryFn: async (): Promise<ActionItem[]> => {
      const res = await fetch("/api/actions");
      if (!res.ok) throw new Error("Failed to fetch actions");
      return res.json() as Promise<ActionItem[]>;
    },
  });
}

export function useRunAction() {
  const queryClient = useQueryClient();

  return useMutation<ActionResult, Error, { actionId: string; accountEmail?: string }>({
    mutationFn: async ({ actionId, accountEmail }): Promise<ActionResult> => {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, accountEmail }),
      });
      if (!res.ok) throw new Error("Failed to run action");
      return res.json() as Promise<ActionResult>;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
      // A run queues its Gmail operations for approval, so the approvals cache
      // always goes stale. With auto-apply on, the batch was also written to
      // Gmail already, which invalidates every email-derived cache too.
      if (result.pendingOperations?.length) {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      }
      if (result.applyResult) {
        void queryClient.invalidateQueries({ queryKey: ["emails"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCount"] });
        void queryClient.invalidateQueries({ queryKey: ["email"] });
      }
    },
  });
}

export function useDeleteAction() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }, Error, { filename: string }>({
    mutationFn: async ({ filename }) => {
      const res = await fetch("/api/actions/user", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) throw new Error("Failed to delete action");
      return res.json() as Promise<{ success: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}
