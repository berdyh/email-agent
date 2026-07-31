# Module Card: CLI

- purpose: Own Commander entrypoint and command adapters.
- product/module functionality: Fetch emails, manage accounts, run/list actions, review/apply queued Gmail changes (`approvals` command), serve web UI, manage cron, and read/write config.
- scope boundaries: CLI calls the core barrel export only and should not import core subpaths.
- connected modules/submodules: `@email-agent/core`, setup script, README CLI docs.
- allowed change types: Command flags, help text, argument validation, command-to-core adapter behavior.
- special operating rules: Use `execFile`/`execFileSync` instead of shell-based `exec`; preserve core build-before-CLI typecheck.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: Dotted config writes need typed validation before large config expansion.
- docs that must stay aligned: README CLI section, module index.
- local validation commands/checks: `npx tsc -p packages/cli/tsconfig.json --noEmit`, `email-agent --help` after build.
