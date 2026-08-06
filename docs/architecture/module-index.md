# Email Agent Module Index

This index is the first context layer for agents. Load this file, then the local `MODULE.md` for the area you will touch, then any linked source/tests needed for the task.

For a visual view of the same map (areas and their dependencies), open [`module-map.html`](module-map.html) in a browser.

## Project Areas

| Area | Purpose | Local card |
|---|---|---|
| Core actions | Action contracts, registry, user action files, execution, and Gmail operation mapping | `packages/core/src/actions/MODULE.md` |
| Core agents | CLI/API model executors and routing/fallback behavior | `packages/core/src/agents/MODULE.md` |
| Core analysis | Summaries, digests, clusters, and citation extraction | `packages/core/src/analysis/MODULE.md` |
| Core config | Runtime settings, defaults, paths, account config, and prompt templates | `packages/core/src/config/MODULE.md` |
| Core DB | LanceDB schema, tables, query helpers, and embeddings | `packages/core/src/db/MODULE.md` |
| Core Gmail | Gmail auth/accounts, fetch, sync, and write operations | `packages/core/src/gmail/MODULE.md` |
| Core shared | Cross-module constants and pure helpers | `packages/core/src/shared/MODULE.md` |
| Web app/API | Next pages and route adapters | `packages/web/src/app/MODULE.md` |
| Web API module | Request validation and API-local contracts | `packages/web/src/modules/api/MODULE.md` |
| Web actions UI | Action list, creation, editing, and chat components | `packages/web/src/components/actions/MODULE.md` |
| Web mail UI | Inbox layout, toolbar, list, display, content, and summaries | `packages/web/src/components/mail/MODULE.md` |
| Web shared/UI primitives | Navigation, error boundary, base UI controls | `packages/web/src/components/shared/MODULE.md`, `packages/web/src/components/ui/MODULE.md` |
| Web hooks/store | Client query hooks and Zustand state | `packages/web/src/hooks/MODULE.md`, `packages/web/src/store/MODULE.md` |
| CLI | Commander entrypoint and local command adapters | `packages/cli/src/MODULE.md` |
| Action skills eval tooling | Action-generation benchmark/eval scripts and data | `action-skills-workspace/MODULE.md` |

## Cross-Module Flows

- Gmail sync: web/CLI fetch adapters -> `core/gmail/sync` -> Gmail fetcher -> embedding generation -> DB email records keyed by `accountId` + Gmail `id`.
- Action execution: web/CLI action adapters -> `core/actions` registry/runner -> `core/agents` -> proposed Gmail write operations queued in DB `pending_operations` -> DB action results.
- Approval gate: web `/api/approvals*` panel or CLI `approvals`/run-action prompt -> `core/actions/approval` apply/reject by queue row id -> `core/gmail/operations` writes. Gmail is never mutated by an action run without the user's explicit approval, unless they opted into `gmail.autoApplyActions` and accepted its warnings (`gmail.autoApplyAcknowledged`), in which case the runner applies the queued batch immediately.
- Action generation: web action chat -> `/api/actions/generate` -> skill docs -> `core/agents`.
- Analysis: web analysis routes -> `core/analysis` -> `core/agents` or `core/db`.
- Settings: web settings route and CLI config command -> `core/config`.
- Web mutations: browser-origin writes must pass `modules/api` mutation-origin checks before touching Gmail, DB, config, or user action files; mail-returning reads must pass `readGuardResponse`.
- Action recovery: CLI `actions snapshots` and `/api/actions/user/snapshots` -> `core/actions` `listSnapshots`/`restoreSnapshot`; restore re-validates through the save-time source guard, so a pre-guard snapshot can be refused.

## Validation

- Local tests: `npm test`
- Coverage: `npm run test:coverage`
- Package typechecks: `npx tsc -p packages/core/tsconfig.json --noEmit`, `npx tsc -p packages/web/tsconfig.json --noEmit`, `npx tsc -p packages/cli/tsconfig.json --noEmit`
- Boundary audit: `npm run check:boundaries`
- Integration build: `npm run build`

## Stub Classification

- Local embeddings: `complete-now`; the `local` provider uses deterministic hashed token vectors for lexical similarity without an API key.
- Embedding provider failure fallback: `complete-now`; sync uses deterministic local vectors when network/API embedding calls fail, and clustering backfills older all-zero records from stored email text.
- Unread sync reconciliation: `complete-now`; complete unread-scoped syncs mark same-account local unread rows as read when Gmail no longer returns them, without table overwrite.
- Cluster labels/descriptions: `complete-now`; k-means clusters now derive names/descriptions from member terms and sender domains.
- Cluster membership identity: `complete-now`; clustering stores account-scoped email keys so duplicate Gmail ids across accounts stay distinct.
- Dynamic user action import escape hatch: `replace-with-contract`; required by Next webpack/runtime split and guarded by filename/path validation until a separate plugin sandbox exists.
- Remote browser mutations: `replace-with-contract`; the listener binds loopback and the API's header checks refuse non-local/cross-site requests (reads of mail included) unless `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` is explicitly set for a trusted deployment, which relaxes the checks and opens the bind. The header checks are caller-controlled and are not a boundary against a non-browser client; the bind is.
- `ui.panelWidths`: `remove`; unused config/store field was removed after a reference scan found no layout consumer.
