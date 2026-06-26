import { create } from "zustand";

interface EmailStore {
  selectedEmailId: string | null;
  selectedEmailAccountId: string | null;
  selectEmail: (id: string | null, accountId?: string | null) => void;
  filterUnreadOnly: boolean;
  setFilterUnreadOnly: (v: boolean) => void;
  activeAccountEmail: string | null;
  setActiveAccount: (email: string | null) => void;
}

export const useEmailStore = create<EmailStore>((set) => ({
  selectedEmailId: null,
  selectedEmailAccountId: null,
  selectEmail: (id, accountId = null) =>
    set({ selectedEmailId: id, selectedEmailAccountId: accountId }),
  filterUnreadOnly: false,
  setFilterUnreadOnly: (v) => set({ filterUnreadOnly: v }),
  activeAccountEmail: null,
  setActiveAccount: (email) =>
    set({
      activeAccountEmail: email,
      selectedEmailId: null,
      selectedEmailAccountId: null,
    }),
}));
