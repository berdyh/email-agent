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
 *  1. A `token` query param is present -> hand it to the client component
 *     that POSTs it to the exchange route. That call has to happen in the
 *     browser: the exchange route sets an httpOnly cookie via `Set-Cookie`
 *     AND returns the origin-scoped second factor in its body for the client
 *     to put in `localStorage`, and only a client fetch can do either.
 *  2. Already unlocked (`isSessionUnlocked` is the PAGE gate's predicate —
 *     the cookie alone, bypass included) -> `/mail`.
 *  3. Neither -> `/unlock`, the static recovery page.
 *
 * ─── WHY THE TOKEN BRANCH MUST COME FIRST ────────────────────────────────────
 *
 * It used to come second, so that an already-unlocked user clicking a stale
 * link never saw a failure. That ordering became a TRAP the moment the API
 * guards started requiring a second factor the server cannot see here: a
 * browser holding a valid cookie and no factor (every browser that unlocked
 * before that landed, or any that has had its site storage cleared) would
 * short-circuit to `/mail`, get 401 `binding-required` on its first API call,
 * be sent to `/unlock`, be told to click the printed link, arrive back here,
 * and short-circuit to `/mail` again. Forever. The paste box would still work,
 * but the recovery this app recommends everywhere would be a loop.
 *
 * A top-level navigation carries no custom header, so this dispatcher CANNOT
 * know whether `/mail` will actually work for the browser in front of it.
 * Given that, spending a live token is the outcome that always terminates.
 * The cost is that a fully-working browser clicking a STALE link now sees the
 * "already used" screen instead of landing silently on `/mail`; that screen
 * carries an "Open the app" link for exactly this case.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (token) {
    return <UnlockExchange token={token} />;
  }
  const jar = await cookies();
  if (isSessionUnlocked(jar.get(SESSION_COOKIE_NAME)?.value)) {
    redirect("/mail");
  }
  redirect("/unlock");
}
