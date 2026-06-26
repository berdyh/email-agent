# Module Card: Web App And API

- purpose: Own Next App Router pages, layouts, and API route adapters.
- product/module functionality: Serve mail/actions/clusters/digest/settings/setup pages and expose API routes over core modules.
- scope boundaries: Pages compose UI modules; API routes validate inputs and call core. Business logic belongs in core or `src/modules/*`.
- connected modules/submodules: Web components/hooks/store, `modules/api`, all core package exports.
- allowed change types: Route/page composition, API adapter wiring, route-level status/error behavior.
- special operating rules: API routes must call validation helpers before state-changing core operations and preserve the local-only mutation guard.
- current stubs/placeholders: Root `/` redirect/page is intentionally minimal.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Module index, README page list, route smoke checklist.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, `npm run build`.
