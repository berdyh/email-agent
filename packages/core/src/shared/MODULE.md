# Module Card: Core Shared

- purpose: Hold small cross-module constants and pure helpers that would otherwise be duplicated.
- product/module functionality: Centralizes vector dimension, empty vector creation, deterministic local embedding vectors, and the `0700`/`0600` write path every file under `~/.email-agent/` goes through (`private-files.ts`).
- scope boundaries: Must not become a dumping ground for product flows, IO, or framework adapters. `private-files.ts` is the one deliberate IO exception: it is a mode/atomicity primitive with three consumers (`config/settings.ts`, `config/session.ts`, `gmail/account-manager.ts`) and no product logic.
- connected modules/submodules: `config`, `db`, `gmail`, and any vector-aware analysis code.
- allowed change types: Stable constants, pure utility helpers with at least two real consumers.
- special operating rules: Add helpers only when they reduce real cross-module duplication. Anything persisted under `~/.email-agent/` MUST be written through `writePrivateFile`/`writePrivateFileSync` — a bare `writeFile` lands at `0644` under the default umask, and everything in that directory is a credential or the mail it unlocks. The `chmod` after the write is not belt-and-braces: `mode:` applies only when the file or directory is CREATED, so an install predating 2026-08-22 keeps its loose bits without it.
- current stubs/placeholders: None.
- irrelevant or incomplete code to remove/rework: None.
- docs that must stay aligned: DB and Gmail cards when vector contracts change.
- local validation commands/checks: `npm test`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
