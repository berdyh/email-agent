# Module Card: Web Hooks

- purpose: Own client data-fetching and mutation hooks.
- product/module functionality: Wrap API calls for emails, accounts, actions, settings, and fetch operations.
- scope boundaries: Hooks call web API routes, not core runtime directly.
- connected modules/submodules: Web feature components, API routes, Zustand stores.
- allowed change types: Query keys, fetch wrappers, mutation invalidation, typed API return handling.
- special operating rules: New TanStack Query keys must be invalidated in all relevant mutation success handlers. A single email is keyed `["email", accountId, emailId]` and ONLY via `emailDetailQueryKey`/`useEmailDetail` (`use-email-detail.ts`) — hand-built keys in the opposite order cached the same email twice and made targeted invalidation miss one. Approvals wire types are imported from `modules/api/approvals-contract.ts`, never re-declared here.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Feature component cards and API validation contracts.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`.
