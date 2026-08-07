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
  enqueueOperationsDetailed,
  operationDedupeKey,
  selectNewOperationIndexes,
  type EnqueueOperationsResult,
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
  resolveRetentionCutoff,
  APPLY_RESOLUTION_CHUNK_SIZE,
  type EnqueueOperationsInput,
} from "./approval.js";
export { ActionRegistry } from "./registry.js";
export {
  ActionRunner,
  describeAutoApplyFailure,
  describeUnrecordedBatchFailure,
} from "./runner.js";
export { builtInActions } from "./built-in/index.js";
// `applyOperations` (./apply.js) is deliberately NOT exported: it mutates
// Gmail without an approval-queue row, so a public export is a one-import
// bypass of the gate for anything that can resolve this package. That no longer
// includes a generated user action — those files are parsed as pure data and
// never imported (./action-source-guard.js) — so this is defense in depth
// against an in-tree caller, not the enforcement boundary. Only `approval.ts`
// may call it, via its relative import, after rows are claimed.
export {
  buildOperationAccountLookup,
  mapResultToOperations,
  scopeOperationsToAccounts,
} from "./apply.js";
export { parseActionOutput } from "./output-parser.js";
export {
  assertSafeActionSource,
  extractActionData,
  findActionSourceViolations,
  UnsafeActionSourceError,
  type ActionSourceViolation,
} from "./action-source-guard.js";
export {
  normalizeSnapshotFilename,
  normalizeUserActionFilename,
  resolveUserActionFilePath,
} from "./user-action-paths.js";
export type { UserActionMeta, UserActionFile, SnapshotEntry } from "./user-actions.js";
export {
  readUserActionFiles,
  listUserActions,
  saveUserAction,
  deleteUserAction,
  loadUserAction,
  readUserActionSource,
  listSnapshots,
  restoreSnapshot,
} from "./user-actions.js";
