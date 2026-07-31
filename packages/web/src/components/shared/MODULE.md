# Module Card: Web Shared Components

- purpose: Own navigation chrome and shared error handling.
- product/module functionality: Sidebar, navbar, and `ErrorBoundary` (mounted in the root `app/layout.tsx` so it catches render errors app-wide, not just per-page).
- scope boundaries: Does not own feature-specific data loading or business behavior.
- connected modules/submodules: Web app layout, UI primitives, store UI state.
- allowed change types: Navigation items, shared layout chrome, global error presentation.
- special operating rules: Keep shared chrome lightweight and avoid importing core runtime directly; `ErrorBoundary` must stay mounted at the root layout — do not move it back to a leaf page without updating this card.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README page list if navigation changes.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`.
