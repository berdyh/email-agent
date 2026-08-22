/**
 * `ActionChatCard` / `useSendMessage` — streaming generation, and the
 * abort-on-close behaviour M3 asked for "if it can be driven without
 * unreasonable scaffolding."
 *
 * IT CAN BE DRIVEN, but one real environment gap had to be fixed first, not
 * worked around locally: `action-chat-store.ts` is the only store in this
 * repo that uses zustand's `persist` middleware, and `persist` reads
 * `window.localStorage` EXACTLY ONCE, synchronously, at module-import time.
 * Measured on this Node/jsdom combination, `window.localStorage` was
 * `undefined` at that moment (Node 22+ ships its own gated global that
 * shadows jsdom's), so importing this component at all — before this file
 * added anything — threw `Cannot read properties of undefined (reading
 * 'setItem')` the first time any interaction touched the store. A
 * `beforeEach` fix was verified NOT to work (spiked directly: still throws)
 * because it runs after the module has already captured the broken value.
 * The real fix lives in `testing/setup.ts` (point 4), which redefines the
 * property before any test file's own imports run — see its header for the
 * full argument. That fix benefits every future component here that touches
 * a persisted zustand store, not just this one.
 *
 * ALSO NEW: `aria-label="Close"`/`aria-label="Send"` on the two icon-only
 * buttons in `action-chat-card.tsx`. Both were accessible-name-less before
 * this file, which is a real a11y gap independent of testing — this test
 * would otherwise have to pick between two identically-unnamed buttons by
 * DOM position, which is exactly the kind of selector that silently starts
 * clicking the wrong element after an unrelated layout change.
 *
 * STREAMING is driven with a real `ReadableStream`/`Response` — this
 * environment supports both natively, so the SSE parsing in
 * `use-action-chat.ts` is exercised for real rather than faked at a higher
 * level: multiple `pull()` calls, one per chunk, with a real delay between
 * them, so the assertion on the FIRST chunk's text is a genuine mid-stream
 * observation and not a final-state check that merely looks incremental.
 *
 * ABORT-ON-CLOSE is driven by making the fetch mock's promise settle ONLY on
 * the request's `AbortSignal` firing (exactly what `apiFetch` receives), so
 * "closing aborts the request" is proven by the signal actually firing and
 * the fetch promise actually rejecting with it — not inferred from
 * `abortController.abort` having been called.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/testing/render";
import { ActionChatCard } from "./action-chat-card";
import { useActionChatStore } from "@/store/action-chat-store";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

beforeEach(() => {
  // One persisted zustand store, module-level and shared across every test
  // in this file — reset it explicitly rather than relying on unmount.
  useActionChatStore.setState({
    isOpen: true,
    mode: "create",
    editingAction: null,
    messages: [],
    isGenerating: false,
    extractedCode: null,
    expandedCardId: "__create__",
    abortController: null,
  });
  toast.error.mockClear();
  toast.success.mockClear();
});

describe("ActionChatCard — streaming", () => {
  it("renders the assistant's reply progressively, then extracts the code block", async () => {
    const user = userEvent.setup();
    let pullCount = 0;
    let deliverSecondChunk: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          // Delivered on the FIRST read — this is what the "Thinking..."
          // placeholder must turn into.
          controller.enqueue(sseEvent("chunk", { text: "Here you go:\n```ts\n" }));
          return;
        }
        if (pullCount === 2) {
          // Gated on an explicit resolve rather than a bare `setTimeout`: a
          // fixed delay raced `waitFor`'s poll interval under load (measured
          // — flaked when the whole suite ran together, never in isolation),
          // so the mid-stream assertion below sometimes observed the
          // ALREADY-COMPLETE state instead. This makes "second chunk has not
          // landed yet" true by construction until the test says otherwise.
          return new Promise<void>((resolve) => {
            deliverSecondChunk = () => {
              controller.enqueue(sseEvent("chunk", { text: "export const action = {};\n```" }));
              resolve();
            };
          });
        }
        // Deliberately a DIFFERENT full message than the two chunks
        // concatenated (which would read "...action = {};\n```export const
        // action = {};\n```") — the server's `done` event is the source of
        // truth for the final text, not a client-side re-concatenation, and
        // a mutation that drops the `done` handler must fail HERE rather
        // than passing by accident because the two happened to agree.
        controller.enqueue(
          sseEvent("done", { message: "Here you go:\n```ts\nexport const finalAction = {};\n```" }),
        );
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(stream, { status: 200 }))));

    renderWithQuery(<ActionChatCard />);
    await user.type(
      screen.getByPlaceholderText(/describe what you want/i),
      "make a junk filter{Enter}",
    );

    // Mid-stream: the first chunk landed, the second is still gated.
    await waitFor(() => {
      expect(screen.getByText(/here you go/i)).toBeInTheDocument();
    });
    expect(useActionChatStore.getState().isGenerating).toBe(true);
    expect(useActionChatStore.getState().extractedCode).toBeNull();

    await waitFor(() => expect(deliverSecondChunk).toBeDefined());
    deliverSecondChunk!();

    // Streamed to completion.
    await waitFor(
      () => {
        expect(useActionChatStore.getState().isGenerating).toBe(false);
      },
      { timeout: 2000 },
    );
    expect(useActionChatStore.getState().extractedCode).toBe("export const finalAction = {};");
    // The code preview panel only renders once `extractedCode` is set.
    expect(await screen.findByText("Code Preview")).toBeInTheDocument();
  });

  it("shows the server's error and drops the empty placeholder when the stream carries an error event", async () => {
    const user = userEvent.setup();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(sseEvent("error", { error: "the model refused" }));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(stream, { status: 200 }))));

    renderWithQuery(<ActionChatCard />);
    await user.type(screen.getByPlaceholderText(/describe what you want/i), "do a thing{Enter}");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("the model refused"));
    // Nothing streamed in before the error, so the empty assistant
    // placeholder is dropped rather than left as a blank bubble.
    expect(useActionChatStore.getState().messages).toEqual([{ role: "user", content: "do a thing" }]);
    expect(useActionChatStore.getState().isGenerating).toBe(false);
  });
});

describe("ActionChatCard — abort on close", () => {
  it("aborts the in-flight request when the chat is closed mid-generation, and touches nothing else", async () => {
    const user = userEvent.setup();
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        // Settles ONLY when the caller's signal fires — exactly the shape a
        // real in-flight `fetch` has, so "closing aborts it" is proven by
        // the signal actually firing, not inferred from a spy.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject((init.signal as AbortSignal).reason);
          });
        });
      }),
    );

    renderWithQuery(<ActionChatCard />);
    await user.type(screen.getByPlaceholderText(/describe what you want/i), "make one{Enter}");

    await waitFor(() => expect(useActionChatStore.getState().isGenerating).toBe(true));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(false);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    // The request this generation made really was aborted — not merely
    // superseded or ignored.
    await waitFor(() => expect(requests[0]!.signal?.aborted).toBe(true));
    // `close()` already reset the store synchronously; this proves the
    // mutation's OWN cleanup (onSettled) does not fight that reset once the
    // aborted fetch rejects a tick later.
    await waitFor(() => expect(useActionChatStore.getState().isGenerating).toBe(false));
    expect(useActionChatStore.getState().messages).toEqual([]);
    expect(useActionChatStore.getState().abortController).toBeNull();
    // An abort is not a failure: swallowed silently, never toasted.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("starting a second message aborts the first generation instead of racing it", async () => {
    const user = userEvent.setup();
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject((init.signal as AbortSignal).reason);
          });
        });
      }),
    );

    renderWithQuery(<ActionChatCard />);
    const box = screen.getByPlaceholderText(/describe what you want/i);
    await user.type(box, "first attempt{Enter}");
    await waitFor(() => expect(requests).toHaveLength(1));

    // isGenerating blocks a second Enter-submit while the textarea itself is
    // disabled, so the store is driven directly — this is testing what
    // `onMutate` does to a SUPERSEDED generation's controller, not the input
    // gating (already covered by the disabled-textarea rendering). Waiting
    // for the textarea to actually re-enable is what makes the following
    // `user.type` land — a raw store write outside an interaction is not
    // guaranteed to be flushed to the DOM yet.
    useActionChatStore.getState().setGenerating(false);
    await waitFor(() => expect(box).not.toBeDisabled());
    await user.type(box, "second attempt{Enter}");

    await waitFor(() => expect(requests).toHaveLength(2));
    // The FIRST request's signal was aborted by the second's onMutate.
    await waitFor(() => expect(requests[0]!.signal?.aborted).toBe(true));
    expect(requests[1]!.signal?.aborted).toBe(false);
  });

  it("a superseded stream that keeps delivering chunks anyway never writes into the newer conversation", async () => {
    // A REAL fetch ties cancellation to the response stream, so an aborted
    // generation's `reader.read()` stops resolving. This test deliberately
    // does NOT wire the mock streams to their AbortSignal — that decouples
    // "the controller was told to abort" from "the stream stopped
    // producing", which is precisely the gap `isCurrent()` in
    // `use-action-chat.ts`'s read loop exists to cover for the narrow window
    // a real implementation can still hit it in.
    const user = userEvent.setup();
    let firstStreamDeliverSecondChunk: (() => void) | undefined;
    const firstStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          firstStreamDeliverSecondChunk = () => {
            controller.enqueue(sseEvent("chunk", { text: "STALE — must not appear" }));
            controller.close();
            resolve();
          };
        });
      },
    });
    const secondStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(sseEvent("chunk", { text: "current reply" }));
        controller.close();
      },
    });

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++;
        return Promise.resolve(
          new Response(call === 1 ? firstStream : secondStream, { status: 200 }),
        );
      }),
    );

    renderWithQuery(<ActionChatCard />);
    const box = screen.getByPlaceholderText(/describe what you want/i);
    await user.type(box, "first attempt{Enter}");
    // The first stream's `pull()` has run and is now parked, waiting for
    // `firstStreamDeliverSecondChunk`.
    await waitFor(() => expect(firstStreamDeliverSecondChunk).toBeDefined());

    useActionChatStore.getState().setGenerating(false);
    await waitFor(() => expect(box).not.toBeDisabled());
    await user.type(box, "second attempt{Enter}");
    await waitFor(() => expect(useActionChatStore.getState().isGenerating).toBe(false));
    expect(screen.getByText("current reply")).toBeInTheDocument();

    // NOW let the superseded first stream deliver its buffered chunk.
    firstStreamDeliverSecondChunk!();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText(/STALE/)).not.toBeInTheDocument();
    expect(
      useActionChatStore.getState().messages.some((m) => m.content.includes("STALE")),
    ).toBe(false);
  });
});
