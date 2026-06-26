# Module Card: Web Shared Components

- purpose: Own navigation chrome and shared error handling.
- product/module functionality: Sidebar, navbar, and error boundary used across pages.
- scope boundaries: Does not own feature-specific data loading or business behavior.
- connected modules/submodules: Web app layout, UI primitives, store UI state.
- allowed change types: Navigation items, shared layout chrome, global error presentation.
- special operating rules: Keep shared chrome lightweight and avoid importing core runtime directly.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README page list if navigation changes.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`.
