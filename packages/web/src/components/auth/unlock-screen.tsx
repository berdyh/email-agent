"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  describeUnlockExchangeError,
  type UnlockExchangeErrorCode,
} from "@/modules/api/auth-contract";
import { storeSessionBinding } from "@/lib/session-binding";

/**
 * Pulls a redeemable token out of either a full unlock URL or a bare pasted
 * value, so a user who copied `http://127.0.0.1:3847/?token=…` out of a
 * terminal does not have to trim it down by hand.
 */
function extractToken(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) return fromQuery;
  } catch {
    // Not parseable as a URL — treat the whole trimmed string as the token.
  }
  return trimmed;
}

/**
 * The unlock page's content. Reachable by definition with NO session — another
 * Unix user, a container sharing the network namespace, a DNS-rebound page
 * that still passes the `Host` allowlist — so it deliberately offers no
 * self-service way to MINT a token, only to REDEEM one already obtained out
 * of band. Minting from here would let exactly the parties this page exists
 * to keep out unlock themselves.
 *
 * Deliberately says nothing about a second device: the printed link and the
 * session cookie are both host-scoped to whatever address the server bound
 * (`localhost:3847` and `127.0.0.1:3847` hold separate sessions, and a phone
 * on the LAN is a different host again), and that is out of scope by design.
 *
 * `reason === "binding"` is the RECOVERY case, and it is a different sentence
 * on purpose. That user's cookie is fine — what they are missing is the
 * origin-scoped second factor `apiFetch` sends alongside it, so telling them
 * "Email Agent is locked" would contradict what they can plainly see (they
 * were just using it, or they can load the app shell). Redeeming a link is
 * still the fix, because that is the only moment the server issues a new
 * factor; the copy has to explain WHY a working-looking browser needs one.
 */
export function UnlockScreen({
  reason,
}: {
  reason?: "binding";
} = {}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = extractToken(value);
    if (!token) return;

    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        // Before the navigation — `location.replace` tears the page down and
        // anything still pending never runs. See `lib/session-binding.ts`.
        const payload = (await res.json().catch(() => null)) as { binding?: unknown } | null;
        if (typeof payload?.binding === "string") storeSessionBinding(payload.binding);
        window.location.replace("/mail");
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { code?: UnlockExchangeErrorCode }
        | null;
      setMessage(body?.code ? describeUnlockExchangeError(body.code) : "That did not work.");
    } catch {
      setMessage("Could not reach the server. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold">
            {reason === "binding" ? "This browser needs unlocking again" : "Email Agent is locked"}
          </h1>
          {reason === "binding" && (
            <p className="text-sm text-muted-foreground">
              You are still signed in, but this browser is missing the key that
              ties that session to this exact address. That happens after
              clearing site data, or if the browser is blocking storage for
              this site. Redeeming a link below issues a fresh one.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            This unlocks read and write access to your mail data for this
            browser. It does not stop other programs running as you on this
            machine — those can already read your Gmail tokens directly from{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              ~/.email-agent/accounts/
            </code>{" "}
            and skip this app entirely.
          </p>
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
          <p className="font-medium">To unlock:</p>
          <p className="mt-1 text-muted-foreground">
            If{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">email-agent serve</code>{" "}
            is still running, check its terminal for a line starting with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">http://…/?token=</code>,
            and open it.
          </p>
          <p className="mt-2 text-muted-foreground">
            Lost it, or the link expired? Run{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">npx email-agent unlock</code>{" "}
            from the project directory to print a fresh one — it works
            whether or not a server is currently running.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-2">
          <label htmlFor="unlock-token" className="text-sm font-medium">
            Or paste the link or token here
          </label>
          <Input
            id="unlock-token"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="http://127.0.0.1:3847/?token=… or just the token"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            className="w-full"
            disabled={checking || !value.trim()}
          >
            {checking ? "Checking…" : "Unlock"}
          </Button>
          {message && <p className="text-sm text-destructive">{message}</p>}
        </form>
      </div>
    </main>
  );
}
