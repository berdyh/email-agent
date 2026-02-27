// Schema type definitions for LanceDB tables.
// These mirror the table structures in connection.ts and provide
// TypeScript interfaces for type-safe operations.

export interface EmailRecord {
  [key: string]: unknown;
  id: string;
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

export interface ThreadRecord {
  [key: string]: unknown;
  id: string;
  subject: string;
  messageCount: number;
  lastMessageDate: string;
  summary: string;
  summaryData: string; // JSON string of structured summary
  priority: string;
  category: string;
  vector: number[];
}

export interface ActionResultRecord {
  [key: string]: unknown;
  id: string;
  actionId: string;
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
  emailIds: string; // JSON array
  method: string;
  centroid: number[];
}

export interface SettingsRecord {
  [key: string]: unknown;
  key: string;
  value: string;
  updatedAt: string;
}

// Table name constants
export const emailsTable = "emails";
export const threadsTable = "threads";
export const actionResultsTable = "action_results";
export const clustersTable = "clusters";
export const settingsTable = "settings";
