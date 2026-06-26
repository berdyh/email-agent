# Module Card: Action Skills Eval Tooling

- purpose: Own local evaluation data and graders for action-generation skill prompts.
- product/module functionality: Grade generated action source against expected import/export/schema/prompt characteristics.
- scope boundaries: Tooling only; not runtime action execution, web UI, or core registry behavior.
- connected modules/submodules: `CREATE_ACTION_SKILLS.md`, `EDIT_ACTION_SKILLS.md`, core action type contracts.
- allowed change types: Eval cases, grading assertions, benchmark output format.
- special operating rules: `grade.py` writes `grading.json` and `benchmark.json`; do not treat it as read-only.
- current stubs/placeholders: No `iteration-*` outputs are currently present.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Action skill docs and action contract changes.
- local validation commands/checks: Run `python action-skills-workspace/grade.py <iteration-dir>` only when eval outputs exist.
