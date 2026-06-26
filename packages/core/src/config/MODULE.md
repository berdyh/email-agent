# Module Card: Core Config

- purpose: Own runtime settings, defaults, filesystem paths, prompt defaults, and account config types.
- product/module functionality: Load/save settings and expose defaults consumed by core, web, CLI, and setup.
- scope boundaries: Does not own setup UX, Gmail OAuth implementation, or per-route request validation.
- connected modules/submodules: All core modules, web settings API, CLI config/setup, `setup.sh`.
- allowed change types: Config type additions, defaults, settings persistence helpers.
- special operating rules: New config fields must be added to `setup.sh` templates if fresh installs need them.
- current stubs/placeholders: `ui.panelWidths` is `remove` if reference scan confirms it remains unused.
- irrelevant or incomplete code to remove/rework: Arbitrary dotted-path writes in CLI config should move behind typed validation before broad settings expansion.
- docs that must stay aligned: README environment/setup sections, `setup.sh`, CLI config docs.
- local validation commands/checks: `npx tsc -p packages/core/tsconfig.json --noEmit`, `npx tsc -p packages/cli/tsconfig.json --noEmit`.
