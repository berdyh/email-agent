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

/**
 * Rolling window over which failed exchange attempts are counted.
 *
 * ─── WHAT COUNTS, AND THE ONE RULE THAT DECIDES IT ───────────────────────────
 *
 * **Only an attempt that fails to MATCH the stored digest counts.** That is the
 * whole rule, and everything below follows from it: this limiter exists to make
 * brute-forcing an unknown 256-bit secret pointless for something that can reach
 * the PORT. An attempt whose sha256 matched the record on file has PROVEN
 * POSSESSION of that secret — it is a stale link being clicked twice, not a
 * guess — so counting it throttles nothing an attacker was doing and locks out
 * the person who owns the terminal.
 *
 * It used to count everything, and that was measured to be cheap to trip by
 * accident: nineteen concurrent replays of ONE already-used link (a double-click
 * plus a browser prefetch will do it) exhausted the whole budget, after which
 * `email-agent unlock` — the recovery the "already used" copy explicitly
 * recommends — could not get anybody back in for up to fifteen minutes. A
 * limiter that locks out its own recovery path is not a security control, it is
 * a denial of service with extra steps.
 *
 * So three things clear or skip the window, each on the same possession
 * argument, and one thing does not:
 *  - `mintUnlockToken()` CLEARS it (see that function for why write access to
 *    `~/.email-agent` already beats this whole scheme);
 *  - a successful exchange CLEARS it;
 *  - a matched-but-dead token (`used`, `expired`) neither counts NOR writes;
 *  - an unmatched token still counts at full weight, and the cap is still
 *    checked BEFORE anything is compared, so a hot window refuses even a valid
 *    token and a flooding caller learns nothing about validity.
 *
 * What keeps "uncounted" from being a free probe: the moment a fresh token is
 * minted, the old used one no longer matches the record, so replaying it becomes
 * `invalid` and counts again. There is never a permanently uncounted string.
 */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Unmatched exchange attempts permitted per window before every attempt is refused. */
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
 * The request header carrying the ORIGIN-SCOPED second factor, alongside the
 * session cookie, on every guarded API request.
 *
 * ─── WHY A SECOND FACTOR AT ALL: COOKIES ARE NOT SCOPED BY PORT ──────────────
 *
 * RFC 6265 §8.5 is explicit that cookies provide no isolation by port, and
 * `SESSION_COOKIE_OPTIONS` below spells out the consequence: `127.0.0.1:3847`
 * and `127.0.0.1:9999` share ONE cookie jar. Another local user can bind a
 * sibling loopback port; a cross-site TOP-LEVEL GET to it carries this `Lax`
 * cookie; that server then holds a valid bearer credential it can replay to
 * 3847. `httpOnly` does not help — it stops page script from READING the
 * value, and the thief here is the HTTP server receiving it, not script.
 *
 * ─── WHAT CLOSES IT, AND WHY THIS PARTICULAR STORAGE ─────────────────────────
 *
 * Web storage IS scoped by ORIGIN, and an origin includes the PORT. So a value
 * the unlock exchange writes into the browser's storage for `127.0.0.1:3847`
 * is unreadable from `127.0.0.1:9999`, and a stolen cookie ALONE stops being
 * sufficient. The client echoes it in this header; the guard requires both.
 *
 * `localStorage`, NOT `sessionStorage`, and the choice is argued rather than
 * defaulted. Both are origin-scoped including port, so both defeat the sibling
 * port equally — that is not the discriminator. `sessionStorage` is
 * additionally scoped PER TAB, which buys nothing here (the adversary is
 * another ORIGIN, not another tab) and costs the user a fresh unlock link
 * every time they open a second tab or restart the browser, while the cookie
 * beside it happily survives both. An earlier revision of the comment on
 * `SESSION_COOKIE_OPTIONS` proposed `sessionStorage`; it was written before
 * anyone worked through the two-tab case.
 *
 * ─── WHAT THIS DOES NOT BUY, AND MUST NEVER BE SAID TO ───────────────────────
 *
 * Nothing against code running as THIS user: it reads
 * `~/.email-agent/accounts/{email}/token.json` and calls Gmail directly, never
 * touching this app. Nothing against same-origin XSS either — script on the
 * app's own page reads `localStorage` and could read `sessionStorage` just the
 * same, so this is not a reason to prefer one over the other. It closes
 * exactly one hole: a bearer cookie replayed from a DIFFERENT loopback port.
 *
 * The `x-` prefix is deliberate: a custom header is what makes a cross-origin
 * browser fetch preflight, which the app answers for no other origin.
 */
export const SESSION_BINDING_HEADER = "x-email-agent-session-binding";

/**
 * The `code` a 401 carries when the cookie IS a live session but the
 * origin-scoped second factor is missing or does not match.
 *
 * Deliberately DISTINCT from `UNLOCK_REQUIRED_CODE`, and not folded into it:
 * the two need different copy on the unlock screen, because "you have no
 * session" and "this browser has a session but not for this address" have the
 * same fix but very different explanations — and a user who is told the first
 * when the second is true will reasonably believe the app is broken. Both are
 * 401, so 403 stays reserved for host/origin failures.
 */
export const BINDING_REQUIRED_CODE = "binding-required";

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
 * `127.0.0.1:3847` hold separate sessions, costing one extra unlock if the user
 * switches spelling. Stick to the printed hostname.
 *
 * The REASON for that separation is the host, NOT the origin, and the difference
 * matters. An earlier revision of this comment said "they are different origins
 * to the browser", which reached the right conclusion by the wrong route and hid
 * the consequence below. Cookie scope is (host, path) — RFC 6265 §8.5 states
 * plainly that cookies do NOT provide isolation by PORT. So:
 *   - `localhost` vs `127.0.0.1` — different HOSTS, separate cookie jars. ✓
 *   - `127.0.0.1:3847` vs `127.0.0.1:8080` — SAME host, SAME cookie jar. Another
 *     app listening on any other loopback port receives this cookie on a
 *     top-level navigation the browser makes to it.
 *
 * That last line is a real weak-confidentiality property, and as of 2026-08-22
 * it is CLOSED — by a second factor the cookie cannot carry, not by a cookie
 * attribute, because no cookie attribute can do it (`__Host-` requires `Secure`,
 * see above, and would not add port scoping even so). See
 * `SESSION_BINDING_HEADER`: the exchange issues an opaque value the browser
 * keeps in ORIGIN-scoped `localStorage` (an origin includes the port) and echoes
 * in a custom header, and `checkSessionRequest` requires it alongside the
 * cookie on every guarded API request. A sibling loopback port that captures
 * this cookie therefore holds half a credential.
 *
 * TWO THINGS THAT STAY TRUE and must not be trimmed away as stale. First, the
 * cookie jar is still shared with every other loopback port — the leak is
 * unchanged, what changed is that the leaked value is no longer sufficient on
 * its own. Second, the PAGE gate (`app/(app)/layout.tsx`) still runs on the
 * cookie ALONE and cannot do otherwise, because a top-level navigation carries
 * no custom header; that is safe only because every page under it is a client
 * component with zero server-side data fetching, so the worst a cookie-only
 * pass yields is the static app shell. Enforcement is the API guard.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: false,
  path: "/",
} as const;

/**
 * The gate's off-switch, its wording and its one-per-process announcement live
 * in `../unlock-gate/index.ts` and are re-exported here.
 *
 * WHY THEY ARE NOT IN THIS FILE. This module imports `node:crypto` and
 * `node:fs` at the top. `packages/web/src/instrumentation.ts` — Next's
 * server-startup hook, which is what makes `npm run dev`/`npm run start`
 * announce a disarmed gate at all — is compiled for the EDGE runtime as well as
 * the node one, and webpack traces its dynamic import chain in both. Measured
 * against a real `next dev` (2026-08-22): a chain reaching this file produced
 * `⨯ node:crypto / Module build failed: UnhandledSchemeError` on every start,
 * and a `process.env.NEXT_RUNTIME !== "nodejs"` guard did NOT prevent it —
 * webpack traces the import whatever the branch does at runtime. Splitting the
 * three env-only exports into a module with no `node:` imports is what fixes
 * it; the re-export below is what keeps every existing importer unchanged.
 */
export {
  isUnlockGateEnabled,
  UNLOCK_GATE_DISABLED_LINES,
  warnIfUnlockGateDisabled,
} from "../unlock-gate/index.js";

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
  /**
   * sha256 hex of the ORIGIN-SCOPED second factor issued alongside the cookie.
   * The plaintext is never persisted, exactly like `tokenHash` — see
   * `SESSION_BINDING_HEADER` for what this is for and why the cookie alone is
   * not enough.
   */
  bindingHash: string;
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
    // `bindingHash` is required, which means a session written BEFORE the
    // origin-scoped second factor landed (2026-08-22) is DROPPED here rather
    // than carried forward. That is deliberate: such a record could never
    // satisfy `checkSessionRequest`, so keeping it would only turn a clean
    // "you have no session, click the link" into a confusing third state that
    // says a session exists and then refuses every request it makes. One
    // unlock link recovers it. Failing closed on an auth record is also the
    // direction the rest of this module already takes.
    sessions: candidate.sessions.filter(
      (s): s is SessionRecord =>
        typeof s?.tokenHash === "string" &&
        typeof s?.bindingHash === "string" &&
        typeof s?.expiresAt === "number",
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
 *
 * ─── MINTING CLEARS THE RATE-LIMIT WINDOW, AND THAT GIVES NOTHING AWAY ───────
 *
 * This was a real, measured lockout: exhaust the failure budget (nineteen
 * concurrent replays of one stale link did it), then run `npx email-agent
 * unlock`, and the fresh, valid, ten-minute token came straight back
 * `rate-limited` — for up to fifteen minutes, from the very command the
 * "this link was already used" message tells the user to run.
 *
 * Clearing it here is safe because of WHO CAN REACH THIS FUNCTION. Minting
 * requires WRITE access to `~/.email-agent` (mode 0700), and anything that has
 * that can already read `accounts/{email}/token.json` beside it and call the
 * Gmail API directly, never touching this app, this store or this cookie. So an
 * attacker who can clear the window this way had no need of the window's
 * protection in the first place. The limiter defends against something that can
 * reach the PORT and is guessing an unknown secret; it was never a defence
 * against something that can already write this user's home directory, and
 * pretending otherwise only ever cost the legitimate owner their recovery path.
 *
 * Note what is NOT cleared: live sessions (above) and the burn state of the
 * token being replaced. Only the failure counters go.
 */
export function mintUnlockToken(nowMs: number = Date.now()): UnlockMint {
  const token = randomBytes(32).toString("base64url");
  const store = readStore(SESSION_PATH) ?? emptyStore();
  const expiresAt = nowMs + UNLOCK_TOKEN_TTL_MS;
  store.unlock = { tokenHash: sha256Hex(token), expiresAt, usedAt: null };
  store.failures = [];
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
  | {
      ok: true;
      sessionToken: string;
      /**
       * The ORIGIN-SCOPED second factor, to be handed to the browser in the
       * RESPONSE BODY and kept in `localStorage` — never in a cookie, which is
       * the whole point (see `SESSION_BINDING_HEADER`). Like `sessionToken`
       * this plaintext exists only here and in the browser; the store keeps a
       * sha256.
       */
      bindingToken: string;
      expiresAt: number;
    }
  | { ok: false; reason: UnlockExchangeFailure; retryAfterMs: number };

/**
 * Redeems a printed unlock token for a session token, burning it.
 *
 * ORDER, and each step's reason:
 *  1. rate limit, BEFORE anything is compared, so a flood cannot use the
 *     comparison itself as a timer and a limited caller learns nothing about
 *     validity. This stays first even though a matched token no longer counts
 *     TOWARD the window: an already-hot window refuses everything, and the way
 *     out of a hot window is `mintUnlockToken`, which clears it;
 *  2. constant-time digest compare (`digestMatches`);
 *  3. expiry and burn state, only for a token that matched — a wrong guess must
 *     never learn whether the real token is expired or spent;
 *  4. burn, then mint the session, then ONE write.
 *
 * WHICH FAILURES COUNT: only the ones that did not match (step 2). A token that
 * matched and was merely spent or expired is a stale link, not a guess — see
 * `RATE_LIMIT_WINDOW_MS` for the full argument and for why that cannot become a
 * free probe. Those two paths therefore also write NOTHING: there is nothing to
 * record, and an unauthenticated caller should not be able to drive a disk write
 * per request.
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

  /** A guess at an unknown secret: recorded against the window. */
  const countedFailure = (reason: UnlockExchangeFailure): UnlockExchangeResult => {
    store.failures = [...recentFailures, nowMs];
    writeStore(SESSION_PATH, store, nowMs);
    return { ok: false, reason, retryAfterMs: 0 };
  };

  /**
   * A token that MATCHED but is spent or expired: possession is proven, so this
   * is not brute force and does not belong in the window. No write either — the
   * store is unchanged, and a stale link being re-clicked must not be able to
   * drive disk I/O on an unauthenticated route.
   */
  const uncountedFailure = (reason: UnlockExchangeFailure): UnlockExchangeResult => ({
    ok: false,
    reason,
    retryAfterMs: 0,
  });

  const unlock = store.unlock;
  if (!unlock || !digestMatches(token, unlock.tokenHash)) return countedFailure("invalid");
  if (unlock.usedAt !== null) return uncountedFailure("used");
  if (unlock.expiresAt <= nowMs) return uncountedFailure("expired");

  const sessionToken = randomBytes(32).toString("base64url");
  const bindingToken = randomBytes(32).toString("base64url");
  const expiresAt = nowMs + SESSION_TTL_MS;
  unlock.usedAt = nowMs;
  store.sessions = [
    ...store.sessions,
    { tokenHash: sha256Hex(sessionToken), bindingHash: sha256Hex(bindingToken), expiresAt },
  ];
  // Same possession argument as `mintUnlockToken`: whoever just redeemed the
  // real token is not the caller the window exists to slow down, and leaving
  // their predecessors' failed guesses on file only sets up the next accidental
  // lockout.
  store.failures = [];
  writeStore(SESSION_PATH, store, nowMs);
  return { ok: true, sessionToken, bindingToken, expiresAt };
}

/**
 * Finds the live session a presented cookie value names, or `null`.
 *
 * The ONE lookup behind both `hasValidSession` (the page gate) and
 * `checkSessionRequest` (the API guard). It is one function rather than two
 * because a second copy of "is this cookie live?" is a second predicate that
 * can drift, and the direction it would drift in — one of them accepting a
 * session the other rejects — is a bypass.
 *
 * It re-reads the file on every call, for the same reason `loadSettings()`
 * does: Next does not guarantee one module instance per process, so no
 * in-memory cache can be relied on to be the only one, and the file is the
 * single source every instance converges on.
 *
 * IDLE RENEWAL is the caller's choice, not this function's, and that matters:
 * see `checkSessionRequest` for why a request that presents the cookie WITHOUT
 * the second factor must not be allowed to keep the session alive.
 */
function findLiveSession(
  cookieValue: string | undefined,
  nowMs: number,
): { store: SessionStoreFile; match: SessionRecord } | null {
  if (!cookieValue) return null;
  const store = readStore(SESSION_PATH);
  if (!store) return null;
  const match = store.sessions.find(
    (s) => s.expiresAt > nowMs && digestMatches(cookieValue, s.tokenHash),
  );
  return match ? { store, match } : null;
}

/**
 * Pushes a more-than-half-elapsed session's expiry back, so a browser in daily
 * use never re-locks.
 *
 * BEST-EFFORT, and its failure is swallowed: a read-only home directory must
 * not turn a session that is demonstrably valid into a 401. Bounded to at most
 * one write per session per half-TTL, so it is not a per-request write.
 */
function renewSession(store: SessionStoreFile, match: SessionRecord, nowMs: number): void {
  if (match.expiresAt - nowMs >= SESSION_TTL_MS / 2) return;
  match.expiresAt = nowMs + SESSION_TTL_MS;
  try {
    writeStore(SESSION_PATH, store, nowMs);
  } catch {
    // Renewal is a convenience. The session is valid either way, and saying
    // otherwise because a write failed would lock the user out of a UI they
    // are entitled to.
  }
}

/**
 * Whether a presented session cookie value is a live session — THE COOKIE
 * ALONE, deliberately.
 *
 * This is the PAGE gate's predicate (`app/(app)/layout.tsx`, `app/page.tsx`),
 * and it cannot be anything else: a top-level navigation carries no custom
 * header, so the origin-scoped second factor is simply not available at page
 * render time. Requiring it here would mean nobody could ever load the app.
 *
 * That split is safe for one specific, checkable reason, and if that reason
 * ever stops holding this comment is wrong: every page under `(app)/` is a
 * client component with ZERO server-side data fetching, so the most a
 * cookie-only pass can yield is the static app shell. Every byte of mail,
 * settings and queue data is fetched afterwards, by the browser, through the
 * API guards — which DO require the second factor (`checkSessionRequest`).
 * The page gate is UX; the API guard is the enforcement.
 *
 * The API guard must NOT call this. It calls `checkSessionRequest`.
 */
export function hasValidSession(
  cookieValue: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const found = findLiveSession(cookieValue, nowMs);
  if (!found) return false;
  renewSession(found.store, found.match, nowMs);
  return true;
}

/**
 * What a guarded API request presented: a live session, no session at all, or
 * a live session cookie WITHOUT the matching origin-scoped second factor.
 *
 * The third state is the one that exists on purpose. It is exactly what a
 * sibling loopback port replaying a captured cookie sends (see
 * `SESSION_BINDING_HEADER`), and it is also what an honest browser sends when
 * its `localStorage` has been cleared — the two are indistinguishable from
 * here, so the answer must be one a real user can recover from without being
 * told something false about having no session.
 */
export type SessionCheck = "ok" | "no-session" | "binding-required";

/**
 * The API guard's predicate: the session cookie AND the origin-scoped second
 * factor, both.
 *
 * WHY RENEWAL ONLY ON `"ok"`. `hasValidSession` renews whenever the cookie
 * matches. Doing that here would let a caller holding nothing but a captured
 * cookie keep the session alive indefinitely by replaying it — it would never
 * get data, but it would stop the session from ever idling out from under the
 * thief. Renewing only for a request that also proved same-origin possession
 * means an unaccompanied cookie decays on schedule.
 */
export function checkSessionRequest(
  cookieValue: string | undefined,
  bindingValue: string | undefined,
  nowMs: number = Date.now(),
): SessionCheck {
  const found = findLiveSession(cookieValue, nowMs);
  if (!found) return "no-session";
  if (!bindingValue || !digestMatches(bindingValue, found.match.bindingHash)) {
    return "binding-required";
  }
  renewSession(found.store, found.match, nowMs);
  return "ok";
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
