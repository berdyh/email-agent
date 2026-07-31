# Module Card: Core Agents

- purpose: Own model/CLI executor contracts and fallback routing.
- product/module functionality: Route prompts to Claude SDK/CLI, Codex, Gemini, OpenRouter, or direct API; stream real incremental chunks for executors that support it (Claude SDK/CLI today), with a genuine one-shot fallback for executors that don't.
- scope boundaries: Does not own action prompts, analysis prompt content, settings storage, or UI transport.
- connected modules/submodules: `config` for routing settings, `actions` and `analysis` as callers, web action generation route.
- allowed change types: Executor adapters, availability checks, fallback order, streaming behavior, environment cleanup for nested CLI calls.
- special operating rules: CLI executor flags are provider-specific; preserve known Codex/Claude spawn rules from project instructions. The barrel (`index.ts`) only exports the shared types and `AgentRouter` — individual executor classes (`ClaudeExecutor`, `CodexExecutor`, `GeminiExecutor`, `DirectApiExecutor`, `OpenRouterExecutor`, `SdkExecutor`) are constructed internally by `router.ts` via relative imports and are not part of the public barrel; do not re-add those re-exports without a real external consumer.
- current stubs/placeholders: A single non-streaming chunk is the contract when `AgentRouter.executeStream()` calls an executor without `executeStream()`, or when streaming fails before emitting any chunk.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: README agent system, module index, setup docs for supported CLIs.
- local validation commands/checks: `npx tsc -p packages/core/tsconfig.json --noEmit`, focused tests when executor parsing changes.
