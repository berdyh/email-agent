/**
 * Wire types and wording for the action-snapshot surface.
 *
 * FREE OF `@email-agent/core` IMPORTS, like its sibling contracts: the hook and
 * the card are client components, and web code outside `modules/api` may not
 * pull core runtime into the browser bundle.
 *
 * The wording lives here rather than in the component for the reason every
 * contract in this directory does: there is no React testing library in this
 * repo, so anything left inside a component is verified by reading. What a user
 * is told when a restore is REFUSED is the part that matters most — the CLI
 * already prints the specific rules a snapshot broke, and a web surface that
 * degraded that to "Failed to restore" would leave the user with an
 * unrecoverable action and no idea why.
 */

export interface SnapshotEntryDto {
  /** The snapshot file's own name, which is what a restore is keyed on. */
  filename: string;
  /** ISO-ish timestamp recovered from the filename. */
  timestamp: string;
  snapshotPath: string;
}

/** One rule an action source broke, as `UnsafeActionSourceError` reports it. */
export interface SourceViolationDto {
  rule: string;
  detail: string;
}

export interface SnapshotRestoreErrorDto {
  error: string;
  /** Present only for a source-guard refusal (HTTP 422). */
  violations?: SourceViolationDto[];
}

export interface SnapshotRestoreFailure {
  title: string;
  /** One line per rule, plus the closing advice. Never empty. */
  details: string[];
}

/**
 * What the user is told when a restore did not happen.
 *
 * TWO CASES, and collapsing them is the bug this replaces. A source-guard
 * refusal is not a failure of the app: the snapshot predates the guard, or was
 * hand-edited, and it contains something that would run at import time. The
 * user needs the specific rules so they can copy the salvageable parts out by
 * hand — which is exactly what `actions snapshots restore` prints, and what a
 * generic toast threw away.
 *
 * It always states that nothing was changed, because that is the one thing a
 * user needs to know before deciding what to try next, and it is true on both
 * branches: `restoreSnapshot` validates before writing.
 */
export function describeSnapshotRestoreFailure(
  status: number,
  body: SnapshotRestoreErrorDto,
): SnapshotRestoreFailure {
  const violations = body.violations ?? [];
  if (status === 422 && violations.length > 0) {
    return {
      title: "That version cannot be restored — it does not pass the action source guard.",
      details: [
        ...violations.map((violation) => `${violation.rule}: ${violation.detail}`),
        "Nothing was changed. This snapshot predates the guard, or was hand-edited; " +
          "an action file may only contain static data. Copy the parts you need out of it by hand.",
      ],
    };
  }

  return {
    title: body.error || "Failed to restore that version.",
    details: ["Nothing was changed."],
  };
}

/**
 * Label for one entry in the version list.
 *
 * The stored timestamp is the filename's own, with `:` and `.` restored — it is
 * not guaranteed parseable, and a snapshot that has been renamed by hand must
 * still be listed and restorable. So an unparseable stamp is shown verbatim
 * rather than as `Invalid Date`.
 */
export function describeSnapshotAge(timestamp: string, now: Date = new Date()): string {
  const taken = new Date(timestamp).getTime();
  if (Number.isNaN(taken)) return timestamp;

  const minutes = Math.floor((now.getTime() - taken) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
