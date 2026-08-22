import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { useActionChatStore, type ChatMessage } from "@/store/action-chat-store";
import { toast } from "sonner";

interface SaveRequest {
  filename: string;
  content: string;
}

interface ActionSourceResponse {
  filename: string;
  source: string;
}

/** Extract the first TypeScript/JS code block from agent response. */
function extractCode(text: string): string | null {
  const match = text.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/);
  return match?.[1]?.trim() ?? null;
}

/**
 * Best-effort id guess for a suggested filename ONLY — cosmetic, not an
 * identity or security decision.
 *
 * This is deliberately a bare regex, not a parser: no AST evaluator is
 * available client-side, and this value is never used to decide anything.
 * The result seeds an editable `<Input>` the user can retype before Save
 * (`action-chat-card.tsx`), so a wrong guess costs nothing but the default
 * text in a text box. Post-fix, the built-in-conflict check on save reads
 * identity from core's `extractActionData()` (`app/api/actions/user/route.ts`),
 * and list/load identity always comes from `readUserActionFiles()` in core —
 * never from this guess or from the filename. Do not export this as
 * `extractActionId` again or rewire it into a security decision; that name
 * implied an authority this helper never actually had.
 */
function bestEffortIdGuess(code: string): string | null {
  const match = code.match(/id:\s*["'`]([^"'`]+)["'`]/);
  return match?.[1] ?? null;
}

/** Derive a filename from action ID in code, or from user message. */
export function deriveFilename(code: string): string {
  const actionId = bestEffortIdGuess(code);
  return actionId ? `${actionId}.action.ts` : "new-action.action.ts";
}

/** Parse SSE events from a text chunk. Returns parsed events and any remaining partial data. */
function parseSSEEvents(
  buffer: string,
): { events: Array<{ event: string; data: string }>; remaining: string } {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split("\n\n");
  // Last element may be a partial block
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let event = "";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }
    if (event && data) {
      events.push({ event, data });
    }
  }

  return { events, remaining };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function useSendMessage() {
  const { messages, mode, editingAction } = useActionChatStore();

  return useMutation<void, Error, string, { controller: AbortController }>({
    mutationFn: async (userMessage) => {
      // onMutate created and stored a fresh controller for this generation.
      const controller = useActionChatStore.getState().abortController;
      const signal = controller?.signal;
      const store = useActionChatStore.getState();

      // Stop writing into whatever conversation is now open once this
      // generation is no longer the active one (chat closed / another opened).
      const isCurrent = () =>
        useActionChatStore.getState().abortController === controller;

      try {
        const newMessages: ChatMessage[] = [...messages, { role: "user", content: userMessage }];

        let currentCode: string | undefined;
        if (mode === "edit" && editingAction) {
          const srcRes = await apiFetch(
            `/api/actions/user?filename=${encodeURIComponent(editingAction.filename)}`,
            { signal },
          );
          // The agent must see the existing source to edit it; failing loudly
          // routes through onError instead of silently rewriting from scratch.
          if (!srcRes.ok) {
            throw new Error("Failed to read action source for editing");
          }
          const data = (await srcRes.json()) as ActionSourceResponse;
          currentCode = data.source;
        }

        const res = await apiFetch("/api/actions/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: newMessages, mode, currentCode }),
          signal,
        });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(errBody?.error ?? "Failed to generate action");
        }
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!isCurrent()) return;

          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEEvents(buffer);
          buffer = remaining;

          for (const evt of events) {
            if (evt.event === "chunk") {
              const parsed = JSON.parse(evt.data) as { text: string };
              fullText += parsed.text;
              store.appendToLastMessage(parsed.text);
            } else if (evt.event === "done") {
              const parsed = JSON.parse(evt.data) as { message: string };
              fullText = parsed.message;
            } else if (evt.event === "error") {
              const parsed = JSON.parse(evt.data) as { error: string };
              throw new Error(parsed.error);
            }
          }
        }

        if (!isCurrent()) return;
        // Extract code from the complete response
        const code = extractCode(fullText);
        if (code) {
          store.setExtractedCode(code);
        }
      } catch (err) {
        // Aborts are intentional (chat closed / superseded) — swallow them
        // without touching state so the newer conversation is left untouched.
        if (isAbortError(err)) return;
        throw err;
      }
    },
    onMutate: (userMessage) => {
      const store = useActionChatStore.getState();
      // Abort any in-flight generation before starting a new one.
      store.abortController?.abort();
      const controller = new AbortController();
      store.setAbortController(controller);
      store.addMessage({ role: "user", content: userMessage });
      // Add empty assistant message that will be progressively filled
      store.addMessage({ role: "assistant", content: "" });
      store.setGenerating(true);
      return { controller };
    },
    onError: (err, _userMessage, context) => {
      const store = useActionChatStore.getState();
      // Only touch state if this generation is still the active one.
      if (context && store.abortController !== context.controller) return;
      const last = store.messages[store.messages.length - 1];
      if (last?.role === "assistant" && last.content.trim().length > 0) {
        // Some output already streamed in and rendered — keep it rather than
        // discarding the user's partial result, but flag the interruption.
        store.appendToLastMessage("\n\n[generation interrupted]");
      } else {
        // Nothing arrived; drop the empty assistant placeholder.
        store.removeLastMessage();
      }
      toast.error(err.message || "Failed to generate response");
    },
    onSettled: (_data, _err, _userMessage, context) => {
      const store = useActionChatStore.getState();
      // A newer generation may have replaced this one; don't clobber its state.
      if (!context || store.abortController !== context.controller) return;
      store.setGenerating(false);
      store.setAbortController(null);
    },
  });
}

export function useSaveAction() {
  const queryClient = useQueryClient();
  const { close } = useActionChatStore();

  return useMutation<{ success: boolean; filename: string }, Error, SaveRequest>({
    mutationFn: async ({ filename, content }) => {
      const res = await apiFetch("/api/actions/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Failed to save action");
      }
      return res.json() as Promise<{ success: boolean; filename: string }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
      close();
    },
  });
}
