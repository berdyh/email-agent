# Module Card: Web Store

- purpose: Own lightweight Zustand client state.
- product/module functionality: Track selected email, action-chat state, sidebar state, and local UI preferences.
- scope boundaries: Does not persist runtime config or duplicate server/query cache state.
- connected modules/submodules: Web components and hooks.
- allowed change types: Local-only UI state and action-chat session state.
- special operating rules: Keep server data in TanStack Query, not Zustand.
- current stubs/placeholders: `ui-store.panelWidths` is `remove` if no consumer is found.
- irrelevant or incomplete code to remove/rework: Remove unused store fields only after reference scan and visual smoke.
- docs that must stay aligned: Settings/config card if UI preferences are persisted.
- local validation commands/checks: `rg -n "panelWidths|sidebarCollapsed" packages/web/src`, `npx tsc -p packages/web/tsconfig.json --noEmit`.
