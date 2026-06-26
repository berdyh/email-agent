# Module Card: Core Analysis

- purpose: Own AI-assisted email summarization, digest generation, clustering, and citation extraction.
- product/module functionality: Generate summaries/digests through agents, extract citations, group stored email vectors into clusters.
- scope boundaries: Does not fetch Gmail messages or own DB connection lifecycle beyond calling DB helpers.
- connected modules/submodules: `agents` for summary/digest generation, `db/emails` and `db/clusters` for clustering, web analysis API routes.
- allowed change types: Analysis prompts, parsing, cluster algorithm changes, citation extraction logic.
- special operating rules: Preserve JSON extraction fallbacks until callers have typed model outputs.
- current stubs/placeholders: None known; k-means labels/descriptions are derived from cluster member terms and sender domains, cluster membership uses account-scoped email keys, and clustering backfills old empty vectors before grouping.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Web analysis routes, README feature list, module index.
- local validation commands/checks: `npx tsc -p packages/core/tsconfig.json --noEmit`, add focused tests for any parser/algorithm change.
