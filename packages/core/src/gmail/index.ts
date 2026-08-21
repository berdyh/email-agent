export { checkGcloudAuth, loginGcloud } from "./auth.js";
// `createGmailClient` / `createGmailClientForAccount` are barrel-private for
// the same reason as ./operations.js below: they hand back a raw googleapis
// client scoped gmail.modify, so a public export is a one-import approval-gate
// bypass (every write op is a one-line wrapper over this factory). Core code
// imports ./client.js / ./account-manager.js relatively.
export { resetGmailClient, resolveAccountEmail } from "./client.js";
export {
  fetchEmailsWithMetadata,
  type FetchEmailsResult,
  type FetchOptions,
} from "./fetcher.js";
export type { GmailMessage, GmailThread } from "./types.js";
export { syncEmails, type SyncResult } from "./sync.js";
// Gmail write operations (./operations.js) are deliberately NOT re-exported.
// Defense in depth, and scoped honestly: user action files no longer execute at
// all — they are parsed as pure data by actions/action-source-guard.ts and never
// enter the module graph — so this is no longer what stands between a generated
// action and the mailbox. What it still does is make any by-name import of a
// mutating function fail loudly from every workspace-resolvable context (web
// bundling, in-tree callers, any future loading path), which is the realistic
// mistake now that the untrusted caller is gone. Core code imports
// ./operations.js relatively; web's manual mail actions use the webpack-only
// deep path `@email-agent/core/gmail/operations` (tsconfig paths), which Node's
// exports map refuses at runtime.
// The label READER (./read.js) is deliberately not re-exported either, and for
// a different reason than the write ops above: it cannot change anything, but
// it hands back mailbox content keyed by message id, which is not something a
// public barrel should offer. It is also kept out of ./operations.js on
// purpose — that module's names are denied a public export *because they
// write*, and a read-only name in that deny list would muddy what
// `barrel-surface.test.ts` asserts. Core imports ./read.js relatively.
export {
  listAccounts,
  addAccount,
  removeAccount,
  getDefaultAccount,
  setDefaultAccount,
  getOAuthCredentials,
  generateAuthUrl,
  exchangeCode,
} from "./account-manager.js";
export type { OAuthCredentials, StoredTokens } from "./account-types.js";
