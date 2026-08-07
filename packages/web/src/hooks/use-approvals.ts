import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApplyApprovalsResult,
  ApprovalsResponse,
  RejectApprovalsResult,
} from "@/modules/api/approvals-contract";

// The wire types live with the routes that produce them, so adding a field on
// one side is a compile error on the other. Re-exported here because every
// consumer already imports the approvals surface from this hook module.
export type {
  ApplyApprovalsResult,
  ApprovalEmailSummary,
  ApprovalOperation,
  ApprovalsResponse,
  RejectApprovalsResult,
} from "@/modules/api/approvals-contract";

/**
 * Pull the server's message off a failed response instead of throwing a
 * one-size-fits-all string. `/api/approvals/apply` answers 409 with a specific
 * explanation when every submitted id was already resolved elsewhere, and that
 * sentence is the whole point of the status code.
 */
async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return new Error(body.error);
    }
  } catch {
    // Non-JSON body — fall through to the generic message.
  }
  return new Error(fallback);
}

export function useApprovals() {
  return useQuery<ApprovalsResponse>({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalsResponse> => {
      const res = await fetch("/api/approvals");
      if (!res.ok) throw await errorFromResponse(res, "Failed to fetch pending approvals");
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
      if (!res.ok) throw await errorFromResponse(res, "Failed to apply approved operations");
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
    onError: () => {
      // A 409 means the queue moved under us (another tab or the CLI resolved
      // the batch). Refetching is what makes the panel agree with reality
      // again, so the error path has to invalidate too.
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useRejectOperations() {
  const queryClient = useQueryClient();

  return useMutation<RejectApprovalsResult, Error, { ids: string[] }>({
    mutationFn: async ({ ids }) => {
      const res = await fetch("/api/approvals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw await errorFromResponse(res, "Failed to reject operations");
      return res.json() as Promise<RejectApprovalsResult>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
