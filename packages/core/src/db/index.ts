export { getDb, initDb } from "./connection.js";
export { emailsTable, actionResultsTable, clustersTable } from "./schema.js";
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
export { saveClusters } from "./clusters.js";
export { generateEmbedding, generateEmbeddings } from "./embeddings.js";
export { recordToGmailMessage } from "./record-mapper.js";
