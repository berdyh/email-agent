# Module Card: Core Agents

- purpose: Own model/CLI executor contracts and fallback routing.
- product/module functionality: Route prompts to Claude SDK/CLI, Codex, Gemini, OpenRouter, or direct API; support streaming where available.
- scope boundaries: Does not own action prompts, analysis prompt content, settings storage, or UI transport.
- connected modules/submodules: `config` for routing settings, `actions` and `analysis` as callers, web action generation route.
- allowed change types: Executor adapters, availability checks, fallback order, streaming behavior, environment cleanup for nested CLI calls.
- special operating rules: CLI executor flags are provider-specific; preserve known Codex/Claude spawn rules from project instructions.
- current stubs/placeholders: None known; single-chunk responses are the contract when an executor cannot stream.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README agent system, module index, setup docs for supported CLIs.
- local validation commands/checks: `npx tsc -p packages/core/tsconfig.json --noEmit`, focused tests when executor parsing changes.
