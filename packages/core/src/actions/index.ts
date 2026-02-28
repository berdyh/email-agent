export type {
  EmailAction,
  ActionInput,
  ActionOutput,
  ActionRunResult,
  GmailOperationType,
  GmailOperation,
  ActionApplyResult,
} from "./types.js";
export { ActionRegistry } from "./registry.js";
export { ActionRunner } from "./runner.js";
export { builtInActions } from "./built-in/index.js";
export { mapResultToOperations, applyOperations, summarizeOperations } from "./apply.js";
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
