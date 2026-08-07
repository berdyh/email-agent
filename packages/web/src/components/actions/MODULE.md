# Module Card: Web Actions Components

- purpose: Own action list, generated-action chat, edit flow, and user-action append controls.
- product/module functionality: Let users browse built-ins, create/edit user actions, save generated source, run actions, and review/approve queued Gmail changes (`approval-panel.tsx`: per-email checkboxes, click-to-read dialog, apply/reject), and adjudicate changes a crash stranded mid-apply (`StrandedOperationsPanel`, same file).
- scope boundaries: Does not write files directly or execute actions; all persistence/execution goes through API routes.
- connected modules/submodules: `hooks/use-actions`, `hooks/use-approvals`, `modules/api/action-run-contract`, `modules/api/approvals-contract`, `hooks/use-action-chat`, `store/action-chat-store`, `/api/actions*`, `/api/approvals*`, core actions.
- allowed change types: Action UI state, chat rendering, save/edit UX, action card composition.
- special operating rules: Do not render empty assistant streaming placeholders; preserve filename display/edit contract.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: `CREATE_ACTION_SKILLS.md`, `EDIT_ACTION_SKILLS.md`, action API contracts.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, route smoke for `/actions` and `/api/actions*`.
