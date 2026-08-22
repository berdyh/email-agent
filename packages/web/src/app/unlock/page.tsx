import { UnlockScreen } from "@/components/auth/unlock-screen";
import { UNLOCK_REASON_BINDING, UNLOCK_REASON_PARAM } from "@/modules/api/auth-contract";

/**
 * A SERVER component that reads the `?reason=` param and hands it down, rather
 * than a client component calling `useSearchParams`.
 *
 * Both work; this one avoids the Suspense boundary Next 15 requires around
 * `useSearchParams` on a page that would otherwise be static, and keeps the
 * screen itself a plain presentational component with a prop.
 *
 * The param is NARROWED here rather than passed through as a string, so an
 * arbitrary `?reason=` in the URL can only ever select copy this app wrote.
 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const reason = params[UNLOCK_REASON_PARAM];
  return <UnlockScreen reason={reason === UNLOCK_REASON_BINDING ? "binding" : undefined} />;
}
