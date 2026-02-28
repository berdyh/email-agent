import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ActionChatState {
  isOpen: boolean;
  mode: "create" | "edit";
  editingAction: { id: string; filename: string } | null;
  messages: ChatMessage[];
  isGenerating: boolean;
  extractedCode: string | null;
  expandedCardId: string | null;
}

interface ActionChatActions {
  openCreate: () => void;
  openEdit: (action: { id: string; filename: string }) => void;
  close: () => void;
  addMessage: (message: ChatMessage) => void;
  appendToLastMessage: (text: string) => void;
  removeLastMessage: () => void;
  setGenerating: (v: boolean) => void;
  setExtractedCode: (code: string | null) => void;
  reset: () => void;
}

type ActionChatStore = ActionChatState & ActionChatActions;

export const useActionChatStore = create<ActionChatStore>()(
  persist(
    (set) => ({
      isOpen: false,
      mode: "create",
      editingAction: null,
      messages: [],
      isGenerating: false,
      extractedCode: null,
      expandedCardId: null,

      openCreate: () =>
        set({
          isOpen: true,
          mode: "create",
          editingAction: null,
          messages: [],
          extractedCode: null,
          expandedCardId: "__create__",
        }),

      openEdit: (action) =>
        set({
          isOpen: true,
          mode: "edit",
          editingAction: action,
          messages: [],
          extractedCode: null,
          expandedCardId: action.id,
        }),

      close: () =>
        set({
          isOpen: false,
          editingAction: null,
          messages: [],
          isGenerating: false,
          extractedCode: null,
          expandedCardId: null,
        }),

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      appendToLastMessage: (text) =>
        set((state) => {
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, content: last.content + text };
          }
          return { messages: msgs };
        }),

      removeLastMessage: () =>
        set((state) => ({ messages: state.messages.slice(0, -1) })),

      setGenerating: (v) => set({ isGenerating: v }),
      setExtractedCode: (code) => set({ extractedCode: code }),

      reset: () =>
        set({
          isOpen: false,
          mode: "create",
          editingAction: null,
          messages: [],
          isGenerating: false,
          extractedCode: null,
          expandedCardId: null,
        }),
    }),
    {
      name: "action-chat",
      // Persist conversation state but NOT isGenerating — on reload the process is gone
      partialize: (state) => ({
        isOpen: state.isOpen,
        mode: state.mode,
        editingAction: state.editingAction,
        messages: state.messages,
        extractedCode: state.extractedCode,
        expandedCardId: state.expandedCardId,
      }),
    },
  ),
);
