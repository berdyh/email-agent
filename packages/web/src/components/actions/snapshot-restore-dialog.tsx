"use client";

/**
 * "Previous versions" for a user action.
 *
 * WHY IT EXISTS. `saveUserAction` snapshots the file it is about to overwrite,
 * so every edit-chat save is recoverable — and until now the only way to reach
 * that was `email-agent actions snapshots restore`, in a terminal. The person
 * who has just overwritten an action through the edit chat is looking at this
 * page, not at a shell.
 *
 * DELIBERATELY THIN, AND NOW RENDERED BY A TEST. The list wording
 * (`describeSnapshotAge`), the refusal wording (`describeSnapshotRestoreFailure`)
 * and the request itself live in `modules/api/snapshot-contract.ts` and
 * `hooks/use-action-snapshots.ts`, which are tested; this file picks a layout
 * and calls them. `snapshot-restore-dialog.test.tsx` — the first component test
 * in this repo — covers WHICH of those it picks for the state it is in, and
 * deliberately re-asserts none of their strings. Keep it that way: a copy edit
 * should break one test, not two.
 */

import { useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  useActionSnapshots,
  useRestoreSnapshot,
  SnapshotRestoreError,
} from "@/hooks/use-action-snapshots";
import { describeSnapshotAge } from "@/modules/api/snapshot-contract";

export function SnapshotRestoreDialog({
  filename,
  actionName,
}: {
  filename: string;
  actionName: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: snapshots, isLoading } = useActionSnapshots(filename, open);
  const restore = useRestoreSnapshot();
  const [restoring, setRestoring] = useState<string | null>(null);

  async function handleRestore(snapshotFilename: string) {
    if (
      !window.confirm(
        `Restore this version of "${actionName}"? The current version is snapshotted first, ` +
          `so this is reversible.`,
      )
    ) {
      return;
    }

    setRestoring(snapshotFilename);
    try {
      await restore.mutateAsync({ snapshotFilename, originalFilename: filename });
      toast.success(`Restored "${actionName}" from ${snapshotFilename}`);
      setOpen(false);
    } catch (err) {
      // A source-guard refusal must arrive as the RULES it broke, not as a
      // generic failure — that is the whole reason the 422 branch exists.
      if (err instanceof SnapshotRestoreError) {
        toast.error(err.failure.title, {
          description: err.failure.details.join("\n"),
          duration: 15000,
        });
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to restore that version");
      }
    } finally {
      setRestoring(null);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-1"
        onClick={() => setOpen(true)}
        title="Restore a previous version of this action"
      >
        <History className="h-3 w-3" />
        Versions
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Previous versions of "${actionName}"`}
      >
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading previous versions...
          </div>
        )}

        {!isLoading && (snapshots?.length ?? 0) === 0 && (
          <p className="text-sm text-muted-foreground">
            No previous versions. One is saved automatically every time this action is
            overwritten by the edit chat.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {snapshots?.map((snapshot) => (
            <li
              key={snapshot.filename}
              className="flex items-center justify-between gap-3 rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="text-sm">{describeSnapshotAge(snapshot.timestamp)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {snapshot.filename}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1 shrink-0"
                disabled={restoring !== null}
                onClick={() => void handleRestore(snapshot.filename)}
              >
                {restoring === snapshot.filename ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Restore
              </Button>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-muted-foreground">
          Restoring snapshots the current version first, so it can be restored back.
        </p>
      </Dialog>
    </>
  );
}
