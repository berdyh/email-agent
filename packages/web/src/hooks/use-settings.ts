import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import type { SanitizedSettings } from "@/modules/api/validation";

export type { SanitizedSettings };

export function useSettings() {
  return useQuery<SanitizedSettings>({
    queryKey: ["settings"],
    queryFn: async (): Promise<SanitizedSettings> => {
      const res = await apiFetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json() as Promise<SanitizedSettings>;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, Partial<SanitizedSettings>>({
    mutationFn: async (settings) => {
      const res = await apiFetch("/api/settings", {
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
