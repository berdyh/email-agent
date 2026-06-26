# Module Card: Core Shared

- purpose: Hold small cross-module constants and pure helpers that would otherwise be duplicated.
- product/module functionality: Centralizes vector dimension, empty vector creation, and deterministic local embedding vectors.
- scope boundaries: Must not become a dumping ground for product flows, IO, or framework adapters.
- connected modules/submodules: `config`, `db`, `gmail`, and any vector-aware analysis code.
- allowed change types: Stable constants, pure utility helpers with at least two real consumers.
- special operating rules: Add helpers only when they reduce real cross-module duplication.
- current stubs/placeholders: None.
- irrelevant or incomplete code to remove/rework: None.
- docs that must stay aligned: DB and Gmail cards when vector contracts change.
- local validation commands/checks: `npm test`, `npx tsc -p packages/core/tsconfig.json --noEmit`.
