import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useCallback } from "react";
import { useSettings, useUpdateSettings } from "./use-settings";

interface FetchResponse {
  fetched: number;
}

interface FetchParams {
  scope: "unread" | "all";
  maxResults?: number;
  accountEmail?: string;
}

export function useFetchEmails() {
  const queryClient = useQueryClient();

  return useMutation<FetchResponse, Error, FetchParams>({
    mutationKey: ["fetchEmails"],
    mutationFn: async (params) => {
      const res = await fetch("/api/gmail/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      return res.json() as Promise<FetchResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCount"] });
    },
  });
}

export function useAutoFetch(
  fetchFn: (params: FetchParams) => void,
  isFetching: boolean,
  accountEmail?: string,
) {
  const { data: settings } = useSettings();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ui = ((settings as Record<string, unknown> | undefined)?.ui ?? {}) as Record<string, unknown>;
  const fetchInterval = (ui.fetchInterval as number) ?? 0;
  const fetchScope = (ui.fetchScope as string) ?? "unread";

  const doFetch = useCallback(() => {
    if (!isFetching) {
      fetchFn({ scope: fetchScope === "all" ? "all" : "unread", accountEmail });
    }
  }, [fetchFn, fetchScope, isFetching, accountEmail]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (fetchInterval > 0) {
      intervalRef.current = setInterval(doFetch, fetchInterval * 60_000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchInterval, doFetch]);

  return { fetchInterval, fetchScope };
}

export function useFetchSettings() {
  const { data: settings } = useSettings();
  const { mutate: updateSettings } = useUpdateSettings();

  const ui = ((settings as Record<string, unknown> | undefined)?.ui ?? {}) as Record<string, unknown>;

  const fetchInterval = (ui.fetchInterval as number) ?? 0;
  const fetchScope = ((ui.fetchScope as string) ?? "unread") as "unread" | "all";

  const setFetchInterval = (interval: number) => {
    updateSettings({ ui: { ...ui, fetchInterval: interval } });
  };

  const setFetchScope = (scope: "unread" | "all") => {
    updateSettings({ ui: { ...ui, fetchScope: scope } });
  };

  return { fetchInterval, fetchScope, setFetchInterval, setFetchScope };
}
