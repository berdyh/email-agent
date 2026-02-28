# Email Agent — Action Creation Guide

This document teaches coding agents how to create new email actions for Email Agent.

## Project Overview

Email Agent is a monorepo with three packages:
- `packages/core` — Business logic, Gmail API, LanceDB, agents, actions
- `packages/web` — Next.js 15 UI
- `packages/cli` — Command-line interface

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

## Creating an Action

1. Create a file: `~/.email-agent/actions/my-action.action.ts` (user actions)
   Or: `packages/core/src/actions/built-in/my-action.action.ts` (built-in)
2. Default-export an object implementing `EmailAction`
3. The registry auto-discovers all `*.action.ts` files

## Template

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "my-action",
  name: "My Action",
  description: "Describes what this action does",
  prompt: `Analyze each email and determine [your criteria].

For each email, return:
- fieldA: description of field A
- fieldB: description of field B`,
  outputSchema: '{ emailId: string, fieldA: string, fieldB: number }',
};

export default action;
```

## How It Works

1. `ActionRunner` receives your action + a batch of emails
2. It builds a combined prompt: your `prompt` + email data as JSON
3. Sends it to the configured AI agent (Claude, Codex, Gemini, or OpenAI API)
4. Parses the JSON array response — each item must have an `emailId` field
5. If the action has Gmail operation mapping in `apply.ts`, results are mapped to operations
6. Saves results to LanceDB for later retrieval

### Prompt Wrapping

The runner automatically wraps `action.prompt` — never include email data in the prompt itself:

```
[your action.prompt]

Emails to analyze:
```json
[{ id, from, subject, date, snippet, body (truncated to 2000 chars) }]
```

Respond with a JSON array of objects, each with an "emailId" field...
```

### Gmail Operation Mapping (built-in only)

Actions that produce Gmail side-effects need a mapping case in `packages/core/src/actions/apply.ts`:

```typescript
// In mapSingleResult():
case "my-action":
  return mapMyActionResult(result);
```

Available operation types: `trash`, `spam`, `markRead`, `markUnread`, `addLabels`, `removeLabels`

Current mappings: `junk` (trash/spam/archive), `subscription` (archive marketing). `priority` is analysis-only — no mapping needed.

Prefer user actions unless Gmail operation mapping is required.

## Example 1: Sentiment Analysis

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "sentiment",
  name: "Sentiment Analysis",
  description: "Analyzes the emotional tone of each email",
  prompt: `Analyze the sentiment of each email.

Consider:
- Overall tone (positive, negative, neutral)
- Urgency level
- Formality level

For each email, return:
- sentiment: "positive" | "negative" | "neutral" | "mixed"
- urgency: "high" | "medium" | "low"
- formality: "formal" | "casual" | "mixed"
- confidence: number 0-100`,
  outputSchema: '{ emailId: string, sentiment: string, urgency: string, formality: string, confidence: number }',
};

export default action;
```

## Example 2: Meeting Detection

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "meetings",
  name: "Meeting Detection",
  description: "Detects meeting invitations, scheduling requests, and calendar-related emails",
  prompt: `Analyze each email for meeting/scheduling content.

Detect:
- Meeting invitations (calendar invites, Zoom/Teams/Meet links)
- Scheduling requests ("Can we meet...", "Let's schedule...")
- Meeting follow-ups (agendas, minutes, action items)

For each email, return:
- isMeeting: boolean
- meetingType: "invitation" | "request" | "followup" | "none"
- proposedTime: ISO date string if mentioned, null otherwise
- platform: "zoom" | "teams" | "meet" | "in-person" | "unknown" | null
- actionNeeded: "accept" | "decline" | "propose-time" | "review" | "none"`,
  outputSchema: '{ emailId: string, isMeeting: boolean, meetingType: string, proposedTime: string|null, platform: string|null, actionNeeded: string }',
};

export default action;
```

## Example 3: Invoice/Receipt Detection

```typescript
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "invoices",
  name: "Invoice Detection",
  description: "Identifies invoices, receipts, and billing-related emails",
  prompt: `Analyze each email for financial/billing content.

Look for:
- Invoices and bills
- Payment receipts and confirmations
- Subscription renewal notices
- Expense-related emails

For each email, return:
- isFinancial: boolean
- type: "invoice" | "receipt" | "renewal" | "statement" | "none"
- amount: string with currency if found, null otherwise
- vendor: company/sender name
- dueDate: ISO date if mentioned, null otherwise`,
  outputSchema: '{ emailId: string, isFinancial: boolean, type: string, amount: string|null, vendor: string, dueDate: string|null }',
};

export default action;
```

## Running Actions

**CLI:**
```bash
email-agent list-actions          # See all available actions
email-agent run-action sentiment  # Run an action by ID
```

**Web UI:**
Navigate to the Actions page and click "Run" on any action.

## Available Built-in Actions

| ID | Name | Description |
|---|---|---|
| `priority` | Priority Detection | Classifies emails by urgency (high/medium/low) |
| `subscription` | Subscription Detection | Identifies newsletters and marketing emails |
| `junk` | Junk/Spam Scoring | Scores emails for spam likelihood |

## Adding a Built-in Action (extra steps)

1. Create `packages/core/src/actions/built-in/<id>.action.ts`
2. Import type from `../types.js` (not `@email-agent/core`)
3. Add import + entry to `packages/core/src/actions/built-in/index.ts` barrel (static list required for webpack)
4. If the action produces Gmail operations: add mapping case in `packages/core/src/actions/apply.ts`

## Checklist

- [ ] `id` is kebab-case and unique across all actions
- [ ] `prompt` does NOT include email data (appended automatically by runner)
- [ ] `prompt` specifies return fields with clear types
- [ ] `outputSchema` documents the expected JSON shape
- [ ] File uses `export default action` pattern
- [ ] If built-in: added to `built-in/index.ts` barrel
- [ ] If built-in with Gmail ops: added mapping in `apply.ts`

## Tips

- Keep prompts specific and structured — bullet points work well
- Always include `emailId` in your output schema
- Test with a small batch first (`email-agent run-action <id> --limit 5`)
- Use `outputSchema` to document the expected JSON shape for other developers
