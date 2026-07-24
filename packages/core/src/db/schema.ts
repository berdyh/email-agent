// Schema type definitions for LanceDB tables.
// These mirror the table structures in connection.ts and provide
// TypeScript interfaces for type-safe operations.

export interface EmailRecord {
  [key: string]: unknown;
  id: string;
  accountId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  labels: string; // JSON array of label strings
  isUnread: boolean;
  senderDomain: string;
  snippet: string;
  vector: number[];
}

export interface ActionResultRecord {
  [key: string]: unknown;
  id: string;
  actionId: string;
  // "" is the unscoped sentinel: a legacy/ADC row OR a mixed multi-account run
  // whose processed emails did not resolve to a single account.
  accountId: string;
  status: string;
  emailIds: string; // JSON array
  resultData: string; // JSON string
  agentUsed: string;
  tokensUsed: number;
  durationMs: number;
  createdAt: string;
}

export interface ClusterRecord {
  [key: string]: unknown;
  id: string;
  name: string;
  description: string;
  emailIds: string; // JSON array of account-scoped email keys
  method: string;
  centroid: number[];
}

// Table name constants
export const emailsTable = "emails";
export const actionResultsTable = "action_results";
export const clustersTable = "clusters";
