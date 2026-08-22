import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSessionUnlocked, SESSION_COOKIE_NAME } from "@/modules/api/validation";

/**
 * The session gate for every real page (`/mail`, `/settings`, `/actions`,
 * `/clusters`, `/digest`) — everything under this route group.
 *
 * STATE THIS HONESTLY: this is UX, not the enforcement. Every page in this
 * app is `"use client"` with zero server-side data fetching (AGENTS.md's H6),
 * so a bug here only ever leaks the static app shell — no mail, no settings,
 * nothing the pages fetch, because every real read goes through the API
 * guards in `modules/api/validation.ts`, which is where enforcement actually
 * lives. This layout exists so a locked-out browser lands somewhere it can
 * act, instead of a shell that quietly 401s on every request it makes.
 *
 * `isSessionUnlocked` (`@/modules/api/validation`) is the SAME predicate
 * `sessionViolation` uses inside the API guards, including the
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` bypass — sharing it is what makes the
 * bypass automatic here rather than a second copy someone forgets to update.
 * Miss that bypass and a LAN deployment (`serve --host 0.0.0.0`, which turns
 * the gate off entirely — no token is ever minted for that run) becomes a
 * PERMANENT lockout: the API would let the LAN browser through, but this
 * layout would still redirect it to `/unlock`, which has no way to satisfy
 * for that run.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  if (!isSessionUnlocked(jar.get(SESSION_COOKIE_NAME)?.value)) redirect("/unlock");
  return <>{children}</>;
}
