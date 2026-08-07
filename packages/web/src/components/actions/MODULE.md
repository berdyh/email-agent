# Module Card: Web Actions Components

- purpose: Own action list, generated-action chat, edit flow, and user-action append controls.
- product/module functionality: Let users browse built-ins, create/edit user actions, save generated source, run actions, and review/approve queued Gmail changes (`approval-panel.tsx`: per-email checkboxes, click-to-read dialog, apply/reject), adjudicate changes a crash stranded mid-apply (`StrandedOperationsPanel`, same file), and restore a previous version of a user action (`snapshot-restore-dialog.tsx`).
- scope boundaries: Does not write files directly or execute actions; all persistence/execution goes through API routes.
- connected modules/submodules: `hooks/use-actions`, `hooks/use-approvals`, `modules/api/action-run-contract`, `modules/api/approvals-contract`, `modules/api/snapshot-contract`, `hooks/use-action-snapshots`, `hooks/use-action-chat`, `store/action-chat-store`, `/api/actions*`, `/api/approvals*`, core actions.
- allowed change types: Action UI state, chat rendering, save/edit UX, action card composition.
- special operating rules: Do not render empty assistant streaming placeholders; preserve filename display/edit contract. There is NO component testing library in this repo, so every component here is verified by reading — keep the wording and the request shaping in `modules/api/*-contract.ts` and the hooks, which are tested, and let the component pick a layout and call them. `snapshot-restore-dialog.tsx` in particular must surface a refused restore as the specific rules the snapshot broke (`describeSnapshotRestoreFailure`), never as a generic failure toast: the CLI has always printed them, and a user whose action was overwritten has nothing else to act on.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: `CREATE_ACTION_SKILLS.md`, `EDIT_ACTION_SKILLS.md`, action API contracts.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, route smoke for `/actions` and `/api/actions*`.
