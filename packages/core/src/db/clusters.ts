import { getDb } from "./connection.js";
import { clustersTable, type ClusterRecord } from "./schema.js";

export async function saveClusters(clusters: ClusterRecord[]): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(clustersTable);
  await table.delete("id IS NOT NULL");
  if (clusters.length === 0) return;
  await table.add(clusters);
}
