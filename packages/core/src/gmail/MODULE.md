# Module Card: Core Gmail

- purpose: Own Gmail auth/accounts, client creation, message fetch/parsing, sync orchestration, and write operations.
- product/module functionality: Fetch emails into LanceDB, resolve account identity, support multi-account OAuth, and execute Gmail mutations.
- scope boundaries: Does not own DB schema beyond record mapping, action decisions, or web/CLI presentation.
- connected modules/submodules: `config`, `db`, `actions/apply`, web Gmail routes, CLI fetch/accounts/cron.
- allowed change types: OAuth/account management, fetch parsing, sync mapping, write operations.
- special operating rules: `accountEmail?: string` must continue threading through fetch/write paths; account removal/default changes reset cached clients. Sync must fetch with the resolved account identity before reconciling unread rows so fallback Gmail clients cannot be mixed with stored account rows. `createGmailClient` throws for a named account with missing/invalid stored credentials — it does not fall back to gcloud ADC. ADC is only used for the explicit empty-string account id and for the unscoped/no-accounts-configured path.
- current stubs/placeholders: Embedding failure fallback stores deterministic local vectors; complete unread syncs reconcile stale local unread rows without table overwrite; explicit empty account ids route to gcloud ADC.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README Gmail/setup sections, CLI accounts docs, module index.
- local validation commands/checks: `npm test -- packages/core/src/gmail/*.test.ts`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
