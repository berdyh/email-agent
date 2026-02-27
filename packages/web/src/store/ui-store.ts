import { create } from "zustand";

interface UiStore {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  panelWidths: [number, number, number];
  setPanelWidths: (widths: [number, number, number]) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  panelWidths: [20, 35, 45],
  setPanelWidths: (panelWidths) => set({ panelWidths }),
}));
