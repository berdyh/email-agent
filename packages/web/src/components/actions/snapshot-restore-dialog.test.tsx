/**
 * THE PROVING TEST for this repo's component suite, and the first test that has
 * ever rendered a React component here.
 *
 * WHY THIS COMPONENT. It is the smallest one with branching that matters, and
 * every pattern the remaining component tests need is in it: TanStack Query
 * context, a stubbed `fetch`, a `window.confirm` gate on a destructive action,
 * a `sonner` toast, and a dialog that mounts and unmounts. TODOS.md has carried
 * "the 'Versions' snapshot-restore control has never been seen in a browser at
 * all" since it shipped.
 *
 * WHAT IT ASSERTS, AND WHAT IT REFUSES TO ASSERT. The wording lives in
 * `modules/api/snapshot-contract.ts` and is pinned by
 * `snapshot-contract.test.ts`. Re-pinning those strings here would mean every
 * copy edit breaks two tests, and the second one teaches people to update a
 * test without reading it. So this file computes what it expects by CALLING
 * `describeSnapshotAge` / `describeSnapshotRestoreFailure` and asserts that the
 * component picked the right one for the state it is in — which is the half
 * that reading the file cannot verify.
 *
 * The branch that matters most is the last one: a source-guard refusal must
 * reach the user AS THE RULES IT BROKE, one per line, not as a generic
 * failure. The CLI has always printed them; the web surface degrading that to
 * "Failed to restore" is the shipped bug this contract exists to prevent, and
 * until now nothing rendered the component to check that the toast actually
 * carries them.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapshotRestoreDialog } from "./snapshot-restore-dialog";
import { jsonResponse, renderWithQuery } from "@/testing/render";
import {
  describeSnapshotAge,
  describeSnapshotRestoreFailure,
  type SnapshotEntryDto,
} from "@/modules/api/snapshot-contract";

// `vi.mock` is hoisted above the imports, so the spies have to be hoisted with
// it. Mocking `sonner` rather than rendering a `<Toaster/>`: what is under test
// is WHICH message the component chooses, not how sonner paints it.
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const FILENAME = "junk.action.ts";
const ACTION_NAME = "Junk filter";

const SNAPSHOTS: SnapshotEntryDto[] = [
  {
    filename: "junk.action.ts.2026-08-20T10:00:00.000Z.bak",
    timestamp: "2026-08-20T10:00:00.000Z",
    snapshotPath: "/home/u/.email-agent/actions/.snapshots/junk-1",
  },
  {
    filename: "junk.action.ts.2026-08-19T10:00:00.000Z.bak",
    timestamp: "2026-08-19T10:00:00.000Z",
    snapshotPath: "/home/u/.email-agent/actions/.snapshots/junk-2",
  },
];

const VIOLATIONS = [
  { rule: "no-call-expression", detail: "`buildPrompt()` runs at import time" },
  { rule: "no-member-access", detail: "`process.env` is not a literal" },
];

interface FetchLog {
  url: string;
  method: string;
  body: string | undefined;
}

/**
 * Stubs `globalThis.fetch` for the two requests this component makes, and
 * records them. `setup.ts` installs a fetch that throws, so a request this
 * function does not know about fails by name rather than escaping.
 */
function stubApi(options: { snapshots?: SnapshotEntryDto[]; restore: () => Response }) {
  const calls: FetchLog[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.startsWith("/api/actions/user/snapshots") && method === "GET") {
        return Promise.resolve(jsonResponse(options.snapshots ?? []));
      }
      if (url === "/api/actions/user/snapshots" && method === "POST") {
        return Promise.resolve(options.restore());
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

/** Renders and clicks "Versions", which is the only way the dialog opens. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithQuery(<SnapshotRestoreDialog filename={FILENAME} actionName={ACTION_NAME} />);
  await user.click(screen.getByRole("button", { name: /versions/i }));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
});

describe("SnapshotRestoreDialog", () => {
  it("does not ask the server for versions until the dialog is opened", async () => {
    // The actions page renders every action at once; the `enabled` flag on the
    // query is what stops that being one request per card on every page load.
    const calls = stubApi({ restore: () => jsonResponse({ success: true }) });
    renderWithQuery(<SnapshotRestoreDialog filename={FILENAME} actionName={ACTION_NAME} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    // Give a stray query a tick to fire before concluding none did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it("tells a user with no saved versions how versions get made, and offers nothing to restore", async () => {
    const user = userEvent.setup();
    stubApi({ snapshots: [], restore: () => jsonResponse({ success: true }) });
    const dialog = await openDialog(user);

    await waitFor(() => {
      expect(within(dialog).getByText(/no previous versions/i)).toBeInTheDocument();
    });
    expect(within(dialog).queryByRole("button", { name: /restore/i })).toBeNull();
  });

  it("labels each version with the age the contract computes for it", async () => {
    const user = userEvent.setup();
    stubApi({ snapshots: SNAPSHOTS, restore: () => jsonResponse({ success: true }) });
    const dialog = await openDialog(user);

    await waitFor(() => {
      expect(within(dialog).getAllByRole("button", { name: /restore/i })).toHaveLength(
        SNAPSHOTS.length,
      );
    });
    // The wording is `describeSnapshotAge`'s and is pinned by its own test; what
    // is checked here is that each ROW gets the label for ITS OWN timestamp.
    for (const snapshot of SNAPSHOTS) {
      const row = within(dialog).getByText(snapshot.filename).closest("li");
      expect(row).not.toBeNull();
      expect(row).toHaveTextContent(describeSnapshotAge(snapshot.timestamp));
    }
    expect(within(dialog).queryByText(/no previous versions/i)).toBeNull();
  });

  it("sends nothing when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const calls = stubApi({ snapshots: SNAPSHOTS, restore: () => jsonResponse({ success: true }) });
    // jsdom's own `confirm` is a not-implemented no-op returning `undefined`,
    // so an unstubbed test would take this branch by accident and prove
    // nothing. Stub it explicitly, both ways round.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const dialog = await openDialog(user);

    await waitFor(() => within(dialog).getAllByRole("button", { name: /restore/i }));
    await user.click(within(dialog).getAllByRole("button", { name: /restore/i })[0]!);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("restores the version that was clicked, and says so", async () => {
    const user = userEvent.setup();
    const calls = stubApi({ snapshots: SNAPSHOTS, restore: () => jsonResponse({ success: true }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const dialog = await openDialog(user);

    await waitFor(() => within(dialog).getAllByRole("button", { name: /restore/i }));
    // The SECOND row, so a component that restored `snapshots[0]` regardless of
    // which button was pressed would fail here.
    await user.click(within(dialog).getAllByRole("button", { name: /restore/i })[1]!);

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const post = calls.find((call) => call.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)).toEqual({
      snapshotFilename: SNAPSHOTS[1]!.filename,
      originalFilename: FILENAME,
    });
    // A successful restore closes the dialog; leaving it open on a list that is
    // now stale is what the `setOpen(false)` in the component is for.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("renders a source-guard refusal as the rules it broke, not as a generic failure", async () => {
    const user = userEvent.setup();
    const body = { error: "unsafe action source", violations: VIOLATIONS };
    stubApi({ snapshots: SNAPSHOTS, restore: () => jsonResponse(body, 422) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const dialog = await openDialog(user);

    await waitFor(() => within(dialog).getAllByRole("button", { name: /restore/i }));
    await user.click(within(dialog).getAllByRole("button", { name: /restore/i })[0]!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // Computed, never pasted: `snapshot-contract.test.ts` owns these strings.
    const failure = describeSnapshotRestoreFailure(422, body);
    const [title, options] = toast.error.mock.calls[0] as [string, { description?: string }];
    expect(title).toBe(failure.title);
    // One rule per line — a `join(", ")` or a bare title would lose them.
    expect(options?.description).toBe(failure.details.join("\n"));
    expect(options?.description?.split("\n")).toHaveLength(VIOLATIONS.length + 1);

    expect(toast.success).not.toHaveBeenCalled();
    // A refusal is not a success: the dialog stays open so the user can pick a
    // different version.
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
