# Module Card: Core Notifications

- purpose: Own outbound desktop and webhook notifications.
- product/module functionality: Dispatch system notifications and Slack/Discord/custom webhooks from loaded settings.
- scope boundaries: Does not decide email priority or own notification UI.
- connected modules/submodules: `config` for notification settings, future action/analysis callers.
- allowed change types: Notification transport, payload shape, manager orchestration, error handling.
- special operating rules: Do not log webhook secrets; keep user-facing errors generic.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README notification feature docs and settings UI docs.
- local validation commands/checks: `npx tsc -p packages/core/tsconfig.json --noEmit`.
