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

/**
 * Error thrown when the fetch route rejects a request. `code` carries the typed
 * classification from the server (e.g. "auth"), so the UI does not have to
 * re-parse the human-readable message to decide how to react.
 */
export class FetchEmailsError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "FetchEmailsError";
    this.code = code;
  }
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
        const data = (await res.json()) as { error: string; code?: string };
        throw new FetchEmailsError(data.error, data.code);
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

  // Keep the latest isFetching in a ref so doFetch (and thus the interval)
  // stays referentially stable and does not reset on every fetch.
  const isFetchingRef = useRef(isFetching);
  isFetchingRef.current = isFetching;

  const fetchInterval = settings?.ui.fetchInterval ?? 0;
  const fetchScope = settings?.ui.fetchScope ?? "unread";

  const doFetch = useCallback(() => {
    if (!isFetchingRef.current) {
      fetchFn({ scope: fetchScope === "all" ? "all" : "unread", accountEmail });
    }
  }, [fetchFn, fetchScope, accountEmail]);

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

  const fetchInterval = settings?.ui.fetchInterval ?? 0;
  const fetchScope = settings?.ui.fetchScope ?? "unread";

  const setFetchInterval = (interval: number) => {
    updateSettings({ ui: { fetchScope, fetchInterval: interval } });
  };

  const setFetchScope = (scope: "unread" | "all") => {
    updateSettings({ ui: { fetchInterval, fetchScope: scope } });
  };

  return { fetchInterval, fetchScope, setFetchInterval, setFetchScope };
}
