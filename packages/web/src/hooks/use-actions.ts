import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface ActionItem {
  id: string;
  name: string;
  description: string;
  builtIn?: boolean;
}

export interface ActionResult {
  actionId: string;
  status: string;
  output?: unknown;
  error?: string;
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

  return useMutation<ActionResult, Error, { actionId: string }>({
    mutationFn: async ({ actionId }): Promise<ActionResult> => {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      if (!res.ok) throw new Error("Failed to run action");
      return res.json() as Promise<ActionResult>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}
