import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSessionUnlocked, SESSION_COOKIE_NAME } from "@/modules/api/validation";
import { UnlockExchange } from "@/components/auth/unlock-exchange";

/**
 * The unlock landing dispatcher. Next 15 layouts do not receive
 * `searchParams` — only pages do — so the `?token=…` handoff has to live
 * here rather than in `(app)/layout.tsx`, which is why this page exists
 * instead of the old bare `redirect("/mail")`.
 *
 * Three outcomes, checked in this order:
 *  1. Already unlocked (or the gate is off for this run — `isSessionUnlocked`
 *     is the same predicate `sessionViolation` uses inside the API guards,
 *     bypass included) -> straight to `/mail`. This is what makes a stale or
 *     already-redeemed
 *     `?token=…` link harmless: someone who is already unlocked never sees a
 *     failure for clicking an old link out of a terminal.
 *  2. A `token` query param is present -> hand it to the client component
 *     that POSTs it to the exchange route. That call has to happen in the
 *     browser: the exchange route sets an httpOnly cookie via `Set-Cookie`,
 *     and a client fetch is what lets the browser store it before the next
 *     navigation.
 *  3. Neither -> `/unlock`, the static recovery page.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const jar = await cookies();
  if (isSessionUnlocked(jar.get(SESSION_COOKIE_NAME)?.value)) {
    redirect("/mail");
  }
  if (token) {
    return <UnlockExchange token={token} />;
  }
  redirect("/unlock");
}
