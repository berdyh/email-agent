"use client";

import { useEffect, useState } from "react";
import {
  describeUnlockExchangeError,
  type UnlockExchangeErrorCode,
} from "@/modules/api/auth-contract";

/**
 * The `?token=…` handoff. Mounted by the root `page.tsx` dispatcher when a
 * token is present in the URL and the browser is not already unlocked.
 *
 * `history.replaceState` runs FIRST, before the network round trip — the
 * token has already done its job by reaching this component (it travelled in
 * the query string, which is a real and named cost, see
 * `packages/cli/src/unlock-url.ts`), and there is no reason to let it sit in
 * the visible URL/history entry a moment longer than it has to while a fetch
 * is in flight.
 *
 * A full `window.location.replace` on success, not the Next router: the
 * session cookie was just set by a `Set-Cookie` on the fetch response, and a
 * real navigation is what guarantees the next server component render
 * (`(app)/layout.tsx`) sees it, rather than relying on the client router
 * cache to have picked up a cookie a `fetch()` call set out of band.
 */
export function UnlockExchange({ token }: { token: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.history.replaceState(null, "", "/");

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (res.ok) {
          window.location.replace("/mail");
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { code?: UnlockExchangeErrorCode }
          | null;
        setError(
          body?.code
            ? describeUnlockExchangeError(body.code)
            : "That link did not work.",
        );
      } catch {
        if (!cancelled) {
          setError("Could not reach the server. Check your connection and try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <a href="/unlock" className="text-sm underline underline-offset-4">
            Go to the unlock page
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">Unlocking…</p>
    </main>
  );
}
