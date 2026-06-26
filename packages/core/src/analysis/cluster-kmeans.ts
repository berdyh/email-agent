import type { EmailRecord } from "../db/schema.js";

export interface ClusterAssignment {
  centroid: number[];
  emailKeys: string[];
}

export function kMeans(
  emails: EmailRecord[],
  k: number,
  maxIterations: number,
): ClusterAssignment[] {
  const dim = emails[0]!.vector.length;
  let centroids = initializeCentroids(emails, k);
  let assignments = new Array<number>(emails.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
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

    if (newAssignments.every((a, i) => a === assignments[i])) break;
    assignments = newAssignments;

    centroids = centroids.map((_, c) => {
      const members = emails.filter((_, i) => assignments[i] === c);
      if (members.length === 0) return centroids[c]!;
      const sum = new Array<number>(dim).fill(0);
      for (const member of members) {
        for (let d = 0; d < dim; d++) {
          sum[d]! += member.vector[d]!;
        }
      }
      return sum.map((value) => value / members.length);
    });
  }

  const result: ClusterAssignment[] = centroids.map((centroid) => ({
    centroid,
    emailKeys: [],
  }));
  for (let i = 0; i < emails.length; i++) {
    result[assignments[i]!]!.emailKeys.push(emailIdentityKey(emails[i]!));
  }

  return result.filter((cluster) => cluster.emailKeys.length > 0);
}

function initializeCentroids(emails: EmailRecord[], k: number): number[][] {
  const sorted = [...emails].sort((a, b) =>
    emailIdentityKey(a).localeCompare(emailIdentityKey(b)),
  );
  const selectedKeys = new Set<string>();
  const centroids: number[][] = [];

  centroids.push([...sorted[0]!.vector]);
  selectedKeys.add(emailIdentityKey(sorted[0]!));

  while (centroids.length < k) {
    let candidate = sorted.find((email) => !selectedKeys.has(emailIdentityKey(email)))!;
    let candidateDistance = -1;

    for (const email of sorted) {
      if (selectedKeys.has(emailIdentityKey(email))) continue;
      const nearestDistance = Math.min(
        ...centroids.map((centroid) => euclideanDist(email.vector, centroid)),
      );
      if (nearestDistance > candidateDistance) {
        candidate = email;
        candidateDistance = nearestDistance;
      }
    }

    centroids.push([...candidate.vector]);
    selectedKeys.add(emailIdentityKey(candidate));
  }

  return centroids;
}

export function emailIdentityKey(
  email: Pick<EmailRecord, "accountId" | "id">,
): string {
  return `${email.accountId}:${email.id}`;
}

function euclideanDist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
