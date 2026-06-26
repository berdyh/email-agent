# Module Card: Core DB

- purpose: Own LanceDB connection, Arrow schemas, table helpers, query filters, and embedding generation.
- product/module functionality: Store/search emails, threads, action results, clusters, and settings data.
- scope boundaries: Does not own Gmail fetch/account logic, action execution, or web route parsing.
- connected modules/submodules: `gmail/sync`, `actions/runner`, `analysis/clusterer`, web API routes.
- allowed change types: Schema updates, query helpers, escaping/filter builders, embedding provider calls.
- special operating rules: LanceDB string filters must escape user values; camelCase fields in filters need backticks.
- current stubs/placeholders: Local embedding provider returns zero vectors as `replace-with-contract`.
- irrelevant or incomplete code to remove/rework: Duplicated vector dimension references should use `shared/vector.ts`.
- docs that must stay aligned: Gmail sync card, module index, setup/docs for embedding provider.
- local validation commands/checks: `npm test -- packages/core/src/gmail/sync-records.test.ts`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
