/**
 * The unlock-token and session store behind the local web UI.
 *
 * WHAT THIS IS FOR. Until now the only thing standing between a request and the
 * mailbox was where the listener binds. That stops anything off this box, and
 * nothing on it: another local user, or a container sharing the host's network
 * namespace, could open `http://127.0.0.1:3847` and read every message. This
 * store raises that bar to "can read this user's home directory", by requiring a
 * one-time token — printed by `email-agent serve`/`email-agent unlock`, i.e.
 * delivered out of band to whoever owns the terminal — before a browser is
 * issued a session.
 *
 * WHAT IT IS NOT FOR, and this must never be softened: it does NOT contain code
 * running as THIS user. Such code reads `~/.email-agent/accounts/{email}/token
 * .json` and calls the Gmail API directly, never touching this app, this file
 * or this cookie. The loopback bind remains the actual boundary against
 * everything off the machine.
 *
 * ─── WHY A FILE, AND NOT ENVIRONMENT VARIABLES ────────────────────────────────
 *
 * The obvious alternative is for `serve` to mint a token, pass its digest plus a
 * signing key to the Next child through the environment, and hold no state at
 * all. That design is genuinely tidier — the secrets die exactly when the run
 * dies, there is nothing to clean up, and nothing to chmod. It cannot be built
 * here for one decisive reason: `email-agent unlock` has to mint a token that an
 * ALREADY-RUNNING server will accept, and no process can inject an environment
 * variable into a running child. The env design's only answer to a lost or
 * expired link is "restart the server", which is exactly what the `unlock`
 * command exists to avoid. `npm run dev` and `npm run start` never go through
 * `serve` at all, so under the env design a contributor could never mint a
 * token in the first place.
 *
 * So: a file, and the tradeoff stated plainly. An env var is readable through
 * `/proc/<pid>/environ` by the same user; a mode-0600 file is readable by the
 * same user too. Neither is better against the adversary this feature stops
 * (something that reaches the port but is not this user), and both are equally
 * useless against the one it does not (code running as this user). What the
 * file costs is lifetime management, and that is answered rather than ignored:
 * only sha256 DIGESTS are ever persisted, so reading this file yields no usable
 * credential; the unlock token expires in ten minutes and burns on first use;
 * expired sessions are pruned on every write.
 *
 * ─── THE .env FOOT-GUN, AND WHY THIS SHAPE CANNOT STEP ON IT ─────────────────
 *
 * `packages/web/next.config.ts` calls `process.loadEnvFile(<repoRoot>/.env)`,
 * and `loadEnvFile` does NOT override an already-set shell variable. Under an
 * env-var design, a stale unlock value committed to somebody's `.env` would arm
 * `npm run dev` with a token nobody printed, and the developer would meet a lock
 * screen they could not pass. This design cannot reach that state, because it
 * reads NOTHING from the environment except the one pre-existing flag
 * (`EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS`, see `isUnlockGateEnabled`). There is no
 * unlock variable for a `.env` to carry.
 *
 * ─── WHY A SERVER-SIDE STORE AND NOT A SIGNED STATELESS COOKIE ───────────────
 *
 * A stateless cookie (`exp` + HMAC) needs a signing key. A key that survives a
 * restart is a file on disk with exactly the mode and lifetime questions the
 * stateless design was supposed to avoid; a key that does not survive a restart
 * logs every open tab out every time the server restarts. Since the unlock token
 * already forces a file (above), "no file" was never on the table — and once the
 * file exists, the store is strictly the better half of the trade: a burn bit
 * that survives an in-place `next dev` reload, a rate limiter shared by every
 * process, real revocation, and sessions that outlive a restart.
 *
 * ─── EVERYTHING HERE IS SYNCHRONOUS, ON PURPOSE ──────────────────────────────
 *
 * `mutationGuardResponse`/`readGuardResponse` in the web package return
 * `Response | undefined`, and roughly twenty route files call them without
 * `await`. An async session check would force every one of those to change
 * shape. `readFileSync` on a few-KB JSON file is the same cost class
 * `loadSettings()` already pays per call, and it buys something the async
 * version could not: `exchangeUnlockToken` performs its whole check-and-burn in
 * one synchronous block with no `await` anywhere inside it, so on a single
 * event loop two concurrent exchanges of the same token cannot both observe it
 * unburned. Do not introduce an `await` into that function.
 *
 * ─── CONCURRENCY, HONESTLY ───────────────────────────────────────────────────
 *
 * Within one process the sequences here are atomic (previous paragraph). ACROSS
 * processes they are read-modify-write over one file with no lock: `email-agent
 * unlock` minting while the server is writing a session can lose one of the two
 * updates. Writes go through `writePrivateFileSync`, which renames a complete
 * temp file over the target, so a reader never sees a half-written store — but a
 * lost update is possible and is not defended against. The realistic trigger is
 * a user running `unlock` in the same second as their own browser exchanging a
 * token, and the failure mode is "run `unlock` again". This is the same class of
 * accepted race the approval queue's enqueue dedupe already documents; do not
 * describe it as atomic, and do not add a lock without a real reason.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { SESSION_PATH } from "./defaults.js";
import { writePrivateFileSync } from "../shared/private-files.js";

// ─── Fixed limits. Deliberately NOT settings.json keys. ──────────────────────
//
// Making these configurable buys nothing under this threat model: anyone who can
// edit `~/.email-agent/settings.json` can already read the OAuth tokens beside
// it. It would also hit two documented traps — a new key under `gmail.*` is
// rebuilt away by `normalizeGmailConfig()`, and a new top-level section stays
// invisible to the settings UI until `sanitizeSettingsForResponse` lists it.

/** How long a printed unlock link stays redeemable. */
export const UNLOCK_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * How long a browser stays unlocked without being used.
 *
 * This is an IDLE timeout, not an absolute cap: `hasValidSession` extends a
 * session that is more than half-expired, so a browser used at least once a day
 * never re-locks, and one left alone for a day does. There is deliberately no
 * absolute ceiling — for a single-user local tool, "log out" is `email-agent
 * unlock`'s job to make cheap, not a deadline's job to force.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The `Max-Age` to put on the cookie, in seconds. DELIBERATELY MUCH LONGER than
 * `SESSION_TTL_MS`, and that is not a mismatch to tidy up.
 *
 * `Max-Age` is enforced by the BROWSER, from the moment the cookie is set, and
 * nothing re-sets it afterwards — the API guard returns `undefined` on a pass
 * and attaches no headers. So a `Max-Age` equal to the idle window would delete
 * the cookie exactly 24 hours after the unlock however heavily the browser was
 * used in between, and the idle renewal below would be dead code: the browser
 * would simply stop sending a value for `hasValidSession` to renew.
 *
 * THE STORE IS THE SOLE AUTHORITY ON VALIDITY. A cookie whose server-side record
 * has expired is inert — its digest matches nothing — so the attribute's only
 * job is to outlive the longest session a user could keep renewing, and to stop
 * a value lingering in a browser profile forever after that. A year does both.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Rolling window over which failed exchange attempts are counted. */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Failed exchanges permitted per window before every attempt is refused. */
export const RATE_LIMIT_MAX_FAILURES = 20;

/**
 * The session cookie's name.
 *
 * Matches the existing `email_agent_oauth_state` convention. It lives in core
 * rather than the web package because TWO enforcement points need it — the API
 * guard, and the server-component page gate — and a second spelling of a cookie
 * name is a silent logout.
 */
export const SESSION_COOKIE_NAME = "email_agent_session";

/**
 * The `code` a 401 carries when the caller simply has no session.
 *
 * Lives here for the same reason the cookie name does: the API guard writes it,
 * and a client interceptor has to branch on it to send the tab to the unlock
 * page. Two spellings of this string is a UI that shows a broken panel instead
 * of a way back in. 403 stays reserved for the host/origin failures — the two
 * must remain distinguishable by status alone.
 */
export const UNLOCK_REQUIRED_CODE = "unlock-required";

/**
 * Every attribute the session cookie is set with, and why it has that value.
 *
 * `httpOnly: true` — the UI never reads this value from JavaScript, and this app
 * renders email HTML (DOMPurify is a dependency for exactly that reason), which
 * is a live XSS surface. Note what this does and does not buy: script on the
 * page still cannot read the bytes, but it can call the app's own APIs and ride
 * the cookie automatically. httpOnly stops exfiltration, not use.
 *
 * `sameSite: "lax"`, NOT `"strict"`, for a reason specific to this app: adding a
 * Gmail account sends the browser to accounts.google.com, which returns as a
 * cross-site TOP-LEVEL NAVIGATION to `GET /api/auth/callback`, which then
 * redirects to `/`. Under `Strict` the browser withholds this cookie on exactly
 * that navigation, so a user would be locked out by a redirect the app told them
 * to follow. `Lax` sends it on top-level GETs — which also covers clicking the
 * printed unlock link out of a terminal — while still withholding it from
 * cross-site subresource loads and cross-site POSTs.
 *
 * `secure: false`, deliberately, and argued rather than copied: a `Secure`
 * cookie is only ever returned over https. Chrome treats `http://localhost` as a
 * secure context and would tolerate it, but that is one browser and one of the
 * two hostnames this server answers on — `http://127.0.0.1` and other engines are
 * not uniformly so. The failure mode of getting it wrong is a cookie the browser
 * stores and never sends back, i.e. a permanent lockout, and the protection
 * bought is against a network eavesdropper who does not exist on loopback.
 * `oauth-state.ts` reached the same conclusion for the same reason. Consequence
 * worth stating: no `__Host-` prefix, because `__Host-` REQUIRES `Secure`.
 *
 * `path: "/"` — the cookie has to reach both `/api/*` (the guards) and the page
 * routes (the gate). This is the one place this deliberately differs from
 * `oauth-state.ts`, which scopes its cookie to the callback path alone.
 *
 * No `Domain` attribute, so the cookie is host-only: `localhost:3847` and
 * `127.0.0.1:3847` hold separate sessions. That is correct — they are different
 * origins to the browser — and it costs one extra unlock if the user switches
 * spelling. Stick to the printed hostname.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: false,
  path: "/",
} as const;

/**
 * Whether the unlock gate applies to this process at all.
 *
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` already means "I meant to expose this"
 * — it turns off the API's local-origin header checks and opens `serve`'s bind —
 * and it turns this off in the same breath. The alternative would leave the LAN
 * browser that flag exists for staring at an unlock screen for a token printed
 * on a machine it cannot see.
 *
 * This is the ONLY environment variable anything in this module reads. There is
 * deliberately no "arming" variable: the gate is on unless this flag says
 * otherwise, whether the server was started by `email-agent serve`, `npm run
 * dev` or `npm run start`. See the module header for why that shape is what
 * makes a stale `.env` harmless.
 */
export function isUnlockGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] !== "1";
}

interface UnlockRecord {
  /** sha256 hex of the plaintext token. The plaintext is never persisted. */
  tokenHash: string;
  expiresAt: number;
  /** Epoch ms of the exchange that burned it, or null while it is still live. */
  usedAt: number | null;
}

interface SessionRecord {
  /** sha256 hex of the plaintext cookie value. The plaintext is never persisted. */
  tokenHash: string;
  expiresAt: number;
}

interface SessionStoreFile {
  version: 1;
  unlock: UnlockRecord | null;
  sessions: SessionRecord[];
  /** Epoch ms of failed exchange attempts, pruned to the window on every write. */
  failures: number[];
}

function emptyStore(): SessionStoreFile {
  return { version: 1, unlock: null, sessions: [], failures: [] };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

/**
 * Constant-time comparison of a presented secret against a stored digest.
 *
 * Hashing the presented value FIRST is what removes the length problem outright:
 * `timingSafeEqual` throws on a length mismatch, so `oauth-state.ts` guards it
 * with an explicit length compare — correct there, but it is a branch on
 * attacker-controlled length. Both operands here are always 32 bytes whatever
 * the caller sends, so there is no branch and no length oracle.
 *
 * Scope it honestly: a timing side channel is not a realistic threat here. The
 * attacker has to already be a process on this machine, loopback jitter is
 * microseconds against nanoseconds of signal, and the comparison is over a
 * digest of the attacker's own input rather than over the secret. This costs one
 * function call and saves the next reader from re-deriving that argument.
 */
function digestMatches(presented: string, storedHashHex: string): boolean {
  if (storedHashHex.length !== 64) return false;
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHashHex, "hex");
  } catch {
    return false;
  }
  if (stored.length !== 32) return false;
  return timingSafeEqual(createHash("sha256").update(presented, "utf-8").digest(), stored);
}

function parseStore(raw: string): SessionStoreFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<SessionStoreFile>;
  if (!Array.isArray(candidate.sessions) || !Array.isArray(candidate.failures)) {
    return null;
  }
  // The `unlock` record is validated as strictly as the arrays, not trusted
  // because the file parsed. A store carrying `unlock: "garbage"` would
  // otherwise reach `digestMatches(token, undefined)` and THROW, turning the
  // documented fail-closed answer (`invalid`) into a 500 from the exchange
  // route — a corrupt store must lock people out, never crash at them.
  const unlock = candidate.unlock;
  const unlockOk =
    typeof unlock === "object" &&
    unlock !== null &&
    typeof (unlock as UnlockRecord).tokenHash === "string" &&
    typeof (unlock as UnlockRecord).expiresAt === "number" &&
    ((unlock as UnlockRecord).usedAt === null ||
      typeof (unlock as UnlockRecord).usedAt === "number");
  return {
    version: 1,
    unlock: unlockOk ? (unlock as UnlockRecord) : null,
    sessions: candidate.sessions.filter(
      (s): s is SessionRecord =>
        typeof s?.tokenHash === "string" && typeof s?.expiresAt === "number",
    ),
    failures: candidate.failures.filter((f): f is number => typeof f === "number"),
  };
}

/**
 * The store as it is on disk, or `null` when it cannot be used.
 *
 * `null` covers three different situations — absent, unreadable, unparsable —
 * and the callers deliberately treat them differently. Reading paths
 * (`hasValidSession`, `exchangeUnlockToken`) FAIL CLOSED: an unusable store means
 * nobody is authenticated, which is the safe direction for an auth store and the
 * opposite of `loadSettings()`, where the safe direction was to refuse rather
 * than fall back to a default that deletes data. The minting path fails OPEN
 * onto a fresh store, because throwing there would break the one command that
 * recovers from a broken store.
 */
function readStore(path: string): SessionStoreFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseStore(raw);
}

function writeStore(path: string, store: SessionStoreFile, nowMs: number): void {
  const pruned: SessionStoreFile = {
    version: 1,
    unlock: store.unlock,
    sessions: store.sessions.filter((s) => s.expiresAt > nowMs),
    failures: store.failures.filter((at) => at > nowMs - RATE_LIMIT_WINDOW_MS),
  };
  writePrivateFileSync(path, JSON.stringify(pruned, null, 2));
}

/** A freshly minted unlock token, and when it stops being redeemable. */
export interface UnlockMint {
  /**
   * The plaintext token. It exists in this process's memory and on its stdout,
   * and nowhere else — only its sha256 is written to disk.
   */
  token: string;
  expiresAt: number;
}

/**
 * Mints a fresh unlock token, replacing any previous one.
 *
 * LIVE SESSIONS ARE PRESERVED. Restarting `serve`, or running `email-agent
 * unlock` because a link was lost, must not log out a browser that is already
 * unlocked — the two are unrelated questions, and silently ending a working
 * session is a surprise nobody asked for.
 *
 * A store that cannot be read or parsed is REPLACED rather than raising. This is
 * the one direction that fails open, and the reason is narrow: `email-agent
 * unlock` is the recovery path, so throwing here would mean a corrupt file
 * leaves the user with no way back in at all. Sessions are lost in that case,
 * which is unavoidable — they were unreadable.
 */
export function mintUnlockToken(nowMs: number = Date.now()): UnlockMint {
  const token = randomBytes(32).toString("base64url");
  const store = readStore(SESSION_PATH) ?? emptyStore();
  const expiresAt = nowMs + UNLOCK_TOKEN_TTL_MS;
  store.unlock = { tokenHash: sha256Hex(token), expiresAt, usedAt: null };
  writeStore(SESSION_PATH, store, nowMs);
  return { token, expiresAt };
}

/** Why an exchange failed, in the terms the unlock screen should report. */
export type UnlockExchangeFailure =
  /** No token on file, or the presented value does not match the one that is. */
  | "invalid"
  /** Matched, but past its ten-minute window. */
  | "expired"
  /** Matched, but a previous exchange already burned it. */
  | "used"
  /** Too many recent failures; nothing was compared. */
  | "rate-limited";

export type UnlockExchangeResult =
  | { ok: true; sessionToken: string; expiresAt: number }
  | { ok: false; reason: UnlockExchangeFailure; retryAfterMs: number };

/**
 * Redeems a printed unlock token for a session token, burning it.
 *
 * ORDER, and each step's reason:
 *  1. rate limit, BEFORE anything is compared, so a flood cannot use the
 *     comparison itself as a timer and a limited caller learns nothing about
 *     validity;
 *  2. constant-time digest compare (`digestMatches`);
 *  3. expiry and burn state, only for a token that matched — a wrong guess must
 *     never learn whether the real token is expired or spent;
 *  4. burn, then mint the session, then ONE write.
 *
 * There is no `await` anywhere in this function, and that is load-bearing rather
 * than incidental: Next 15.5.19 runs route handlers in the same single-threaded
 * process as the router server, so two concurrent exchanges are two tasks on one
 * event loop and only one can observe the token unburned. A caller must not put
 * an `await` between reading a request body and calling this — read the body
 * first, then call this once.
 *
 * The failure reasons are distinguished (`used` vs `expired` vs `invalid`)
 * because the recovery differs and the user has to be told which one to do. What
 * that leaks is that SOME token existed, never which; against a 256-bit random
 * value that is not information worth protecting, and a screen that says
 * "invalid" when the truth is "you already used this" is a support burden.
 */
export function exchangeUnlockToken(
  token: string,
  nowMs: number = Date.now(),
): UnlockExchangeResult {
  const store = readStore(SESSION_PATH);
  if (!store) return { ok: false, reason: "invalid", retryAfterMs: 0 };

  const recentFailures = store.failures.filter((at) => at > nowMs - RATE_LIMIT_WINDOW_MS);
  if (recentFailures.length >= RATE_LIMIT_MAX_FAILURES) {
    const oldest = Math.min(...recentFailures);
    return {
      ok: false,
      reason: "rate-limited",
      retryAfterMs: Math.max(1, oldest + RATE_LIMIT_WINDOW_MS - nowMs),
    };
  }

  const fail = (reason: UnlockExchangeFailure): UnlockExchangeResult => {
    store.failures = [...recentFailures, nowMs];
    writeStore(SESSION_PATH, store, nowMs);
    return { ok: false, reason, retryAfterMs: 0 };
  };

  const unlock = store.unlock;
  if (!unlock || !digestMatches(token, unlock.tokenHash)) return fail("invalid");
  if (unlock.usedAt !== null) return fail("used");
  if (unlock.expiresAt <= nowMs) return fail("expired");

  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = nowMs + SESSION_TTL_MS;
  unlock.usedAt = nowMs;
  store.sessions = [...store.sessions, { tokenHash: sha256Hex(sessionToken), expiresAt }];
  store.failures = recentFailures;
  writeStore(SESSION_PATH, store, nowMs);
  return { ok: true, sessionToken, expiresAt };
}

/**
 * Whether a presented session cookie value is a live session.
 *
 * This is the function BOTH enforcement points call — the API guard on every
 * guarded route, and the server-component page gate. It is synchronous and
 * re-reads the file on every call, for the same reason `loadSettings()` does:
 * Next does not guarantee one module instance per process, so no in-memory
 * cache can be relied on to be the only one, and the file is the single source
 * every instance converges on.
 *
 * IDLE RENEWAL. A session found with less than half its TTL left has its expiry
 * pushed back and the store rewritten, so a browser in daily use never re-locks.
 * That write is BEST-EFFORT and its failure is swallowed: a read-only home
 * directory must not turn a session that is demonstrably valid into a 401. It is
 * bounded to at most one write per session per half-TTL, so it is not a
 * per-request write.
 */
export function hasValidSession(
  cookieValue: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!cookieValue) return false;
  const store = readStore(SESSION_PATH);
  if (!store) return false;

  const match = store.sessions.find(
    (s) => s.expiresAt > nowMs && digestMatches(cookieValue, s.tokenHash),
  );
  if (!match) return false;

  if (match.expiresAt - nowMs < SESSION_TTL_MS / 2) {
    match.expiresAt = nowMs + SESSION_TTL_MS;
    try {
      writeStore(SESSION_PATH, store, nowMs);
    } catch {
      // Renewal is a convenience. The session is valid either way, and saying
      // otherwise because a write failed would lock the user out of a UI they
      // are entitled to.
    }
  }
  return true;
}

/**
 * Ends every session and discards any un-redeemed unlock token.
 *
 * The "log out everywhere" primitive. Not wired to a command yet — it exists so
 * that revocation is a property of this design rather than a thing it lacks, and
 * so a caller does not reach for deleting the file by hand (which would also
 * discard the rate-limit window).
 */
export function revokeAllSessions(nowMs: number = Date.now()): void {
  const store = readStore(SESSION_PATH) ?? emptyStore();
  store.unlock = null;
  store.sessions = [];
  writeStore(SESSION_PATH, store, nowMs);
}
