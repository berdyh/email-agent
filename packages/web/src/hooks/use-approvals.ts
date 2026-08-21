import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApplyApprovalsResult,
  ApprovalsResponse,
  RejectApprovalsResult,
  ResolveStrandedResult,
  StrandedApprovalsResponse,
  StrandedDecision,
  VerifyStrandedResult,
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
  ResolveStrandedResult,
  StrandedApprovalsResponse,
  StrandedDecision,
  StrandedOperation,
  StrandedVerificationResidual,
  VerificationResidualReason,
  VerifyStrandedResult,
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

/**
 * Rows a crash left claimed mid-apply.
 *
 * The key is a CHILD of ["approvals"] on purpose: every existing mutation
 * already invalidates ["approvals"], and TanStack matches by prefix, so an
 * apply, a reject or an action run refreshes this list too without a second
 * invalidation having to be remembered in each of them.
 */
export function useStrandedApprovals() {
  return useQuery<StrandedApprovalsResponse>({
    queryKey: ["approvals", "stranded"],
    queryFn: async (): Promise<StrandedApprovalsResponse> => {
      const res = await fetch("/api/approvals/stranded");
      if (!res.ok) throw await errorFromResponse(res, "Failed to fetch stranded Gmail changes");
      return res.json() as Promise<StrandedApprovalsResponse>;
    },
  });
}

export function useResolveStranded() {
  const queryClient = useQueryClient();

  return useMutation<
    ResolveStrandedResult,
    Error,
    { ids: string[]; decision: StrandedDecision }
  >({
    mutationFn: async ({ ids, decision }) => {
      const res = await fetch("/api/approvals/stranded", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, decision }),
      });
      if (!res.ok) throw await errorFromResponse(res, "Failed to record your decision");
      return res.json() as Promise<ResolveStrandedResult>;
    },
    onSuccess: () => {
      // Prefix-matches both the pending list and the stranded list. A
      // "notApplied" answer moves a row back into the pending queue and the
      // sidebar badge, so refreshing only the stranded list would leave the
      // approval panel a row short.
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

/**
 * Fires the on-demand Gmail check for every stranded row. Call this AT MOST
 * ONCE per page load — see `StrandedOperationsPanel`, which guards it with a
 * ref rather than firing it from `useStrandedApprovals`'s own refetches. A
 * background refetch (window focus, a stale-time expiry) must never re-trigger
 * a live Gmail call; that would turn an explicit one-time check into the
 * polling loop this feature was deliberately built without.
 */
export function useVerifyStranded() {
  const queryClient = useQueryClient();

  return useMutation<VerifyStrandedResult, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/approvals/stranded/verify", { method: "POST" });
      if (!res.ok) {
        throw await errorFromResponse(res, "Failed to check stranded Gmail changes");
      }
      return res.json() as Promise<VerifyStrandedResult>;
    },
    onSuccess: () => {
      // A resolved row leaves `applying` either way (`applied` retires it,
      // `notApplied` moves it to `pending`), so both the stranded list and the
      // pending queue can change.
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
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
