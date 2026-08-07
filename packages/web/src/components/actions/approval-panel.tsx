"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import {
  useApprovals,
  useApproveOperations,
  useRejectOperations,
  type ApprovalOperation,
} from "@/hooks/use-approvals";
import { useEmailDetail } from "@/hooks/use-email-detail";
import {
  describeApplyOutcome,
  describeRejectOutcome,
} from "@/modules/api/approvals-contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";

function operationBadgeVariant(op: ApprovalOperation): "destructive" | "secondary" {
  return op.destructive ? "destructive" : "secondary";
}

function formatDate(value: string): string {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? value : new Date(time).toLocaleString();
}

function EmailReviewDialog({
  operation,
  onClose,
}: {
  operation: ApprovalOperation | null;
  onClose: () => void;
}) {
  // Shared with MailDisplay: one fetcher, one query key order. Building the key
  // by hand here used to cache the same email a second time under a reversed
  // key, so an invalidation after an apply refreshed only one of the two.
  const { data: email, isLoading, isError } = useEmailDetail(
    operation?.accountId ?? null,
    operation?.emailId ?? null,
  );

  return (
    <Dialog
      open={operation !== null}
      onClose={onClose}
      title={
        operation && (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={operationBadgeVariant(operation)}>
                {operation.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                proposed by “{operation.actionName}”
              </span>
            </div>
            <h2 className="mt-2 truncate text-base font-semibold">
              {email?.subject ?? operation.email?.subject ?? "(no subject)"}
            </h2>
          </div>
        )
      }
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading email…
        </div>
      )}
      {!isLoading && isError && (
        <p className="text-sm text-muted-foreground">
          Couldn’t load this email. Close and try again — don’t approve a change
          you haven’t been able to read.
        </p>
      )}
      {!isLoading && !isError && !email && (
        <p className="text-sm text-muted-foreground">
          This email is not in the local database anymore.
        </p>
      )}
      {email && (
        <div className="space-y-3">
          <div className="space-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">From:</span> {email.from}
            </p>
            <p>
              <span className="text-muted-foreground">To:</span> {email.to}
            </p>
            <p>
              <span className="text-muted-foreground">Date:</span>{" "}
              {formatDate(email.date)}
            </p>
          </div>
          <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
            {email.bodyText || email.snippet}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ApprovalPanel() {
  const { data, isLoading, isError, error } = useApprovals();
  const approve = useApproveOperations();
  const reject = useRejectOperations();
  // Selection is default-DENY: an operation is only actionable once it has been
  // rendered for the user at least once. Tracking deselected ids instead would
  // silently include changes that arrived from a background refetch after the
  // user last looked, widening a bulk approve beyond what they reviewed.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<ApprovalOperation | null>(null);
  // Stable identity: the Dialog's focus effect depends on onClose, so a new
  // arrow each render would re-run it on every background refetch and yank
  // focus out of the email the user is reading.
  const closeReview = useCallback(() => setReviewing(null), []);

  const operations = useMemo(() => data?.operations ?? [], [data]);

  useEffect(() => {
    const ids = operations.map((op) => op.id);
    const idSet = new Set(ids);
    const isFirstLoad = seen.size === 0;
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0 && idSet.size === seen.size) return;

    setSeen(new Set(ids));
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of ids) {
        // The first render of the queue arrives ticked, so the common case is
        // still one click. Anything that shows up LATER — a background refetch
        // after another action run, a window-focus refetch — arrives unticked,
        // so a bulk Apply can never reach a change the user has not looked at.
        if (prev.has(id) || (isFirstLoad && !seen.has(id))) next.add(id);
      }
      return next;
    });
  }, [operations, seen]);

  const batches = useMemo(() => {
    const byBatch = new Map<
      string,
      { actionName: string; createdAt: string; ops: ApprovalOperation[] }
    >();
    for (const op of operations) {
      const batch = byBatch.get(op.batchId);
      if (batch) {
        batch.ops.push(op);
      } else {
        byBatch.set(op.batchId, {
          actionName: op.actionName,
          createdAt: op.createdAt,
          ops: [op],
        });
      }
    }
    return [...byBatch.values()];
  }, [operations]);

  // Never fail silent: the sidebar badge is served by a separate endpoint, so
  // rendering nothing here would tell the user "N changes await approval" while
  // giving them no way to see or act on them.
  if (isError) {
    return (
      <Card className="mb-4 border-destructive/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Couldn’t load pending Gmail changes
          </CardTitle>
          <CardDescription>
            Any queued changes are still queued — nothing has been applied.
            Reload to try again.
            {error?.message ? ` (${error.message})` : ""}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (isLoading || operations.length === 0) return null;

  const selectedIds = operations
    .filter((op) => selected.has(op.id))
    .map((op) => op.id);
  const busy = approve.isPending || reject.isPending;

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleApprove() {
    // Trash and spam are the changes a user cannot casually undo, so confirm
    // the count before writing them — this panel exists to prevent surprise.
    const destructive = operations.filter(
      (op) => selected.has(op.id) && op.destructive,
    );
    if (
      destructive.length > 0 &&
      !window.confirm(
        `Apply ${selectedIds.length} change${selectedIds.length === 1 ? "" : "s"} to Gmail?\n\n` +
          `${destructive.length} of them move mail to Trash or mark it as Spam. ` +
          `Gmail permanently deletes trashed mail after 30 days.`,
      )
    ) {
      return;
    }

    approve.mutate(
      { ids: selectedIds },
      {
        onSuccess: (result) => {
          const { tone, message } = describeApplyOutcome(result);
          toast[tone](message);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleReject(ids: string[], confirmAll = false) {
    if (
      confirmAll &&
      !window.confirm(
        `Reject all ${ids.length} pending change${ids.length === 1 ? "" : "s"}? ` +
          `Nothing is applied to Gmail, and the proposals are discarded.`,
      )
    ) {
      return;
    }

    reject.mutate(
      { ids },
      {
        onSuccess: (result) => {
          const { tone, message } = describeRejectOutcome(result);
          toast[tone](message);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Card className="mb-4 border-warning/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-warning-foreground" />
          <CardTitle className="text-base">
            Pending Gmail changes — approval required
          </CardTitle>
        </div>
        <CardDescription>
          Nothing is applied to Gmail until you approve it. Uncheck anything you
          want to keep, and open a row to read the email first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {batches.map((batch) => (
          <div key={batch.ops[0]!.batchId} className="rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">{batch.actionName}</span>
              <span className="text-xs text-muted-foreground">
                {formatDate(batch.createdAt)}
              </span>
            </div>
            <ul className="divide-y">
              {batch.ops.map((op) => (
                <li
                  key={op.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30"
                >
                  <Checkbox
                    checked={selected.has(op.id)}
                    onCheckedChange={(checked) => toggle(op.id, checked)}
                    aria-label={`Select ${op.label} for ${op.email?.subject ?? op.emailId}`}
                  />
                  <Badge
                    variant={operationBadgeVariant(op)}
                    className="max-w-[12rem] shrink-0 truncate"
                    title={op.label}
                  >
                    {op.label}
                  </Badge>
                  {/* A real button, so reading the email before approving it is
                      reachable by keyboard — not just by mouse. */}
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setReviewing(op)}
                  >
                    <span className="block truncate text-sm">
                      {op.email?.subject ?? `(not in local DB: ${op.emailId})`}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {op.email?.from}
                      {op.accountId && ` — ${op.accountId}`}
                    </span>
                  </button>
                  {op.email && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(op.email.date)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1"
            disabled={busy || selectedIds.length === 0}
            onClick={handleApprove}
          >
            {approve.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Apply selected ({selectedIds.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy || selectedIds.length === 0}
            onClick={() => handleReject(selectedIds)}
          >
            <X className="h-3.5 w-3.5" />
            Reject selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 text-destructive-text hover:text-destructive-text"
            disabled={busy}
            onClick={() => handleReject(operations.map((op) => op.id), true)}
          >
            Reject all
          </Button>
        </div>
      </CardContent>

      <EmailReviewDialog
        operation={reviewing}
        onClose={closeReview}
      />
    </Card>
  );
}
