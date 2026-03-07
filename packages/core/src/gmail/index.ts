export { checkGcloudAuth, loginGcloud } from "./auth.js";
export { createGmailClient, resetGmailClient, resolveAccountEmail } from "./client.js";
export { fetchUnreadEmails, fetchEmails, fetchEmail, fetchThread, type FetchOptions } from "./fetcher.js";
export { setupPubSub, startWatch, createPubSubListener } from "./pubsub.js";
export type { GmailMessage, GmailThread, GmailLabel } from "./types.js";
export { syncEmails, type SyncResult } from "./sync.js";
export {
  markAsRead,
  markAsUnread,
  trashMessage,
  markAsSpam,
  addLabels,
  removeLabels,
  batchModify,
} from "./operations.js";
export {
  listAccounts,
  addAccount,
  removeAccount,
  getDefaultAccount,
  setDefaultAccount,
  getOAuthCredentials,
  saveOAuthCredentials,
  generateAuthUrl,
  exchangeCode,
  createGmailClientForAccount,
} from "./account-manager.js";
export type { OAuthCredentials, StoredTokens } from "./account-types.js";
