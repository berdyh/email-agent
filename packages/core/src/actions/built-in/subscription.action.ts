import type { EmailAction } from "../types.js";

const action: EmailAction = {
  id: "subscription",
  name: "Subscription Detection",
  description: "Identifies newsletters, marketing emails, and subscription content for digest grouping.",
  prompt: `Analyze each email and determine if it's a subscription/newsletter.

Classify each email:
- isSubscription: boolean (newsletters, marketing, automated digests)
- category: "newsletter" | "marketing" | "transactional" | "social" | "none"
- senderType: "company" | "individual" | "automated"
- unsubscribeAvailable: boolean (look for unsubscribe links/headers)
- digestWorthy: boolean (contains content worth including in a daily digest)`,
  outputSchema: '{ emailId: string, isSubscription: boolean, category: string, senderType: string, unsubscribeAvailable: boolean, digestWorthy: boolean }',
};

export default action;
