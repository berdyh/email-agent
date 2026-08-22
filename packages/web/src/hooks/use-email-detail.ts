import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";

/** Shape of `GET /api/gmail/[id]` — the stored `EmailRecord` minus its vector. */
export interface EmailDetail {
  id: string;
  accountId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  labels: string;
  isUnread: boolean;
  snippet: string;
}

/**
 * THE key order for a single email: `["email", accountId, emailId]`.
 *
 * Two components used to build this key by hand in opposite orders, so the same
 * email cached twice and `invalidateQueries({ queryKey: ["email"] })` refreshed
 * only whichever copy happened to match first. Everything that reads one email
 * goes through this function so there is exactly one order to get wrong.
 */
export function emailDetailQueryKey(
  accountId: string | null | undefined,
  emailId: string | null | undefined,
): readonly [string, string | null | undefined, string | null | undefined] {
  return ["email", accountId, emailId] as const;
}

export function emailDetailPath(
  emailId: string | null,
  accountId: string | null,
): string {
  const path = `/api/gmail/${encodeURIComponent(emailId ?? "")}`;
  if (accountId === null) return path;
  const params = new URLSearchParams({ accountId });
  return `${path}?${params}`;
}

/**
 * Fetches one email's detail. Disabled until both halves of its identity are
 * known — an email id is only unique within an account.
 */
export function useEmailDetail(
  accountId: string | null,
  emailId: string | null,
) {
  return useQuery<EmailDetail>({
    queryKey: emailDetailQueryKey(accountId, emailId),
    enabled: emailId !== null && accountId !== null,
    queryFn: async (): Promise<EmailDetail> => {
      const res = await apiFetch(emailDetailPath(emailId, accountId));
      if (!res.ok) throw new Error("Failed to fetch email");
      return res.json() as Promise<EmailDetail>;
    },
  });
}
