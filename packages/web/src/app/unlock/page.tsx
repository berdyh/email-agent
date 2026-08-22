import { UnlockScreen } from "@/components/auth/unlock-screen";
import { UnlockExchange } from "@/components/auth/unlock-exchange";
import {
  UNLOCK_EXCHANGE_MARKER,
  UNLOCK_EXCHANGE_PARAM,
  UNLOCK_REASON_BINDING,
  UNLOCK_REASON_PARAM,
} from "@/modules/api/auth-contract";

/**
 * The unlock landing page — BOTH the static recovery screen and the endpoint
 * the printed link lands on.
 *
 * ─── WHY THE PRINTED LINK COMES HERE, AND NOT TO `/` ─────────────────────────
 *
 * The token is in the URL FRAGMENT (`/unlock?exchange=1#token=…`), because a
 * fragment is never sent to a server and therefore cannot reach `next dev`'s
 * request logger — see `packages/cli/src/unlock-url.ts`. Only the browser can
 * read it, so the redemption has to happen on a page that renders WITHOUT a
 * session, makes no guarded calls, and never redirects a valid-cookie browser
 * away before its script has had a chance to look at the hash. This page is the
 * only one that satisfies all three; the root dispatcher redirects, which would
 * hand the fragment to `/mail` where nothing reads it.
 *
 * A SERVER component that reads `?reason=` and `?exchange=`, rather than a
 * client component calling `useSearchParams`. Both work; this one avoids the
 * Suspense boundary Next 15 requires around `useSearchParams` on a page that
 * would otherwise be static, and keeps the screen itself a plain presentational
 * component with a prop.
 *
 * `?exchange=1` is the non-secret half of the link. Without it this page would
 * have to render the lock screen and let a client effect replace it once it had
 * read the hash, flashing "Email Agent is locked" at somebody who is in the
 * middle of unlocking successfully. With it, the server renders the right thing
 * first time and there is no hydration mismatch to suppress.
 *
 * Both params are NARROWED here rather than passed through as strings, so an
 * arbitrary `?reason=`/`?exchange=` in the URL can only ever select behaviour
 * this app wrote.
 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (params[UNLOCK_EXCHANGE_PARAM] === UNLOCK_EXCHANGE_MARKER) {
    // No token prop: the server cannot see the fragment, and that is the point.
    // `<UnlockExchange>` reads it in the browser, and falls back to the screen
    // below if there is nothing there (a stale bookmark of this URL after the
    // hash was cleared).
    return <UnlockExchange />;
  }
  const reason = params[UNLOCK_REASON_PARAM];
  return <UnlockScreen reason={reason === UNLOCK_REASON_BINDING ? "binding" : undefined} />;
}
