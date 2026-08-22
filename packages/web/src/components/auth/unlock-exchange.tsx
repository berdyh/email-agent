"use client";

import { useEffect, useState } from "react";
import {
  UNLOCK_TOKEN_FRAGMENT_KEY,
  describeUnlockExchangeError,
  type UnlockExchangeErrorCode,
} from "@/modules/api/auth-contract";
import { storeSessionBinding } from "@/lib/session-binding";
import { UnlockScreen } from "@/components/auth/unlock-screen";

/**
 * Reads the unlock token out of the URL FRAGMENT and redeems it.
 *
 * Mounted by `/unlock` when the link carries `?exchange=1`.
 *
 * ─── WHY THE TOKEN ARRIVES AS A FRAGMENT AND NOT A PROP ──────────────────────
 *
 * It used to be a prop, read from `?token=` by the server-rendered root page.
 * That is exactly what made it visible: `serve` runs `next dev`, whose request
 * logger prints the complete `request.url`, so every unlock echoed the live
 * token back into the terminal. A fragment is never sent to any server, so
 * nothing server-side can see it — including this component's own page, which
 * is why the value cannot be passed down and has to be read from
 * `location.hash` here. Full argument in `packages/cli/src/unlock-url.ts`.
 *
 * ─── ORDER OF OPERATIONS, ALL THREE PARTS LOAD-BEARING ───────────────────────
 *
 * `history.replaceState` runs FIRST, before the network round trip: the token
 * has already done its job by reaching this component, and there is no reason
 * to leave it in the visible URL while a fetch is in flight. Be honest about
 * what that achieves — it clears the address bar and the current history entry,
 * not the browser's persisted history/omnibox record, which can already have
 * captured the URL at navigation commit.
 *
 * The second factor is stored BEFORE the navigation that follows success:
 * `location.replace` tears the page down, so anything still pending never runs.
 * This component runs on the origin the user actually opened, which is what
 * makes `localStorage` here the right jar — that is the whole bootstrap, and
 * there is no other moment at which the browser could obtain the value.
 *
 * A full `window.location.replace` on success, not the Next router: the session
 * cookie was just set by a `Set-Cookie` on the fetch response, and a real
 * navigation is what guarantees the next server component render
 * (`(app)/layout.tsx`) sees it, rather than relying on the client router cache
 * to have picked up a cookie a `fetch()` call set out of band.
 */
export function UnlockExchange(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [noToken, setNoToken] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const token = new URLSearchParams(hash).get(UNLOCK_TOKEN_FRAGMENT_KEY);
    if (!token) {
      // A stale bookmark of `/unlock?exchange=1` after the hash was cleared, or
      // a link a mail client truncated at the `#`. Falling back to the ordinary
      // screen keeps the paste box — the documented answer for a mangled link —
      // one render away instead of stranding the user on an error.
      setNoToken(true);
      return;
    }

    // Strip the FRAGMENT and nothing else. Rewriting the path or query here
    // would invent a URL the user never navigated to; the only thing that has
    // to go is the secret, and `?exchange=1` is not one. A reload of what is
    // left mounts this component again, finds no token, and falls through to
    // the ordinary screen.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

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
          const payload = (await res.json().catch(() => null)) as { binding?: unknown } | null;
          if (typeof payload?.binding === "string") storeSessionBinding(payload.binding);
          window.location.replace("/mail");
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { code?: UnlockExchangeErrorCode }
          | null;
        setError(body?.code ? describeUnlockExchangeError(body.code) : "That link did not work.");
      } catch {
        if (!cancelled) {
          setError("Could not reach the server. Check your connection and try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (noToken) return <UnlockScreen />;

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <div className="flex justify-center gap-4">
            <a href="/unlock" className="text-sm underline underline-offset-4">
              Go to the unlock page
            </a>
            {/*
              For the browser that is already fully working and clicked a STALE
              link out of a terminal: it lands here rather than on /mail, and
              one click is the whole cost.
            */}
            <a href="/mail" className="text-sm underline underline-offset-4">
              Open the app
            </a>
          </div>
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
