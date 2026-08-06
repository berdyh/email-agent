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
  chunkList,
  mergeApplyResults,
  toOperationOutcomes,
  APPLY_RESOLUTION_CHUNK_SIZE,
  type EnqueueOperationsInput,
} from "./approval.js";
export { ActionRegistry } from "./registry.js";
export { ActionRunner } from "./runner.js";
export { builtInActions } from "./built-in/index.js";
// `applyOperations` (./apply.js) is deliberately NOT exported: it mutates
// Gmail without an approval-queue row, so a public export lets a generated
// user action bypass the gate with one import. Only `approval.ts` may call
// it, via its relative import, after rows are claimed.
export {
  buildOperationAccountLookup,
  mapResultToOperations,
  scopeOperationsToAccounts,
} from "./apply.js";
export { parseActionOutput } from "./output-parser.js";
export {
  assertSafeActionSource,
  findActionSourceViolations,
  UnsafeActionSourceError,
  type ActionSourceViolation,
} from "./action-source-guard.js";
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
