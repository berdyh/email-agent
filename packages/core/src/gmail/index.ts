export { checkGcloudAuth, loginGcloud } from "./auth.js";
export { createGmailClient } from "./client.js";
export { fetchUnreadEmails, fetchEmails, fetchEmail, fetchThread, type FetchOptions } from "./fetcher.js";
export { setupPubSub, startWatch, createPubSubListener } from "./pubsub.js";
export type { GmailMessage, GmailThread, GmailLabel } from "./types.js";
export { syncEmails, type SyncResult } from "./sync.js";
