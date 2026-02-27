import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useSettings() {
  return useQuery<Record<string, unknown>>({
    queryKey: ["settings"],
    queryFn: async (): Promise<Record<string, unknown>> => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json() as Promise<Record<string, unknown>>;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, Record<string, unknown>>({
    mutationFn: async (settings) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to update settings");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
