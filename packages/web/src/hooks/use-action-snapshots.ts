import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import {
  describeSnapshotRestoreFailure,
  type SnapshotEntryDto,
  type SnapshotRestoreErrorDto,
  type SnapshotRestoreFailure,
} from "@/modules/api/snapshot-contract";

/**
 * A restore that the server refused, carrying the wording the user sees.
 *
 * Thrown rather than returned so TanStack's `onError` path handles it, and
 * carrying a pre-composed `failure` so no component has to re-derive what to
 * say — see `snapshot-contract.ts` for why the wording lives out here.
 */
export class SnapshotRestoreError extends Error {
  constructor(readonly failure: SnapshotRestoreFailure) {
    super(failure.title);
    this.name = "SnapshotRestoreError";
  }
}

export function actionSnapshotsKey(filename: string): [string, string] {
  return ["action-snapshots", filename];
}

/**
 * Snapshots for one action file, newest first (core sorts them).
 *
 * `enabled` so a card that has not been expanded does not fetch: the list is
 * per-action and the actions page renders every action at once.
 */
export function useActionSnapshots(filename: string | undefined, enabled: boolean) {
  return useQuery<SnapshotEntryDto[]>({
    queryKey: actionSnapshotsKey(filename ?? ""),
    enabled: enabled && Boolean(filename),
    queryFn: async () => {
      const res = await apiFetch(
        `/api/actions/user/snapshots?filename=${encodeURIComponent(filename ?? "")}`,
      );
      if (!res.ok) throw new Error("Failed to load previous versions");
      return (await res.json()) as SnapshotEntryDto[];
    },
  });
}

export function useRestoreSnapshot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: { snapshotFilename: string; originalFilename: string }) => {
      const res = await apiFetch("/api/actions/user/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as SnapshotRestoreErrorDto;
        // A 422 carries the rules the snapshot broke. Collapsing it into a
        // generic failure is what left a user with an unrecoverable action and
        // no idea why, while the CLI printed the rules.
        throw new SnapshotRestoreError(describeSnapshotRestoreFailure(res.status, body));
      }
      return (await res.json()) as { success: true };
    },
    onSuccess: (_data, vars) => {
      // Restoring writes a snapshot of what it replaced, so the list itself
      // changes; the action list changes too, since the restored file may
      // present a different name or description.
      void queryClient.invalidateQueries({
        queryKey: actionSnapshotsKey(vars.originalFilename),
      });
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}
