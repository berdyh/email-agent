export { checkGcloudAuth, loginGcloud } from "./auth.js";
export { createGmailClient, resetGmailClient, resolveAccountEmail } from "./client.js";
export {
  fetchEmailsWithMetadata,
  type FetchEmailsResult,
  type FetchOptions,
} from "./fetcher.js";
export type { GmailMessage, GmailThread } from "./types.js";
export { syncEmails, type SyncResult } from "./sync.js";
export {
  markAsRead,
  markAsUnread,
  trashMessage,
  markAsSpam,
  addLabels,
  removeLabels,
} from "./operations.js";
export {
  listAccounts,
  addAccount,
  removeAccount,
  getDefaultAccount,
  setDefaultAccount,
  getOAuthCredentials,
  generateAuthUrl,
  exchangeCode,
  createGmailClientForAccount,
} from "./account-manager.js";
export type { OAuthCredentials, StoredTokens } from "./account-types.js";
