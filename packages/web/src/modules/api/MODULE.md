# Module Card: Web API Contracts

- purpose: Own request validation and route-local input contracts for Next API handlers.
- product/module functionality: Parse and validate JSON bodies before route handlers call core modules.
- scope boundaries: Does not own core business behavior or UI state.
- connected modules/submodules: Next API routes under `app/api`, core Gmail/actions/settings modules, `oauth-state.ts` for the OAuth callback flow.
- allowed change types: Request parsers, validation errors, route-adapter-only DTOs.
- special operating rules: State-changing routes must validate input and mutation origin before touching core/file/DB/Gmail modules; `gmail.autoApplyActions` must stay gated on `gmail.autoApplyAcknowledged` in both `mergeSettingsUpdate` and `sanitizeSettingsForResponse` (see `normalizeGmailConfig`), mirroring the core invariant so a client cannot enable unattended Gmail writes by sending the toggle alone; non-local or cross-site browser writes require `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`; email-id request bodies and detail queries must include `accountId`, and an explicitly empty value is valid for legacy/gcloud ADC rows; legacy settings written under a removed shape (e.g. old `notifications`, `ui.theme`, `ui.sidebarCollapsed`, `prompts.priority`, `prompts.clustering` keys) must be normalized/dropped before route handlers persist an update, not passed through; `oauth-state.ts` owns the OAuth CSRF-state cookie — `generateOAuthState`/`setOAuthStateCookie` on auth-url issuance, `isValidOAuthState` (timing-safe compare) on callback, and the redirect URI is derived from the request origin (not hardcoded) so `serve --port N` keeps working.
- current stubs/placeholders: None known; local parsers are intentionally dependency-free to avoid package/lockfile churn.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Route handlers, module index, README environment variables, API smoke checklist.
- local validation commands/checks: `npm test -- packages/web/src/modules/api/*.test.ts`, `npx tsc -p packages/web/tsconfig.json --noEmit`.
