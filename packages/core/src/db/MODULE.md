# Module Card: Core DB

- purpose: Own LanceDB connection, Arrow schemas, table helpers, query filters, and embedding generation.
- product/module functionality: Store emails, action results, and clusters; generate embeddings used for similarity/clustering.
- scope boundaries: Does not own Gmail fetch/account logic, action execution, or web route parsing. Does not own threads (no thread table/helpers — deleted as dead code).
- connected modules/submodules: `gmail/sync`, `actions/runner`, `analysis/clusterer`, web API routes.
- allowed change types: Schema updates, query helpers, escaping/filter builders, embedding provider calls.
- special operating rules: LanceDB string filters must escape user values; camelCase fields in filters need backticks; never use `add(..., { mode: "overwrite" })`; use `mergeInsert` or scoped delete/update plus append; email row identity is `accountId` + Gmail `id`, where empty `accountId` is the legacy/gcloud sentinel; unread reconciliation updates only same-account stale unread rows.
- current stubs/placeholders: Local embeddings use deterministic hashed token vectors at the fixed LanceDB vector dimension.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Gmail sync card, module index, setup/docs for embedding provider.
- local validation commands/checks: `npm test -- packages/core/src/gmail/sync-records.test.ts`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
