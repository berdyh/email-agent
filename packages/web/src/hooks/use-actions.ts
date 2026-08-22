import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";

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
  outcomes: Array<{
    emailId: string;
    type: string;
    ok: boolean;
    error?: string;
  }>;
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
  /**
   * Set when the proposed changes never reached the approval queue. Strictly
   * pre-Gmail: nothing was applied.
   */
  queueError?: string;
  /**
   * Set when the opt-in auto-apply threw AFTER the queue rows were claimed.
   *
   * NOT interchangeable with `queueError`. Core claims a row before it calls
   * Gmail, so this may mean nothing happened or that mail was really trashed
   * and only the write-back failed. The string core sends already says "may
   * already have been applied" — print it, and do not report
   * `pendingOperations` as awaiting approval alongside it: those rows are
   * `applying`, not `pending`.
   */
  applyError?: string;
  /** Set when the `action_results` history row could not be written. */
  persistError?: string;
  /**
   * How many proposals were dropped at enqueue time because an identical change
   * was already awaiting approval. Set only when non-zero.
   */
  duplicateOperations?: number;
}

export function useActions() {
  return useQuery<ActionItem[]>({
    queryKey: ["actions"],
    queryFn: async (): Promise<ActionItem[]> => {
      const res = await apiFetch("/api/actions");
      if (!res.ok) throw new Error("Failed to fetch actions");
      return res.json() as Promise<ActionItem[]>;
    },
  });
}

export function useRunAction() {
  const queryClient = useQueryClient();

  return useMutation<ActionResult, Error, { actionId: string; accountEmail?: string }>({
    mutationFn: async ({ actionId, accountEmail }): Promise<ActionResult> => {
      const res = await apiFetch("/api/actions", {
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
      // An auto-apply that threw is the case where BOTH caches are wrong: the
      // rows it claimed are `applying` (so the stranded list under
      // ["approvals", "stranded"] may have grown) and Gmail may already have
      // been mutated. ["approvals"] is a prefix of the stranded key, so one
      // invalidation covers both approval queries.
      if (result.applyError) {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        void queryClient.invalidateQueries({ queryKey: ["emails"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCount"] });
        void queryClient.invalidateQueries({ queryKey: ["email"] });
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
      const res = await apiFetch("/api/actions/user", {
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
