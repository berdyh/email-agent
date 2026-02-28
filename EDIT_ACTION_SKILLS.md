# Email Agent — Action Editing Guide

This document teaches coding agents how to modify existing email actions for Email Agent.

The current action code is provided at the end of this document under "Current Action Code".

## Your Task

The user wants to modify an existing action. You will receive:
1. This guide (editing rules + interface reference)
2. The current action source code (appended below)
3. The user's description of what to change

**Always return the complete updated action file** — not a diff or partial snippet.

## Editing Rules

1. **Preserve structure** — Keep the `import`, `const action`, and `export default` pattern intact
2. **Keep the `id`** — Never change the action's `id` unless the user explicitly asks to rename it
3. **Keep unrelated fields** — Only modify the fields the user asked to change
4. **Maintain the type** — The object must still satisfy `EmailAction`
5. **Return complete code** — Always output the full file, not just the changed parts

## EmailAction Interface

```typescript
interface EmailAction {
  id: string;           // Unique kebab-case identifier
  name: string;         // Human-readable name
  description: string;  // What this action does
  prompt: string;       // LLM prompt — tells the agent what to analyze
  outputSchema?: string; // Description of expected JSON output fields
  builtIn?: boolean;    // Set automatically by the registry
}
```

## What Can Be Edited

| Field | Common edits |
|-------|-------------|
| `name` | Rename the action's display name |
| `description` | Clarify or expand what the action does |
| `prompt` | Add/remove analysis criteria, change return fields, refine instructions |
| `outputSchema` | Add/remove fields, change types to match prompt changes |

## Prompt Editing Guidelines

The `prompt` field is the most commonly edited part. When modifying it:

- **Adding criteria**: Append new bullet points to existing detection/analysis lists
- **Removing criteria**: Remove the relevant bullets and their matching return fields
- **Changing return fields**: Update both the `For each email, return:` section in `prompt` AND the `outputSchema`
- **Keep prompt and outputSchema in sync** — if you add a return field to the prompt, add it to outputSchema too

### Prompt Structure to Preserve

```
[Analysis instruction — what to look for]

[Detection criteria as bullet list]

For each email, return:
- field: type and description
```

The runner automatically wraps `action.prompt` with email data — never include email data in the prompt itself.

## Common Edit Patterns

### Adding a new output field
```typescript
// Before
prompt: `...
For each email, return:
- sentiment: "positive" | "negative" | "neutral"`,
outputSchema: '{ emailId: string, sentiment: string }',

// After — added "reason" field
prompt: `...
For each email, return:
- sentiment: "positive" | "negative" | "neutral"
- reason: brief explanation for the sentiment classification`,
outputSchema: '{ emailId: string, sentiment: string, reason: string }',
```

### Refining detection criteria
```typescript
// Before
prompt: `Analyze each email for meeting content.

Detect:
- Meeting invitations`,

// After — more specific criteria
prompt: `Analyze each email for meeting content.

Detect:
- Meeting invitations (calendar invites, Zoom/Teams/Meet links)
- Scheduling requests ("Can we meet...", "Let's schedule...")
- Meeting cancellations or reschedules`,
```

### Changing the action's purpose
When the user wants to fundamentally change what the action does, rewrite `description`, `prompt`, and `outputSchema` together while keeping `id` and file structure.

## Output Format

Always wrap your response code in a TypeScript code block:

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  // ... complete updated action
};

export default action;
```

## Checklist

- [ ] `id` unchanged (unless user explicitly requested rename)
- [ ] All `EmailAction` fields present and valid
- [ ] `prompt` and `outputSchema` are in sync
- [ ] `prompt` does NOT include email data (appended automatically by runner)
- [ ] `prompt` specifies return fields with clear types
- [ ] File uses `export default action` pattern
- [ ] Complete file returned (not a diff)
