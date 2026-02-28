"use client";

import { useQuery } from "@tanstack/react-query";

export interface Account {
  email: string;
  name?: string;
  isDefault?: boolean;
}

export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Account[]> => {
      const res = await fetch("/api/accounts");
      if (!res.ok) throw new Error("Failed to fetch accounts");
      return res.json() as Promise<Account[]>;
    },
  });
}
