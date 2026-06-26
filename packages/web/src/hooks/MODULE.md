# Module Card: Web Hooks

- purpose: Own client data-fetching and mutation hooks.
- product/module functionality: Wrap API calls for emails, accounts, actions, settings, threads, and fetch operations.
- scope boundaries: Hooks call web API routes, not core runtime directly.
- connected modules/submodules: Web feature components, API routes, Zustand stores.
- allowed change types: Query keys, fetch wrappers, mutation invalidation, typed API return handling.
- special operating rules: New TanStack Query keys must be invalidated in all relevant mutation success handlers.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Feature component cards and API validation contracts.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`.
