export { getDb, initDb } from "./connection.js";
export { emailsTable, threadsTable, actionResultsTable, clustersTable, settingsTable } from "./schema.js";
export { upsertEmails, getEmails, getEmailById, searchEmails, updateEmailReadStatus } from "./emails.js";
export { upsertThread, getThreads, getThreadById } from "./threads.js";
export { saveActionResult, getActionResults } from "./actions.js";
export { saveClusters, getClusters } from "./clusters.js";
export { generateEmbedding, generateEmbeddings } from "./embeddings.js";
