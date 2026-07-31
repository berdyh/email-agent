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

export interface ActionResult {
  actionId: string;
  status: string;
  output?: unknown;
  error?: string;
  pendingOperations?: GmailOperationItem[];
  batchId?: string;
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
      // A successful run never touches Gmail directly — it queues operations
      // for approval, so only the approvals cache goes stale here.
      if (result.pendingOperations?.length) {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
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
