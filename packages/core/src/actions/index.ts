export type {
  EmailAction,
  ActionOutput,
  ActionRunResult,
  GmailOperationType,
  GmailOperation,
  ActionApplyResult,
  OperationOutcome,
} from "./types.js";
export {
  enqueueOperations,
  toPendingOperationRecords,
  recordToGmailOperation,
  parseLabelIds,
  describeGmailOperation,
  isDestructiveOperation,
  applyPendingOperationsByIds,
  rejectPendingOperationsByIds,
  type EnqueueOperationsInput,
} from "./approval.js";
export { ActionRegistry } from "./registry.js";
export { ActionRunner } from "./runner.js";
export { builtInActions } from "./built-in/index.js";
export {
  buildOperationAccountLookup,
  mapResultToOperations,
  applyOperations,
  scopeOperationsToAccounts,
} from "./apply.js";
export { parseActionOutput } from "./output-parser.js";
export {
  extractActionIdFromSource,
  normalizeSnapshotFilename,
  normalizeUserActionFilename,
  resolveUserActionFilePath,
} from "./user-action-paths.js";
export type { UserActionMeta, SnapshotEntry } from "./user-actions.js";
export {
  listUserActions,
  saveUserAction,
  deleteUserAction,
  loadUserAction,
  readUserActionSource,
  listSnapshots,
  restoreSnapshot,
} from "./user-actions.js";
