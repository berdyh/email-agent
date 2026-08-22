/**
 * `UnlockScreen`, and especially `reason === "binding"` — the RECOVERY case
 * M2 deferred: "a valid cookie with no origin-scoped second factor must read
 * as 'your session is fine, this browser lacks the key tying it to this
 * address', clearly distinguishable from 'no session at all'. Assert it
 * offers a recovery path and is not a dead end."
 *
 * WHAT THIS ASSERTS THE CHOICE OF, NOT THE STRING. The headline/explanation
 * pairing lives in `describeUnlockScreenCopy` (`modules/api/auth-contract.ts`,
 * pinned by its own test) — extracted out of what used to be two inline JSX
 * ternaries specifically so this file can assert the component rendered
 * WHATEVER that function returns for its `reason`, rather than re-pinning the
 * sentences a second place.
 *
 * NOT DRIVEN HERE: a successful submit. `window.location.replace` — the
 * success path's navigation — cannot be redefined in jsdom (measured: the
 * same `TypeError: Cannot redefine property` the harness's own docs record
 * for `.assign`), so this file exercises the FAILURE branches, which is also
 * where `reason="binding"`'s "still recoverable" claim actually needs
 * proving — a user in that state pastes a link and gets a real answer either
 * way, success or failure.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { UnlockScreen } from "./unlock-screen";
import {
  describeUnlockExchangeError,
  describeUnlockScreenCopy,
  UNLOCK_NETWORK_ERROR_MESSAGE,
} from "@/modules/api/auth-contract";
import { jsonResponse } from "@/testing/render";

interface FetchLog {
  url: string;
  body: unknown;
}

function stubFetch(respond: () => Response | Promise<Response>): FetchLog[] {
  const calls: FetchLog[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve(respond());
    }),
  );
  return calls;
}

/** Pastes a value into the token box and submits the form. */
async function pasteAndSubmit(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.type(screen.getByLabelText(/paste the link or token here/i), value);
  await user.click(screen.getByRole("button", { name: /unlock/i }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("not stubbed"))));
});

describe("UnlockScreen — which copy it picks", () => {
  it("renders a plain lockout with the default copy and no extra recovery paragraph", () => {
    render(<UnlockScreen />);
    const expected = describeUnlockScreenCopy(undefined);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(expected.headline);
    expect(expected.recoveryContext).toBeNull();
  });

  it("renders the binding recovery case with ITS OWN copy, distinguishable from a plain lockout", () => {
    render(<UnlockScreen reason="binding" />);
    const plain = describeUnlockScreenCopy(undefined);
    const binding = describeUnlockScreenCopy("binding");

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(binding.headline);
    // Distinguishable from the no-session screen, not merely present.
    expect(heading).not.toHaveTextContent(plain.headline);
    expect(binding.recoveryContext).not.toBeNull();
    expect(screen.getByText(binding.recoveryContext!)).toBeInTheDocument();
  });

  it("offers the SAME recovery path in both cases — reading `binding` is not a dead end", () => {
    const { unmount } = render(<UnlockScreen reason="binding" />);
    // The paste box, the printed-link instructions, and the recovery command
    // are all present exactly as they are for a plain lockout — the binding
    // case explains a DIFFERENT situation but is not stranded by it.
    expect(screen.getByLabelText(/paste the link or token here/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();
    expect(screen.getByText(/npx email-agent unlock/)).toBeInTheDocument();
    unmount();

    render(<UnlockScreen />);
    expect(screen.getByLabelText(/paste the link or token here/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();
    expect(screen.getByText(/npx email-agent unlock/)).toBeInTheDocument();
  });
});

describe("UnlockScreen — submitting a token", () => {
  it("keeps the submit button disabled until there is something to send", async () => {
    const user = userEvent.setup();
    render(<UnlockScreen />);
    const button = screen.getByRole("button", { name: /unlock/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/paste the link or token here/i), "x");
    expect(button).not.toBeDisabled();
  });

  it("sends the extracted token, and shows the coded failure's shared message", async () => {
    const user = userEvent.setup();
    const calls = stubFetch(() =>
      jsonResponse({ error: "nope", code: "token-expired" }, 401),
    );
    render(<UnlockScreen />);

    await pasteAndSubmit(user, "http://127.0.0.1:3847/unlock?exchange=1#token=abc-123");

    await waitFor(() => {
      expect(screen.getByText(describeUnlockExchangeError("token-expired"))).toBeInTheDocument();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/unlock");
    // The FRAGMENT was parsed out, not the raw pasted string.
    expect(calls[0]!.body).toEqual({ token: "abc-123" });
    // Re-enabled after the round trip — not stuck on "Checking…".
    expect(screen.getByRole("button", { name: /^unlock$/i })).not.toBeDisabled();
  });

  it("shows the shared network-error message when fetch itself throws", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    render(<UnlockScreen reason="binding" />);

    await pasteAndSubmit(user, "some-token");

    await waitFor(() => {
      expect(screen.getByText(UNLOCK_NETWORK_ERROR_MESSAGE)).toBeInTheDocument();
    });
  });

  it("shows the store-busy message for a 503, distinct from an invalid-token message", async () => {
    const user = userEvent.setup();
    stubFetch(() => jsonResponse({ error: "busy", code: "store-busy" }, 503));
    render(<UnlockScreen />);

    await pasteAndSubmit(user, "some-token");

    await waitFor(() => {
      expect(screen.getByText(describeUnlockExchangeError("store-busy"))).toBeInTheDocument();
    });
    expect(screen.queryByText(describeUnlockExchangeError("invalid-token"))).toBeNull();
  });
});
