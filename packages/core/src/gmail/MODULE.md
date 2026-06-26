# Module Card: Core Gmail

- purpose: Own Gmail auth/accounts, client creation, message fetch/parsing, sync orchestration, write operations, and Pub/Sub.
- product/module functionality: Fetch emails into LanceDB, resolve account identity, support multi-account OAuth, and execute Gmail mutations.
- scope boundaries: Does not own DB schema beyond record mapping, action decisions, or web/CLI presentation.
- connected modules/submodules: `config`, `db`, `actions/apply`, web Gmail routes, CLI fetch/accounts/cron.
- allowed change types: OAuth/account management, fetch parsing, sync mapping, write operations, Pub/Sub setup.
- special operating rules: `accountEmail?: string` must continue threading through fetch/write paths; account removal/default changes reset cached clients.
- current stubs/placeholders: None known; embedding failure fallback stores deterministic local vectors, complete unread syncs reconcile stale local unread rows without table overwrite, and explicit empty account ids remain routed to gcloud ADC.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README Gmail/setup sections, CLI accounts docs, module index.
- local validation commands/checks: `npm test -- packages/core/src/gmail/*.test.ts`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
