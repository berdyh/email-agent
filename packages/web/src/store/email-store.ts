import { create } from "zustand";

interface EmailStore {
  selectedEmailId: string | null;
  selectEmail: (id: string | null) => void;
  filterUnreadOnly: boolean;
  setFilterUnreadOnly: (v: boolean) => void;
}

export const useEmailStore = create<EmailStore>((set) => ({
  selectedEmailId: null,
  selectEmail: (id) => set({ selectedEmailId: id }),
  filterUnreadOnly: false,
  setFilterUnreadOnly: (v) => set({ filterUnreadOnly: v }),
}));
