# Module Card: Web App And API

- purpose: Own Next App Router pages, layouts, and API route adapters.
- product/module functionality: Serve mail/actions/clusters/digest/settings pages and expose API routes over core modules.
- scope boundaries: Pages compose UI modules; API routes validate inputs and call core. Business logic belongs in core or `src/modules/*`.
- connected modules/submodules: Web components/hooks/store, `modules/api`, all core package exports.
- allowed change types: Route/page composition, API adapter wiring, route-level status/error behavior.
- special operating rules: API routes must call validation helpers before state-changing core operations, preserve the local-only mutation guard, keep GET handlers read-only, and pass `accountId` with Gmail `id` for email detail/read-state routes, including explicit empty account ids for legacy/gcloud rows. `api/actions/[id]/results` and `api/actions/user/snapshots` are API-only by design — no page/component renders them directly (results feed the actions UI through other calls; snapshots back the edit/restore recovery flow) — do not treat their lack of a matching UI route as dead code.
- current stubs/placeholders: None known; root `/` is intentionally a minimal redirect/page.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Module index, README page list, route smoke checklist.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, `npm run build`.
