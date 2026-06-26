# Module Card: Web Mail Components

- purpose: Own inbox layout, toolbar, list, reader, content rendering, and AI summary display.
- product/module functionality: Provide the main three-panel mail workflow and controls for fetch/read/apply actions.
- scope boundaries: Does not fetch Gmail directly or write DB; uses hooks/API routes.
- connected modules/submodules: `hooks/use-emails`, `hooks/use-fetch-emails`, `hooks/use-thread`, `store/email-store`, web Gmail routes.
- allowed change types: Mail layout, rendering, loading/error states, toolbar controls.
- special operating rules: Sanitized HTML rendering must remain in the content boundary; keep auth/error messages user-friendly.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README page list and module index.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, manual smoke for `/mail`.
