import { randomUUID } from "node:crypto";
import { getEmails } from "../db/emails.js";
import { saveClusters } from "../db/clusters.js";
import type { EmailRecord, ClusterRecord } from "../db/schema.js";

interface ClusterAssignment {
  centroid: number[];
  emailIds: string[];
}

/** Simple k-means clustering on email embedding vectors. */
export async function clusterEmails(options?: {
  k?: number;
  maxIterations?: number;
}): Promise<ClusterRecord[]> {
  const k = options?.k ?? 5;
  const maxIterations = options?.maxIterations ?? 20;

  const emails = await getEmails({ limit: 1000 });
  const withVectors = emails.filter(
    (e) => e.vector && e.vector.some((v) => v !== 0),
  );

  if (withVectors.length < k) {
    return [];
  }

  const clusters = kMeans(withVectors, k, maxIterations);

  const records: ClusterRecord[] = clusters.map((c, i) => ({
    id: randomUUID(),
    name: `Cluster ${i + 1}`,
    description: `Auto-generated cluster with ${c.emailIds.length} emails`,
    emailIds: JSON.stringify(c.emailIds),
    method: "k-means",
    centroid: c.centroid,
  }));

  await saveClusters(records);
  return records;
}

function kMeans(
  emails: EmailRecord[],
  k: number,
  maxIterations: number,
): ClusterAssignment[] {
  const dim = emails[0]!.vector.length;

  // Initialize centroids from random emails
  const indices = new Set<number>();
  while (indices.size < k) {
    indices.add(Math.floor(Math.random() * emails.length));
  }
  let centroids = [...indices].map((i) => [...emails[i]!.vector]);

  let assignments = new Array<number>(emails.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each email to nearest centroid
    const newAssignments = emails.map((email) => {
      let minDist = Infinity;
      let closest = 0;
      for (let c = 0; c < centroids.length; c++) {
        const dist = euclideanDist(email.vector, centroids[c]!);
        if (dist < minDist) {
          minDist = dist;
          closest = c;
        }
      }
      return closest;
    });

    // Check convergence
    if (newAssignments.every((a, i) => a === assignments[i])) break;
    assignments = newAssignments;

    // Recompute centroids
    centroids = centroids.map((_, c) => {
      const members = emails.filter((_, i) => assignments[i] === c);
      if (members.length === 0) return centroids[c]!;
      const sum = new Array<number>(dim).fill(0);
      for (const m of members) {
        for (let d = 0; d < dim; d++) {
          sum[d]! += m.vector[d]!;
        }
      }
      return sum.map((s) => s / members.length);
    });
  }

  // Build result
  const result: ClusterAssignment[] = centroids.map((centroid) => ({
    centroid,
    emailIds: [],
  }));
  for (let i = 0; i < emails.length; i++) {
    result[assignments[i]!]!.emailIds.push(emails[i]!.id);
  }

  return result.filter((c) => c.emailIds.length > 0);
}

function euclideanDist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
