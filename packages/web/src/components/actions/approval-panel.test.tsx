/**
 * `ApprovalPanel` — the panel TODOS.md said was "never seen populated": no
 * Gmail account on the machine that did the manual pass meant the queue was
 * always empty, so every checkbox, the review dialog, the destructive-change
 * confirmation and the outcome toasts were unobserved in a browser and
 * unreachable by any test.
 *
 * `StrandedOperationsPanel` — the sibling exported from this same file — has
 * its own test file, `stranded-operations-panel.test.tsx`. Splitting them
 * keeps each file's fixtures scoped to the mutation it is actually testing.
 *
 * WHAT THIS FILE DOES NOT RE-ASSERT. `groupOperationsByBatch` has its own
 * test in `modules/api/approvals-contract.test.ts`; this file only checks
 * that the component renders more than one batch header, not the grouping
 * algorithm itself. `describeApplyOutcome`/`describeRejectOutcome` wording is
 * pinned there too — this file calls those functions to compute what it
 * expects and asserts the component chose that result, never a pasted string.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalPanel } from "./approval-panel";
import { jsonResponse, renderWithQuery } from "@/testing/render";
import {
  describeApplyOutcome,
  describeRejectOutcome,
  type ApprovalOperation,
  type ApprovalsResponse,
} from "@/modules/api/approvals-contract";
import type { EmailDetail } from "@/hooks/use-email-detail";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const OP_TRASH: ApprovalOperation = {
  id: "op-trash",
  batchId: "batch-junk",
  actionId: "action-junk",
  actionName: "Junk filter",
  accountId: "user@example.com",
  emailId: "email-trash",
  type: "trash",
  labelIds: [],
  label: "Trash",
  destructive: true,
  createdAt: "2026-08-20T10:00:00.000Z",
  email: {
    subject: "Buy now, act fast!!!",
    from: "spam@example.com",
    date: "2026-08-19T09:00:00.000Z",
    snippet: "limited time offer",
  },
};

const OP_READ: ApprovalOperation = {
  id: "op-read",
  batchId: "batch-junk",
  actionId: "action-junk",
  actionName: "Junk filter",
  accountId: "user@example.com",
  emailId: "email-read",
  type: "markRead",
  labelIds: [],
  label: "Mark read",
  destructive: false,
  createdAt: "2026-08-20T10:00:00.000Z",
  email: {
    subject: "Weekly newsletter",
    from: "news@example.com",
    date: "2026-08-19T08:00:00.000Z",
    snippet: "this week in...",
  },
};

const OP_ARCHIVE: ApprovalOperation = {
  id: "op-archive",
  batchId: "batch-priority",
  actionId: "action-priority",
  actionName: "Priority sort",
  accountId: "user@example.com",
  emailId: "email-archive",
  type: "archive",
  labelIds: [],
  label: "Archive",
  destructive: false,
  createdAt: "2026-08-21T10:00:00.000Z",
  email: {
    subject: "Your receipt",
    from: "billing@example.com",
    date: "2026-08-20T08:00:00.000Z",
    snippet: "thanks for your purchase",
  },
};

const THREE_OPS = [OP_TRASH, OP_READ, OP_ARCHIVE];

interface FetchLog {
  url: string;
  method: string;
  body: string | undefined;
}

/**
 * Stubs the three endpoints `ApprovalPanel` can call. `apply`/`reject`
 * default to a fetch that fails loudly by name, so a test exercising only one
 * of the two never silently exercises the other by accident.
 */
function stubApi(options: {
  operations?: ApprovalOperation[];
  emailDetail?: (emailId: string) => Response;
  apply?: () => Response;
  reject?: () => Response;
}) {
  const calls: FetchLog[] = [];
  const response: ApprovalsResponse = {
    operations: options.operations ?? THREE_OPS,
    pendingCount: (options.operations ?? THREE_OPS).length,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url === "/api/approvals" && method === "GET") {
        return Promise.resolve(jsonResponse(response));
      }
      if (url.startsWith("/api/gmail/") && method === "GET") {
        const emailId = decodeURIComponent(url.split("/api/gmail/")[1]!.split("?")[0]!);
        if (options.emailDetail) return Promise.resolve(options.emailDetail(emailId));
        throw new Error(`unexpected email detail request: ${url}`);
      }
      if (url === "/api/approvals/apply" && method === "POST") {
        if (options.apply) return Promise.resolve(options.apply());
        throw new Error("unexpected apply request");
      }
      if (url === "/api/approvals/reject" && method === "POST") {
        if (options.reject) return Promise.resolve(options.reject());
        throw new Error("unexpected reject request");
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

/** Renders `ApprovalPanel` against the stubbed API and waits for the queue to appear. */
async function renderPopulated(options: Parameters<typeof stubApi>[0] = {}) {
  const calls = stubApi(options);
  renderWithQuery(<ApprovalPanel />);
  await waitFor(() => {
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
  });
  return calls;
}

afterEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
  toast.warning.mockClear();
});

describe("ApprovalPanel", () => {
  it("renders the populated queue grouped by batch, with every row's checkbox ticked on first load", async () => {
    await renderPopulated();

    // Two batches, two headers — the grouping itself is `groupOperationsByBatch`'s
    // job and is unit-tested; what matters here is that the component actually
    // renders more than a flat list.
    expect(screen.getByText("Junk filter")).toBeInTheDocument();
    expect(screen.getByText("Priority sort")).toBeInTheDocument();

    expect(screen.getByText(OP_TRASH.email!.subject)).toBeInTheDocument();
    expect(screen.getByText(OP_READ.email!.subject)).toBeInTheDocument();
    expect(screen.getByText(OP_ARCHIVE.email!.subject)).toBeInTheDocument();

    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    }
    expect(
      screen.getByRole("button", { name: /Apply selected \(3\)/ }),
    ).toBeInTheDocument();
  });

  it("unchecking one row lowers the selected count and leaves the others ticked", async () => {
    const user = userEvent.setup();
    await renderPopulated();

    const readCheckbox = screen.getByRole("checkbox", {
      name: new RegExp(`Select Mark read for ${OP_READ.email!.subject}`),
    });
    await user.click(readCheckbox);

    expect(readCheckbox).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Trash for ${OP_TRASH.email!.subject}`),
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Archive for ${OP_ARCHIVE.email!.subject}`),
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("button", { name: /Apply selected \(2\)/ }),
    ).toBeInTheDocument();
  });

  it("opens the review dialog with the clicked row's own email content", async () => {
    const user = userEvent.setup();
    const detail: EmailDetail = {
      id: OP_READ.emailId,
      accountId: OP_READ.accountId,
      threadId: "thread-1",
      from: "news@example.com",
      to: "user@example.com",
      subject: "Weekly newsletter — fetched detail",
      date: "2026-08-19T08:00:00.000Z",
      bodyText: "Full body of the newsletter.",
      bodyHtml: "<p>Full body</p>",
      labels: "INBOX",
      isUnread: true,
      snippet: "this week in...",
    };
    await renderPopulated({
      emailDetail: (emailId) =>
        emailId === OP_READ.emailId
          ? jsonResponse(detail)
          : jsonResponse({ error: "not stubbed" }, 500),
    });

    await user.click(screen.getByText(OP_READ.email!.subject));

    const dialog = await screen.findByRole("dialog");
    // The dialog title comes from the FETCHED detail, not the summary already
    // in the queue row — proves it is really asking the server, not just
    // echoing what it already had.
    expect(within(dialog).getByText(detail.subject)).toBeInTheDocument();
    expect(within(dialog).getByText(detail.bodyText)).toBeInTheDocument();
    expect(within(dialog).getByText(/news@example\.com/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reports a failed email load in the review dialog instead of the email content", async () => {
    const user = userEvent.setup();
    await renderPopulated({
      emailDetail: () => jsonResponse({ error: "gone" }, 404),
    });

    await user.click(screen.getByText(OP_TRASH.email!.subject));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByText(/couldn.t load this email/i)).toBeInTheDocument();
    });
  });

  it("asks for confirmation before applying a selection that includes a destructive change, and sends nothing when declined", async () => {
    const user = userEvent.setup();
    const calls = await renderPopulated({ apply: () => jsonResponse({ ok: true }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await user.click(screen.getByRole("button", { name: /Apply selected/ }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === "/api/approvals/apply")).toEqual([]);
  });

  it("sends exactly the selected ids once the destructive confirmation is accepted, and shows the outcome toast", async () => {
    const user = userEvent.setup();
    const result = { applied: 3, failed: 0, errors: [], outcomes: [], requested: 3, skipped: 0 };
    const calls = await renderPopulated({ apply: () => jsonResponse(result) });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: /Apply selected \(3\)/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.url === "/api/approvals/apply");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)).toEqual({
      ids: [OP_TRASH.id, OP_READ.id, OP_ARCHIVE.id],
    });
    const expected = describeApplyOutcome(result);
    expect(toast.success).toHaveBeenCalledWith(expected.message);
  });

  it("skips the confirmation entirely when nothing selected is destructive", async () => {
    const user = userEvent.setup();
    const result = { applied: 2, failed: 0, errors: [], outcomes: [], requested: 2, skipped: 0 };
    const calls = await renderPopulated({ apply: () => jsonResponse(result) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    // Deselect the one destructive row; the two left selected are both benign.
    await user.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Trash for ${OP_TRASH.email!.subject}`),
      }),
    );
    await user.click(screen.getByRole("button", { name: /Apply selected \(2\)/ }));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/approvals/apply");
      expect(post).toBeDefined();
      expect(JSON.parse(post!.body!)).toEqual({ ids: [OP_READ.id, OP_ARCHIVE.id] });
    });
  });

  it("renders an error-toned toast when the apply outcome reports a failure", async () => {
    const user = userEvent.setup();
    const result = { applied: 2, failed: 1, errors: [{ emailId: "x", error: "boom" }], outcomes: [], requested: 3, skipped: 0 };
    await renderPopulated({ apply: () => jsonResponse(result) });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: /Apply selected \(3\)/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const expected = describeApplyOutcome(result);
    expect(expected.tone).toBe("error");
    expect(toast.error).toHaveBeenCalledWith(expected.message);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("rejects only the checked ids without asking for confirmation", async () => {
    const user = userEvent.setup();
    const result = { rejected: 2, requested: 2, skipped: 0 };
    const calls = await renderPopulated({ reject: () => jsonResponse(result) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await user.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Archive for ${OP_ARCHIVE.email!.subject}`),
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Reject selected$/ }));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.url === "/api/approvals/reject");
    expect(JSON.parse(post!.body!)).toEqual({ ids: [OP_TRASH.id, OP_READ.id] });
    expect(toast.success).toHaveBeenCalledWith(describeRejectOutcome(result).message);
  });

  it("'Reject all' confirms first and submits every operation id, ignoring the current selection", async () => {
    const user = userEvent.setup();
    const result = { rejected: 3, requested: 3, skipped: 0 };
    const calls = await renderPopulated({ reject: () => jsonResponse(result) });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    // Deselect one row first, so a bug that submits only the selection would
    // be visible as a shorter id list.
    await user.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Mark read for ${OP_READ.email!.subject}`),
      }),
    );
    await user.click(screen.getByRole("button", { name: /Reject all/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.url === "/api/approvals/reject");
    expect(JSON.parse(post!.body!)).toEqual({
      ids: [OP_TRASH.id, OP_READ.id, OP_ARCHIVE.id],
    });
  });

  it("'Reject all' sends nothing when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const calls = await renderPopulated({ reject: () => jsonResponse({ rejected: 3, requested: 3, skipped: 0 }) });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await user.click(screen.getByRole("button", { name: /Reject all/ }));

    expect(calls.filter((c) => c.url === "/api/approvals/reject")).toEqual([]);
  });

  /**
   * Selection is default-DENY, and this is the only test that proves it.
   *
   * The first render of the queue arrives ticked, so the common case is one
   * click — but a row that shows up LATER (a background refetch after another
   * action run, a window-focus refetch) must arrive UNTICKED, or a bulk Apply
   * reaches a Gmail change the user has never looked at. Verified by mutation:
   * replacing the effect's `prev.has(id) || (isFirstLoad && !seen.has(id))`
   * with an unconditional `next.add(id)` left every other test in this file
   * green, which is why this one exists.
   */
  it("leaves a row that arrived on a background refetch UNTICKED, so a bulk apply cannot reach it", async () => {
    let operations = [OP_TRASH, OP_READ];
    const calls: FetchLog[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: init?.body as string | undefined });
        if (url === "/api/approvals" && method === "GET") {
          return Promise.resolve(
            jsonResponse({ operations, pendingCount: operations.length }),
          );
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    const { queryClient } = renderWithQuery(<ApprovalPanel />);
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });
    expect(
      screen.getByRole("button", { name: /Apply selected \(2\)/ }),
    ).toBeInTheDocument();

    // A third proposal arrives while the user is looking at the page.
    operations = [OP_TRASH, OP_READ, OP_ARCHIVE];
    await queryClient.refetchQueries({ queryKey: ["approvals"] });

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    });
    const arrived = screen.getByRole("checkbox", {
      name: new RegExp(`Select Archive for ${OP_ARCHIVE.email!.subject}`),
    });
    expect(arrived).toHaveAttribute("aria-checked", "false");
    // The two the user HAS seen keep their tick, and the count never grew.
    expect(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select Trash for ${OP_TRASH.email!.subject}`),
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("button", { name: /Apply selected \(2\)/ }),
    ).toBeInTheDocument();
  });
});
