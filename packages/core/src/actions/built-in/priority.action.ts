import type { EmailAction } from "../types.js";

const action: EmailAction = {
  id: "priority",
  name: "Priority Detection",
  description: "Classifies emails by priority level (high/medium/low) based on urgency, sender importance, and action requirements.",
  prompt: `Analyze each email and determine its priority level.

Consider these factors:
- Urgency indicators (ASAP, urgent, deadline)
- Sender importance (manager, client, automated)
- Action required (response needed, FYI only)
- Time sensitivity (deadlines, expiring offers)

For each email, return:
- level: "high" | "medium" | "low"
- reason: brief explanation
- actionRequired: boolean
- deadline: ISO date string if a deadline is mentioned, null otherwise`,
  outputSchema: '{ emailId: string, level: "high"|"medium"|"low", reason: string, actionRequired: boolean, deadline: string|null }',
};

export default action;
