"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";

export interface Account {
  email: string;
  name?: string;
  isDefault?: boolean;
}

export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Account[]> => {
      const res = await apiFetch("/api/accounts");
      if (!res.ok) throw new Error("Failed to fetch accounts");
      return res.json() as Promise<Account[]>;
    },
  });
}
