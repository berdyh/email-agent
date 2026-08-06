import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface ApprovalEmailSummary {
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface ApprovalOperation {
  id: string;
  batchId: string;
  actionId: string;
  actionName: string;
  accountId: string;
  emailId: string;
  type: string;
  labelIds: string[];
  /** Human-readable description of the change, derived server-side from core. */
  label: string;
  /** True for changes that hide or destroy mail (trash/spam). */
  destructive: boolean;
  createdAt: string;
  email: ApprovalEmailSummary | null;
}

export interface ApprovalsResponse {
  operations: ApprovalOperation[];
  pendingCount: number;
}

export interface ApplyApprovalsResult {
  applied: number;
  failed: number;
  errors: Array<{ emailId: string; error: string }>;
  /** Per-operation results, in the order the operations were applied. */
  outcomes: Array<{
    emailId: string;
    type: string;
    ok: boolean;
    error?: string;
  }>;
}

export function useApprovals() {
  return useQuery<ApprovalsResponse>({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalsResponse> => {
      const res = await fetch("/api/approvals");
      if (!res.ok) throw new Error("Failed to fetch pending approvals");
      return res.json() as Promise<ApprovalsResponse>;
    },
  });
}

export function useApproveOperations() {
  const queryClient = useQueryClient();

  return useMutation<ApplyApprovalsResult, Error, { ids: string[] }>({
    mutationFn: async ({ ids }) => {
      const res = await fetch("/api/approvals/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Failed to apply approved operations");
      return res.json() as Promise<ApplyApprovalsResult>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      // Applied operations mutate Gmail (trash/spam/labels/read state), so
      // every email-derived cache goes stale.
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCount"] });
      void queryClient.invalidateQueries({ queryKey: ["email"] });
    },
  });
}

export function useRejectOperations() {
  const queryClient = useQueryClient();

  return useMutation<{ rejected: number }, Error, { ids: string[] }>({
    mutationFn: async ({ ids }) => {
      const res = await fetch("/api/approvals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Failed to reject operations");
      return res.json() as Promise<{ rejected: number }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
