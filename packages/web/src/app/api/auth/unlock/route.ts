import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeUnlockToken,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@email-agent/core/config";
import {
  internalErrorResponse,
  parseJsonBody,
  parseUnlockExchangeRequest,
  unlockExchangeGuardResponse,
  validationResponse,
} from "@/modules/api/validation";
import { describeUnlockExchangeError, unlockExchangeErrorCode } from "@/modules/api/auth-contract";

/**
 * Redeems a one-time unlock token (printed by `email-agent serve`/`email-agent
 * unlock`) for a session cookie.
 *
 * DELIBERATELY UNGUARDED BY `mutationGuardResponse`/`readGuardResponse` — see
 * `unlockExchangeGuardResponse`'s doc comment for why, and
 * `route-guards.test.ts`'s `EXEMPT` entry for the checked property that this
 * route actually calls it rather than running with no guard at all.
 *
 * ORDER MATTERS: the body is read to completion (`await parseJsonBody`) and
 * THEN `exchangeUnlockToken` is called once, with nothing awaited in between.
 * `exchangeUnlockToken`'s own header explains why that closes the concurrent-
 * double-exchange race down to "narrowed", never "impossible" — Next runs
 * this handler in the same single-threaded process as the router server, so
 * two concurrent exchanges are two tasks on one event loop and only one can
 * observe the token unburned, PROVIDED neither call has an `await` between
 * reading the body and calling the store. Do not add one.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const guard = unlockExchangeGuardResponse(request);
  if (guard) return guard;

  let token: string;
  try {
    const body = await parseJsonBody(request);
    ({ token } = parseUnlockExchangeRequest(body));
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;
    return internalErrorResponse(err, "Failed to read the unlock request");
  }

  // NOTHING awaited between here and the store call — see the header above.
  const result = exchangeUnlockToken(token);

  if (!result.ok) {
    if (result.reason === "rate-limited") {
      return NextResponse.json(
        {
          // Through `describeUnlockExchangeError`, not a second literal: that
          // function exists so the JSON `error` this route returns and the
          // copy the unlock page renders for the same code cannot say two
          // different things, and this branch was quietly the one place that
          // hand-wrote its own.
          error: describeUnlockExchangeError("rate-limited"),
          code: "rate-limited",
          retryAfterMs: result.retryAfterMs,
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
        },
      );
    }
    const code = unlockExchangeErrorCode(result.reason);
    return NextResponse.json(
      { error: describeUnlockExchangeError(code), code },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, result.sessionToken, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
