# Module Card: Web API Contracts

- purpose: Own request validation and route-local input contracts for Next API handlers.
- product/module functionality: Parse and validate JSON bodies before route handlers call core modules.
- scope boundaries: Does not own core business behavior or UI state.
- connected modules/submodules: Next API routes under `app/api`, core Gmail/actions/settings modules.
- allowed change types: Request parsers, validation errors, route-adapter-only DTOs.
- special operating rules: State-changing routes must validate input and mutation origin before touching core/file/DB/Gmail modules; non-local or cross-site browser writes require `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`.
- current stubs/placeholders: Local parsers are dependency-free; replacing with Zod is deferred until package/lockfile changes are intentional.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Route handlers, module index, README environment variables, API smoke checklist.
- local validation commands/checks: `npm test -- packages/web/src/modules/api/*.test.ts`, `npx tsc -p packages/web/tsconfig.json --noEmit`.
