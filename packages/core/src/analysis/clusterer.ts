import { randomUUID } from "node:crypto";
import { getEmails, updateEmailVector } from "../db/emails.js";
import { saveClusters } from "../db/clusters.js";
import type { EmailRecord, ClusterRecord } from "../db/schema.js";
import { createLocalEmbeddingVector } from "../shared/vector.js";
import { emailIdentityKey, kMeans } from "./cluster-kmeans.js";
import { summarizeCluster } from "./cluster-summary.js";

/** Simple k-means clustering on email embedding vectors. */
export async function clusterEmails(options?: {
  k?: number;
  maxIterations?: number;
}): Promise<ClusterRecord[]> {
  const k = options?.k ?? 5;
  const maxIterations = options?.maxIterations ?? 20;

  const emails = await getEmails({ limit: 1000 });
  const vectorizedEmails = emails.map((email) => {
    if (hasUsableVector(email)) return email;
    return {
      ...email,
      vector: createLocalEmbeddingVector(emailEmbeddingText(email)),
    };
  });
  const backfilledEmails = vectorizedEmails.filter(
    (email, index) => !hasUsableVector(emails[index]!) && hasUsableVector(email),
  );
  if (backfilledEmails.length > 0) {
    await Promise.all(
      backfilledEmails.map((email) => updateEmailVector(email.id, email.vector, email.accountId)),
    );
  }

  const withVectors = vectorizedEmails.filter(hasUsableVector);

  if (withVectors.length < k) {
    await saveClusters([]);
    return [];
  }

  const clusters = kMeans(withVectors, k, maxIterations);
  const emailsByKey = new Map(withVectors.map((email) => [emailIdentityKey(email), email]));

  const records: ClusterRecord[] = clusters.map((c) => {
    const members = c.emailKeys
      .map((key) => emailsByKey.get(key))
      .filter((email): email is EmailRecord => Boolean(email));
    const summary = summarizeCluster(members);
    return {
      id: randomUUID(),
      name: summary.name,
      description: summary.description,
      emailIds: JSON.stringify(c.emailKeys),
      method: "k-means",
      centroid: c.centroid,
    };
  });

  await saveClusters(records);
  return records;
}

function hasUsableVector(email: EmailRecord): boolean {
  return email.vector.some((value) => value !== 0);
}

function emailEmbeddingText(email: EmailRecord): string {
  return `${email.subject}\n${email.from}\n${email.bodyText.slice(0, 500)}`;
}
