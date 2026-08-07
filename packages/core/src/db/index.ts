export { getDb, initDb } from "./connection.js";
export {
  emailsTable,
  actionResultsTable,
  clustersTable,
  pendingOperationsTable,
  type EmailRecord,
  type ActionResultRecord,
  type PendingOperationRecord,
  type PendingOperationStatus,
} from "./schema.js";
export {
  upsertEmails,
  getEmails,
  getEmailById,
  countEmails,
  updateEmailReadStatus,
  updateEmailVector,
  markStaleUnreadEmailsRead,
  buildStaleUnreadFilter,
  buildEmailFilters,
} from "./emails.js";
export { saveActionResult, getActionResults } from "./actions.js";
export {
  savePendingOperations,
  getPendingOperations,
  getPendingOperationsByIds,
  getPendingOperationsForEmails,
  countPendingOperations,
  prunePendingOperations,
  buildPruneFilter,
  PRUNABLE_STATUSES,
  claimPendingOperations,
  resolveClaimedOperations,
  getStaleApplyingOperations,
  selectStaleApplyingOperations,
  STALE_APPLYING_THRESHOLD_MS,
  buildPendingOperationFilters,
  buildIdListFilter,
  buildInFilter,
  buildPendingEmailFilter,
  buildPendingResolutionFilter,
  buildClaimFilter,
  buildStrandedClaimFilter,
  buildStrandedAgeClause,
  describeLostClaimedOutcomes,
  type PendingOperationOutcome,
  type ClaimedResolutionResult,
} from "./pending-operations.js";
export { saveClusters } from "./clusters.js";
export { generateEmbedding, generateEmbeddings } from "./embeddings.js";
export { recordToGmailMessage } from "./record-mapper.js";
