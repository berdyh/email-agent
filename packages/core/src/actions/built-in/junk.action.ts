import type { EmailAction } from "../types.js";

const action: EmailAction = {
  id: "junk",
  name: "Junk/Spam Scoring",
  description: "Scores emails for junk/spam likelihood based on content patterns and sender signals.",
  prompt: `Analyze each email for junk/spam indicators.

Evaluate these signals:
- Sender reputation (unknown domain, free email providers for business comms)
- Content patterns (excessive capitalization, urgency tactics, too-good offers)
- Link analysis (suspicious URLs, URL shorteners, many tracking links)
- Template indicators (generic greeting, mass-email formatting)

For each email, return:
- junkScore: number 0-100 (0 = definitely not junk, 100 = definitely junk)
- confidence: "high" | "medium" | "low"
- signals: array of detected junk indicators
- recommendation: "keep" | "archive" | "delete"`,
  outputSchema: '{ emailId: string, junkScore: number, confidence: string, signals: string[], recommendation: string }',
};

export default action;
