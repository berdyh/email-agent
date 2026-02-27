import { getDb } from "./connection.js";
import { clustersTable, type ClusterRecord } from "./schema.js";

export async function saveClusters(clusters: ClusterRecord[]): Promise<void> {
  if (clusters.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(clustersTable);
  await table.add(clusters, { mode: "overwrite" });
}

export async function getClusters(): Promise<ClusterRecord[]> {
  const db = await getDb();
  const table = await db.openTable(clustersTable);
  const results = await table.query().toArray();
  return results as unknown as ClusterRecord[];
}
