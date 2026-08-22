/**
 * `StrandedOperationsPanel`, exported alongside `ApprovalPanel` from
 * `approval-panel.tsx` — see that file's header for why the two components
 * live in separate test files.
 *
 * SCOPE. TODOS.md named this panel "never seen populated" and called out two
 * gaps specifically:
 *   - a user told only "we could not check" cannot act, so the six
 *     `VerificationResidualReason` values must each render distinguishably;
 *   - the panel's own verify state (checking / checked / check-failed) used
 *     to collapse a failed check into the same present-tense "is checking"
 *     copy as a check still in flight — fixed in M1, never rendered by a
 *     test until this file.
 *
 * This file also exercises the FOURTH state M1 flagged but did not cover: a
 * row that is listed (it came back from `GET /api/approvals/stranded`) but
 * was never explained by the one check this mount ran, because it went stale
 * after that check's read — see "row that arrives after the check" below.
 *
 * TWO CLAIMS THE AUDIT TRAIL MUST NOT MERGE. `describeVerifyResolution`
 * (Email Agent's own automatic Gmail read, fired once on mount) and
 * `describeStrandedResolution` (a human clicking one of the two adjudication
 * buttons, "on your word") are different functions producing differently
 * worded toasts for a reason: one is a claim Email Agent verified against
 * Gmail itself, the other is a claim a person made that Email Agent did not
 * check. Each test below computes its expectation by calling the SAME
 * function the code path is supposed to use, so a component that used the
 * wrong one for a given path fails the test that covers that path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrandedOperationsPanel } from "./approval-panel";
import { jsonResponse, renderWithQuery } from "@/testing/render";
import {
  describeResidualReason,
  describeStrandedPanelCopy,
  describeStrandedResolution,
  describeVerifyResolution,
  strandedPanelStatus,
  type ResolveStrandedResult,
  type StrandedApprovalsResponse,
  type StrandedOperation,
  type StrandedVerificationResidual,
  type VerificationResidualReason,
  type VerifyStrandedResult,
} from "@/modules/api/approvals-contract";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

function op(id: string, overrides: Partial<StrandedOperation> = {}): StrandedOperation {
  return {
    id,
    batchId: "batch-1",
    actionId: "action-1",
    actionName: "Junk filter",
    accountId: "user@example.com",
    emailId: `email-${id}`,
    type: "trash",
    labelIds: [],
    label: "Trash",
    destructive: true,
    createdAt: "2026-08-20T10:00:00.000Z",
    email: {
      subject: `Subject for ${id}`,
      from: "spam@example.com",
      date: "2026-08-19T09:00:00.000Z",
      snippet: "…",
    },
    claimedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function residual(
  id: string,
  reason: VerificationResidualReason,
  detail: string,
): StrandedVerificationResidual {
  return { id, emailId: `email-${id}`, accountId: "user@example.com", reason, detail };
}

interface FetchLog {
  url: string;
  method: string;
  body: string | undefined;
}

/**
 * Stubs the three endpoints `StrandedOperationsPanel` can call.
 * `verify` and `resolve` accept either a `Response` or a still-pending
 * `Promise<Response>`, so a test can hold the verify call open to observe the
 * "checking" state before letting it settle.
 */
function stubApi(options: {
  operations?: StrandedOperation[];
  thresholdMinutes?: number;
  verify?: () => Response | Promise<Response>;
  resolve?: () => Response | Promise<Response>;
}) {
  const calls: FetchLog[] = [];
  const listResponse: StrandedApprovalsResponse = {
    operations: options.operations ?? [],
    thresholdMinutes: options.thresholdMinutes ?? 15,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url === "/api/approvals/stranded" && method === "GET") {
        return Promise.resolve(jsonResponse(listResponse));
      }
      if (url === "/api/approvals/stranded/verify" && method === "POST") {
        if (options.verify) return Promise.resolve(options.verify());
        throw new Error("unexpected verify request");
      }
      if (url === "/api/approvals/stranded" && method === "POST") {
        if (options.resolve) return Promise.resolve(options.resolve());
        throw new Error("unexpected resolve request");
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
  toast.warning.mockClear();
});

describe("StrandedOperationsPanel", () => {
  it("renders each of the six verification-residual reasons distinguishably, plus a row the check never explained", async () => {
    const reasons: Array<[VerificationResidualReason, string]> = [
      ["message-missing", "Gmail no longer has this message; it may have been deleted."],
      ["credentials", "the refresh token was revoked"],
      ["check-failed", "Gmail returned a 500"],
      ["unverifiable-operation", "an addLabels row with no labels"],
      ["unscoped-account", "this row has no named account, so its match cannot be trusted."],
      ["not-checked", "this row was not covered by this pass."],
    ];
    const ops = reasons.map(([reason], i) => op(`r${i}`, { label: reason }));
    // A seventh row: listed by the GET, but absent from the verify pass's
    // `unresolved` — simulating a row that went stale AFTER this mount's one
    // check ran. It must render the "not checked this session" fallback, not
    // be silently skipped or mis-attributed to another row's reason.
    const freshOp = op("fresh", { label: "Spam" });
    const allOps = [...ops, freshOp];

    const verifyResult: VerifyStrandedResult = {
      checked: ops.length,
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: reasons.map(([reason, detail], i) => residual(`r${i}`, reason, detail)),
    };
    stubApi({
      operations: allOps,
      verify: () => jsonResponse(verifyResult),
    });
    renderWithQuery(<StrandedOperationsPanel />);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    for (const [reason, detail] of reasons) {
      const expectedText = describeResidualReason(reason, detail);
      expect(screen.getByText(expectedText)).toBeInTheDocument();
    }

    // The fresh row's own paragraph — found via its subject, which is unique —
    // must carry the "not checked this session" fallback, never one of the six
    // reason sentences above.
    const freshRow = screen.getByText(freshOp.email!.subject).closest("li");
    expect(freshRow).not.toBeNull();
    expect(within(freshRow!).getByText(/has not checked this one this session/i)).toBeInTheDocument();

    // The header math: 6 of 7 explained.
    const expectedCopy = describeStrandedPanelCopy("checked", {
      totalCount: allOps.length,
      explainedCount: reasons.length,
      checked: verifyResult.checked,
      thresholdMinutes: 15,
    });
    expect(screen.getByText(expectedCopy.headline)).toBeInTheDocument();

    // The mount-time toast is the API-VERIFIED claim, computed by
    // `describeVerifyResolution` — never the human "on your word" wording.
    expect(toast.warning).toHaveBeenCalledWith(describeVerifyResolution(verifyResult)!.message);
  });

  it("shows the pending 'checking' copy while the one-shot verify call is still in flight", async () => {
    const rows = [op("a")];
    const deferred = deferredResponse();
    stubApi({ operations: rows, verify: () => deferred.promise });
    renderWithQuery(<StrandedOperationsPanel />);

    const pendingCopy = describeStrandedPanelCopy(
      strandedPanelStatus({ isSuccess: false, isPending: true, isError: false }),
      { totalCount: rows.length, explainedCount: 0, thresholdMinutes: 15 },
    );
    await waitFor(() => {
      expect(screen.getByText(pendingCopy.headline)).toBeInTheDocument();
    });
    expect(screen.getByText(pendingCopy.description)).toBeInTheDocument();

    // Let it resolve so the mutation settles cleanly before the test ends.
    // The headline text is shared across "checking"/"checked"/"check-failed"
    // when nothing has been explained yet (`${totalCount} Gmail change(s)
    // stuck mid-apply`), so the DESCRIPTION — not the headline — is what
    // proves the panel actually left the pending state.
    deferred.resolve(
      jsonResponse({ checked: 0, appliedRecorded: 0, requeuedRecorded: 0, unresolved: [] }),
    );
    const settledCopy = describeStrandedPanelCopy("checked", {
      totalCount: rows.length,
      explainedCount: 0,
      checked: 0,
      thresholdMinutes: 15,
    });
    await waitFor(() => {
      expect(screen.getByText(settledCopy.description)).toBeInTheDocument();
    });
    expect(screen.queryByText(pendingCopy.description)).toBeNull();
  });

  it("shows the check-failed copy, never the present-tense 'is checking' copy, once the verify call has errored", async () => {
    const rows = [op("a")];
    stubApi({ operations: rows, verify: () => jsonResponse({ error: "network down" }, 500) });
    renderWithQuery(<StrandedOperationsPanel />);

    const failedCopy = describeStrandedPanelCopy("check-failed", {
      totalCount: rows.length,
      explainedCount: 0,
      thresholdMinutes: 15,
    });
    const checkingCopy = describeStrandedPanelCopy("checking", {
      totalCount: rows.length,
      explainedCount: 0,
      thresholdMinutes: 15,
    });

    await waitFor(() => {
      expect(screen.getByText(failedCopy.headline)).toBeInTheDocument();
    });
    expect(screen.getByText(failedCopy.description)).toBeInTheDocument();
    // This is the shipped bug this test exists to keep dead: a failed check
    // must not go on reading "Email Agent is checking Gmail's current state
    // for these now" once the request has actually failed.
    expect(screen.queryByText(checkingCopy.description)).toBeNull();
  });

  it("says nothing and shows the 'nothing was stale' copy when the cheap DB gate finds no stranded rows to check", async () => {
    const rows = [op("a")];
    stubApi({
      operations: rows,
      verify: () =>
        jsonResponse({ checked: 0, appliedRecorded: 0, requeuedRecorded: 0, unresolved: [] }),
    });
    renderWithQuery(<StrandedOperationsPanel />);

    const expectedCopy = describeStrandedPanelCopy("checked", {
      totalCount: rows.length,
      explainedCount: 0,
      checked: 0,
      thresholdMinutes: 15,
    });
    await waitFor(() => {
      expect(screen.getByText(expectedCopy.headline)).toBeInTheDocument();
    });
    expect(screen.getByText(expectedCopy.description)).toBeInTheDocument();
    // `describeVerifyResolution` returns null for `checked: 0` — no toast,
    // per the notify-line rule.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("'I checked Gmail — it happened': confirms with the row's own reason, records the answer on the user's word, and does not touch the row when declined", async () => {
    const user = userEvent.setup();
    const rows = [op("a", { label: "Trash" })];
    const detail = "the refresh token was revoked";
    const verifyResult: VerifyStrandedResult = {
      checked: 1,
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: [residual("a", "credentials", detail)],
    };
    const resolveResult: ResolveStrandedResult = { decision: "applied", requested: 1, resolved: 1, skipped: 0 };
    const calls = stubApi({
      operations: rows,
      verify: () => jsonResponse(verifyResult),
      resolve: () => jsonResponse(resolveResult),
    });
    renderWithQuery(<StrandedOperationsPanel />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    // Declined first: nothing is sent to the server at all.
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: /it happened/i }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain(describeResidualReason("credentials", detail));
    expect(calls.filter((c) => c.url === "/api/approvals/stranded" && c.method === "POST")).toEqual([]);

    // Accepted: the row's id and the "applied" decision are sent, and the
    // toast is the ON-YOUR-WORD wording, not the automatic-verify wording.
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: /it happened/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.url === "/api/approvals/stranded" && c.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)).toEqual({ ids: ["a"], decision: "applied" });
    const expected = describeStrandedResolution(resolveResult);
    expect(expected.message).toContain("on your word");
    expect(toast.success).toHaveBeenCalledWith(expected.message);
    // And distinct from the mount-time verify toast already asserted above.
    expect(toast.success).not.toHaveBeenCalledWith(describeVerifyResolution(verifyResult)!.message);
  });

  it("'I checked Gmail — it didn't' sends the notApplied decision, worded as putting the change back in the queue", async () => {
    const user = userEvent.setup();
    const rows = [op("a")];
    const verifyResult: VerifyStrandedResult = {
      checked: 1,
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: [residual("a", "message-missing", "Gmail no longer has this message.")],
    };
    const resolveResult: ResolveStrandedResult = { decision: "notApplied", requested: 1, resolved: 1, skipped: 0 };
    const calls = stubApi({
      operations: rows,
      verify: () => jsonResponse(verifyResult),
      resolve: () => jsonResponse(resolveResult),
    });
    renderWithQuery(<StrandedOperationsPanel />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /it didn.t/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.url === "/api/approvals/stranded" && c.method === "POST");
    expect(JSON.parse(post!.body!)).toEqual({ ids: ["a"], decision: "notApplied" });
    expect(toast.success).toHaveBeenCalledWith(describeStrandedResolution(resolveResult).message);
  });

  it("a row the check never reached this session uses the fallback explanation in its own confirmation prompt", async () => {
    // Only the "applied" decision's confirmation embeds the reason text (see
    // `handleResolve`'s two branches in the component); "notApplied" does
    // not, so that is the branch this test has to drive to observe it.
    const user = userEvent.setup();
    const rows = [op("fresh")];
    // The verify pass runs and resolves NOTHING for this row — it is absent
    // from `unresolved` entirely, simulating it having gone stale after the
    // pass's read.
    const verifyResult: VerifyStrandedResult = {
      checked: 0,
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: [],
    };
    const resolveResult: ResolveStrandedResult = { decision: "applied", requested: 1, resolved: 1, skipped: 0 };
    const calls = stubApi({
      operations: rows,
      verify: () => jsonResponse(verifyResult),
      resolve: () => jsonResponse(resolveResult),
    });
    renderWithQuery(<StrandedOperationsPanel />);
    await waitFor(() => expect(screen.getByText(/has not checked this one this session/i)).toBeInTheDocument());

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /it happened/i }));

    expect(confirm.mock.calls[0]![0]).toContain("Email Agent has not checked this one this session.");
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/approvals/stranded" && c.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({ ids: ["fresh"], decision: "applied" });
    });
  });
});
