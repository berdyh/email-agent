export { checkGcloudAuth, loginGcloud } from "./auth.js";
export { createGmailClient, resetGmailClient, resolveAccountEmail } from "./client.js";
export {
  fetchEmailsWithMetadata,
  type FetchEmailsResult,
  type FetchOptions,
} from "./fetcher.js";
export type { GmailMessage, GmailThread } from "./types.js";
export { syncEmails, type SyncResult } from "./sync.js";
// Gmail write operations (./operations.js) are deliberately NOT re-exported.
// User actions are dynamically imported in-process and resolve through the
// package `exports` map, so any barrel export of a mutating function is a
// public bypass of the approval queue. Core code imports ./operations.js
// relatively; web's manual mail actions use the webpack-only deep path
// `@email-agent/core/gmail/operations` (tsconfig paths), which Node's
// exports map refuses at runtime.
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
