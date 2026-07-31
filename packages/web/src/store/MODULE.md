# Module Card: Web Store

- purpose: Own lightweight Zustand client state.
- product/module functionality: Track selected email and action-chat session state.
- scope boundaries: Does not persist runtime config or duplicate server/query cache state.
- connected modules/submodules: Web components and hooks.
- allowed change types: Local-only UI state and action-chat session state.
- special operating rules: Keep server data in TanStack Query, not Zustand; selected email state must carry account identity with Gmail id.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Settings/config card if UI preferences are persisted.
- local validation commands/checks: `rg -n "create<" packages/web/src/store`, `npx tsc -p packages/web/tsconfig.json --noEmit`.
