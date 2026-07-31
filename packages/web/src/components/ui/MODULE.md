# Module Card: Web UI Primitives

- purpose: Own reusable presentation primitives such as buttons, inputs, cards, tabs, and switches.
- product/module functionality: Provide consistent styling primitives for feature components.
- scope boundaries: No product data loading, no core imports, no feature-specific behavior.
- connected modules/submodules: All web feature components.
- allowed change types: Styling, accessibility, primitive props, shared variants.
- special operating rules: `Button` is a plain `forwardRef` component and does not support Radix `asChild`.
- current stubs/placeholders: None known.
- irrelevant or incomplete code to remove/rework: None known.
- docs that must stay aligned: Component usage notes in project instructions when primitive contracts change.
- local validation commands/checks: `npx tsc -p packages/web/tsconfig.json --noEmit`, visual smoke for affected pages.
