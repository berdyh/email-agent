/**
 * Settings page — three things M3 named explicitly:
 *
 * 1. The auto-apply consent card: the Switch must stay LOCKED (disabled)
 *    until the acknowledgement checkbox is checked, and revoking the
 *    acknowledgement must switch auto-apply back off too — the client-side
 *    mirror of `normalizeAutoApplyConsent`, which is the ONE enforcement
 *    this app has against arming unattended Gmail writes without consent.
 * 2. The retention field's cleared-input case, which must save as
 *    UNTOUCHED (`local.retention` left alone), never as 0 — 0 is a real,
 *    dangerous value ("delete every resolved record") and reading an empty
 *    field as `Number("")` used to write it by accident.
 * 3. The dirty-guard holding an unsaved edit across a background refetch —
 *    `useEffect` only syncs remote settings into local state while the form
 *    is pristine, or a `["settings"]` invalidation from an unrelated account
 *    operation would silently discard whatever the user was mid-typing.
 *
 * `Sidebar` calls `usePathname()` from `next/navigation`, which returns
 * `null` outside a real Next app-router tree and crashes
 * (`pathname.startsWith`) — spiked directly before writing this file. Mocked
 * to a fixed string rather than avoided, since `SettingsPage` renders
 * `Sidebar` unconditionally and there is no page-only fragment to render
 * instead.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse, renderWithQuery } from "@/testing/render";
import { describeRetentionWindow } from "@/modules/api/retention-contract";
import type { SanitizedSettings } from "@/hooks/use-settings";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const SettingsPage = (await import("./page")).default;

function baseSettings(overrides: Partial<SanitizedSettings> = {}): SanitizedSettings {
  return {
    agentMode: "all-agents",
    preferredAgent: "claude",
    gcp: { projectId: "test-project" },
    embedding: { provider: "local", model: "local", dimensions: 384 },
    gmail: { autoApplyActions: false, autoApplyAcknowledged: false },
    prompts: { summary: "", digest: "" },
    ui: { fetchInterval: 300, fetchScope: "unread" },
    retention: { approvalQueueDays: 30 },
    dataDir: "/home/u/.email-agent",
    accounts: [],
    ...overrides,
  };
}

interface FetchLog {
  url: string;
  method: string;
  body: unknown;
}

/** Stubs `/api/settings` (GET/PUT) and `/api/accounts` (GET, always empty). */
function stubApi(settings: SanitizedSettings): { calls: FetchLog[]; setSettings: (s: SanitizedSettings) => void } {
  let current = settings;
  const calls: FetchLog[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/settings" && method === "GET") {
        return Promise.resolve(jsonResponse(current));
      }
      if (url === "/api/settings" && method === "PUT") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === "/api/accounts" && method === "GET") {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return {
    calls,
    setSettings: (s) => {
      current = s;
    },
  };
}

async function openGmailTab(user: ReturnType<typeof userEvent.setup>) {
  // The page renders a loading spinner until `useSettings()` resolves — the
  // tabs (and everything in them) do not exist before that.
  await user.click(await screen.findByRole("button", { name: "Gmail" }));
}

beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
});

describe("Settings — auto-apply consent card", () => {
  it("keeps the switch locked until the acknowledgement is given, and unlocks it once it is", async () => {
    const user = userEvent.setup();
    stubApi(baseSettings());
    renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const toggle = await screen.findByRole("switch", {
      name: /auto-apply action results to gmail/i,
    });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/accept the cautions above to unlock this option/i)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /accept auto-apply cautions/i }));

    expect(toggle).not.toBeDisabled();
    expect(
      screen.getByText(/trash, spam, archive, and label changes are applied to gmail immediately/i),
    ).toBeInTheDocument();
  });

  it("revoking the acknowledgement turns auto-apply back off, not just the checkbox", async () => {
    const user = userEvent.setup();
    stubApi(baseSettings());
    renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const checkbox = await screen.findByRole("checkbox", { name: /accept auto-apply cautions/i });
    await user.click(checkbox); // acknowledge
    const toggle = screen.getByRole("switch", { name: /auto-apply action results to gmail/i });
    await user.click(toggle); // turn auto-apply on

    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(checkbox); // revoke acknowledgement

    expect(toggle).toBeDisabled();
    // The impossible state (acknowledged=false, autoApplyActions=true) must
    // never reach the UI, even transiently.
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  /**
   * The "Auto-apply is currently ON" banner is driven by the SAVED setting,
   * not by the local form state, and this is the only test that proves it.
   *
   * Flipping the switch off does NOT stop the server auto-applying — Save
   * does. A banner sourced from `local` disappears the instant the switch
   * moves, so the page stops warning about a mutation that is still live.
   * That was a shipped bug; verified by mutation that reintroducing it
   * (`settings?.gmail?.autoApplyActions` -> `local?.gmail?...`) left every
   * other test in this file green.
   */
  it("keeps warning that auto-apply is live after the switch is flipped off but not yet saved", async () => {
    const user = userEvent.setup();
    stubApi(
      baseSettings({ gmail: { autoApplyActions: true, autoApplyAcknowledged: true } }),
    );
    renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const live = /auto-apply is currently on/i;
    expect(await screen.findByText(live)).toBeInTheDocument();

    const toggle = screen.getByRole("switch", {
      name: /auto-apply action results to gmail/i,
    });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Nothing has been saved, so Gmail is still being mutated unattended.
    expect(screen.getByText(live)).toBeInTheDocument();
    expect(screen.getByText(/unsaved change/i)).toBeInTheDocument();
  });
});

describe("Settings — retention field", () => {
  it("saves an empty field as UNTOUCHED, never as 0", async () => {
    const user = userEvent.setup();
    const { calls } = stubApi(baseSettings({ retention: { approvalQueueDays: 30 } }));
    renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const input = await screen.findByLabelText(/keep resolved approval records for/i);
    await waitFor(() => expect(input).toHaveValue(30));

    await user.clear(input);

    // The empty-field state is a distinct, explained state — never silently
    // read as 0.
    expect(screen.getByText(describeRetentionWindow(null))).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    // The value from BEFORE the field was cleared survives the save — the
    // clear must not have touched `local.retention` at all.
    expect((put.body as { retention?: { approvalQueueDays: number } }).retention).toEqual({
      approvalQueueDays: 30,
    });
  });

  it("treats 0 as a real, different value from empty", async () => {
    const user = userEvent.setup();
    stubApi(baseSettings());
    renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const input = await screen.findByLabelText(/keep resolved approval records for/i);
    await user.clear(input);
    await user.type(input, "0");

    expect(screen.getByText(describeRetentionWindow(0))).toBeInTheDocument();
    expect(screen.queryByText(describeRetentionWindow(null))).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  });
});

describe("Settings — dirty guard across a refetch", () => {
  it("keeps an unsaved edit on screen when the settings query refetches underneath it", async () => {
    const user = userEvent.setup();
    const api = stubApi(baseSettings({ retention: { approvalQueueDays: 30 } }));
    const { queryClient } = renderWithQuery(<SettingsPage />);
    await openGmailTab(user);

    const input = await screen.findByLabelText(/keep resolved approval records for/i);
    await waitFor(() => expect(input).toHaveValue(30));

    await user.clear(input);
    await user.type(input, "45");
    expect(input).toHaveValue(45);

    // The server now has a DIFFERENT value — as if another tab or an account
    // operation changed it — and something triggers a background refetch.
    api.setSettings(baseSettings({ retention: { approvalQueueDays: 99 } }));
    await queryClient.refetchQueries({ queryKey: ["settings"] });

    // The in-progress edit must survive: a naive `useEffect` that resyncs on
    // every fetch, dirty or not, would show 99 here.
    await waitFor(() => {
      expect(screen.getByLabelText(/keep resolved approval records for/i)).toHaveValue(45);
    });
  });
});
