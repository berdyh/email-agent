# Module Card: Core Actions

- purpose: Own email action contracts, discovery, user action source files, action execution, and Gmail operation mapping.
- product/module functionality: Built-in and user-created actions can be listed, loaded, run against emails, persisted as results, and optionally mapped to Gmail write operations.
- scope boundaries: Does not own Gmail auth/fetch, DB schema, web UI, or CLI presentation. Calls those modules through exported functions only.
- connected modules/submodules: `agents` for model execution, `db/actions` for result persistence, `gmail/operations` for writes, web `/api/actions*`, CLI `run-action` and `list-actions`.
- allowed change types: Action type contract changes, registry/runner behavior, user action path validation, built-in action additions, operation mapping.
- special operating rules: User action filenames must pass `user-action-paths.ts`; runtime imports outside the Next bundle must keep the native import escape hatch documented.
- current stubs/placeholders: Dynamic import escape hatch is `isolate-for-later`; keep it until user plugins have a safer execution sandbox.
- irrelevant or incomplete code to remove/rework: Regex metadata extraction may be replaced by a typed manifest, but do not remove it without preserving webpack-safe listing.
- docs that must stay aligned: `CREATE_ACTION_SKILLS.md`, `EDIT_ACTION_SKILLS.md`, web action cards, CLI action commands, `docs/architecture/module-index.md`.
- local validation commands/checks: `npm test -- packages/core/src/actions/*.test.ts`, `npx tsc -p packages/core/tsconfig.json --noEmit`, `npm run check:boundaries`.
