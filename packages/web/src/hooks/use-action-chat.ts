import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Derive a filename from action ID in code, or from user message. */
export function deriveFilename(code: string): string {
  const idMatch = code.match(/id:\s*["'`]([^"'`]+)["'`]/);
  if (idMatch?.[1]) {
    return `${idMatch[1]}.action.ts`;
  }
  return "new-action.action.ts";
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

export function useSendMessage() {
  const {
    messages,
    mode,
    editingAction,
    addMessage,
    appendToLastMessage,
    removeLastMessage,
    setGenerating,
    setExtractedCode,
  } = useActionChatStore();

  return useMutation<void, Error, string>({
    mutationFn: async (userMessage) => {
      const newMessages: ChatMessage[] = [...messages, { role: "user", content: userMessage }];

      let currentCode: string | undefined;
      if (mode === "edit" && editingAction) {
        const res = await fetch(
          `/api/actions/user?filename=${encodeURIComponent(editingAction.filename)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as ActionSourceResponse;
          currentCode = data.source;
        }
      }

      const res = await fetch("/api/actions/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, mode, currentCode }),
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

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEEvents(buffer);
        buffer = remaining;

        for (const evt of events) {
          if (evt.event === "chunk") {
            const parsed = JSON.parse(evt.data) as { text: string };
            fullText += parsed.text;
            appendToLastMessage(parsed.text);
          } else if (evt.event === "done") {
            const parsed = JSON.parse(evt.data) as { message: string };
            fullText = parsed.message;
          } else if (evt.event === "error") {
            const parsed = JSON.parse(evt.data) as { error: string };
            throw new Error(parsed.error);
          }
        }
      }

      // Extract code from the complete response
      const code = extractCode(fullText);
      if (code) {
        setExtractedCode(code);
      }
    },
    onMutate: (userMessage) => {
      addMessage({ role: "user", content: userMessage });
      // Add empty assistant message that will be progressively filled
      addMessage({ role: "assistant", content: "" });
      setGenerating(true);
    },
    onError: (err) => {
      // Remove the empty assistant placeholder on error
      removeLastMessage();
      toast.error(err.message || "Failed to generate response");
    },
    onSettled: () => {
      setGenerating(false);
    },
  });
}

export function useSaveAction() {
  const queryClient = useQueryClient();
  const { close } = useActionChatStore();

  return useMutation<{ success: boolean; filename: string }, Error, SaveRequest>({
    mutationFn: async ({ filename, content }) => {
      const res = await fetch("/api/actions/user", {
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

export function useReadActionSource(filename: string | null) {
  return useQuery<ActionSourceResponse>({
    queryKey: ["action-source", filename],
    queryFn: async (): Promise<ActionSourceResponse> => {
      const res = await fetch(`/api/actions/user?filename=${encodeURIComponent(filename!)}`);
      if (!res.ok) throw new Error("Failed to read action source");
      return res.json() as Promise<ActionSourceResponse>;
    },
    enabled: !!filename,
  });
}
